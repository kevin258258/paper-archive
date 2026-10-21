import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import collections_store as collections
import library as lib
import taxonomy
import waiting_list as waiting


class WaitingListTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.patches = [patch.object(lib, 'ROOT', self.root), patch.object(lib, 'STATE', self.state)]
        for p in self.patches:
            p.start()
        lib.init_db()
        for uid in ['a', 'b', 'c']:
            record = {'id': uid, 'title': uid, 'domain': 'unfiled', 'domainName': '未分类', 'human': '未读'}
            with lib.db() as c:
                c.execute('INSERT INTO papers VALUES(?,?,?,?,?)', (uid, json.dumps(record), '{}', '', uid))
        self.collection = collections.save({'name': '待读'})

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_legacy_favorites_migrate_once_and_respect_completed_reading(self):
        with lib.db() as c:
            c.executemany('INSERT INTO collection_items VALUES(?,?)', [(self.collection['id'], p) for p in ['a', 'b']])
            c.execute("DELETE FROM app_meta WHERE key='reading_queue_migrated'")
        lib.save_reading('b', {'status': '已读'})
        lib.save_reading('c', {'marked': True})
        with lib.db() as c:
            c.execute("DELETE FROM app_meta WHERE key='collections_migrated'")
        collections.initialize()
        waiting.initialize()
        self.assertEqual({r['paper_id'] for r in waiting.listing()}, {'a', 'c'})
        waiting.change('a', {'action': 'remove'})
        waiting.initialize()
        self.assertEqual([r['paper_id'] for r in waiting.listing()], ['c'])
        self.assertIn('a', collections.listing()[0]['papers'])

    def test_canceled_legacy_bookmarks_do_not_resurface_during_queue_upgrade(self):
        lib.save_reading('a', {'marked': True})
        collections.assign('a', [self.collection['id']])
        collections.assign('a', [])
        waiting.change('a', {'action': 'remove'})
        with lib.db() as c:
            c.execute("DELETE FROM app_meta WHERE key='reading_queue_migrated'")
        waiting.initialize()
        self.assertEqual(waiting.listing(), [])

    def test_collection_changes_and_queue_removal_are_independent(self):
        collections.assign('a', [self.collection['id']])
        self.assertEqual(waiting.listing()[0]['paper_id'], 'a')
        collections.assign('a', [])
        self.assertEqual(waiting.listing()[0]['paper_id'], 'a')
        collections.assign('a', [self.collection['id']])
        waiting.change('a', {'action': 'remove'})
        self.assertIn('a', collections.listing()[0]['papers'])
        self.assertEqual(waiting.listing(), [])

    def test_done_atomically_removes_queue_preserving_notes_positions_and_collections(self):
        notes = {'draft': 'Keep this private note', 'positions': {'original': {'page': 8}},
                 'highlights': [{'id': 'abc', 'language': 'original', 'page': 3, 'text': 'quote', 'comment': 'Keep comment', 'rects': []}]}
        lib.save_reading('a', notes)
        collections.assign('a', [self.collection['id']])
        lib.save_reading('a', {'status': '已读'})
        self.assertEqual(waiting.listing(), [])
        reading = lib.all_reading()['a']
        for key in notes:
            self.assertEqual(reading[key], notes[key])
        self.assertIn('a', collections.listing()[0]['papers'])
        lib.save_reading('a', {'positions': {'original': {'page': 9}}})
        self.assertEqual(lib.all_reading()['a']['status'], '已读')

    def test_completed_favorites_are_not_requeued_but_explicit_reread_is_supported(self):
        lib.save_reading('a', {'status': '已读', 'draft': 'Keep'})
        collections.assign('a', [self.collection['id']])
        self.assertEqual(waiting.listing(), [])
        waiting.change('a', {'action': 'add'})
        self.assertEqual(lib.all_reading()['a']['status'], '未读')
        self.assertEqual(lib.all_reading()['a']['draft'], 'Keep')
        self.assertEqual(waiting.listing()[0]['paper_id'], 'a')

    def test_pin_oldest_first_order_is_persistent_and_add_is_idempotent(self):
        with patch.object(waiting.time, 'time', return_value=10):
            waiting.change('a', {'action': 'add'})
        with patch.object(waiting.time, 'time', return_value=20):
            waiting.change('b', {'action': 'add'})
        waiting.change('b', {'action': 'pin'})
        waiting.change('a', {'action': 'add'})
        waiting.initialize()
        self.assertEqual([r['paper_id'] for r in waiting.listing()], ['b', 'a'])
        self.assertEqual(waiting.listing()[1]['added'], 10)
        waiting.change('b', {'action': 'unpin'})
        self.assertEqual([r['paper_id'] for r in waiting.listing()], ['a', 'b'])

    def test_queue_temporarily_absent_from_index_is_retained(self):
        waiting.change('a', {'action': 'add'})
        with lib.db() as c:
            row = c.execute("SELECT * FROM papers WHERE id='a'").fetchone()
            c.execute("DELETE FROM papers WHERE id='a'")
        self.assertEqual(waiting.listing(), [])
        with lib.db() as c:
            c.execute('INSERT INTO papers VALUES(?,?,?,?,?)', tuple(row))
        self.assertEqual(waiting.listing()[0]['paper_id'], 'a')

    def test_invalid_reading_status_does_not_replace_existing_data(self):
        lib.save_reading('a', {'draft': 'Keep', 'status': '在读'})
        with self.assertRaises(ValueError):
            lib.save_reading('a', {'status': 'anything', 'draft': 'lost'})
        self.assertEqual(lib.all_reading()['a'], {'draft': 'Keep', 'status': '在读'})

    def test_removing_primary_domain_uses_unfiled_and_keeps_other_memberships(self):
        first = taxonomy.save({'name': '预训练'})['domains'][-1]
        other = taxonomy.save({'name': '可解释性'})['domains'][-1]
        taxonomy.assign('a', first['id'])
        taxonomy.include('a', other['id'])
        before = lib.paper('a')['files']
        taxonomy.exclude('a', first['id'])
        record = lib.paper('a')['record']
        self.assertEqual(record['domain'], 'unfiled')
        self.assertNotIn(first['id'], record['domainIds'])
        self.assertIn(other['id'], record['domainIds'])
        self.assertEqual(lib.paper('a')['files'], before)
        self.assertIn('a', taxonomy.read()['exclusions'][first['id']])
