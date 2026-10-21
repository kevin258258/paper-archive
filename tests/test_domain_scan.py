import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz
import domain_scan as scan
import jobs
import library as lib
import taxonomy


class DomainScanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.patches = [patch.object(lib, 'ROOT', self.root), patch.object(lib, 'STATE', self.state)]
        for p in self.patches:
            p.start()
        lib.init_db()
        self.quote = 'We analyze neural features through causal interventions.'
        for ident in ['a', 'b']:
            file = self.root / (ident + '.pdf')
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40, 40), self.quote)
                pdf.save(file)
            record = dict(id=ident, title=ident, english=ident, arxiv='', abstract='Research',
                          domain='unfiled', domainName='未分类', notes=[
                              {'key': 'method', 'text': 'Agent method'},
                              {'key': 'insight', 'text': 'Agent insight'},
                              {'key': 'human', 'text': 'PRIVATE HUMAN DRAFT'}])
            with lib.db() as c:
                c.execute('INSERT INTO papers VALUES(?,?,?,?,?)',
                          (ident, json.dumps(record), json.dumps({'original': str(file)}), '', 'fp-' + ident))
        self.domain = taxonomy.save({'name': '可解释性', 'description': '内部特征与因果机制'})['domains'][-1]

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def begin(self):
        return scan.start([self.domain['id']], submit=False)['id']

    def decision(self, paper='a', matches=True, confidence=.95):
        return dict(paper_id=paper, domain_id=self.domain['id'], matches=matches,
                    confidence=confidence, reason='研究内部机制' if matches else '核心问题不属于此领域',
                    language='original', page=1 if matches else 0, quote=self.quote if matches else '')

    def complete(self, uid):
        scan.record(uid, [self.decision(), self.decision('b', False)])
        return scan.finish(uid)

    def test_complete_coverage_and_literal_evidence_required(self):
        uid = self.begin()
        with self.assertRaisesRegex(ValueError, '未检查'):
            scan.finish(uid)
        for bad in [{**self.decision(), 'quote': 'Invented evidence not in the PDF'},
                    {**self.decision(), 'page': 2}]:
            with self.assertRaisesRegex(ValueError, '引用'):
                scan.record(uid, [bad])
        self.assertEqual(scan.read(uid)['decisions'], {})
        result = self.complete(uid)
        self.assertEqual(result['checked'], 2)
        self.assertEqual(result['counts'][self.domain['id']]['matched'], 1)

    def test_multiple_memberships_preserve_manual_primary_and_files(self):
        primary = taxonomy.save({'name': '预训练'})['domains'][-1]
        taxonomy.assign('a', primary['id'])
        original = (self.root / 'a.pdf').read_bytes()
        uid = self.begin()
        self.complete(uid)
        record = lib.paper('a')['record']
        self.assertEqual(record['domain'], primary['id'])
        self.assertIn(self.domain['id'], record['domainIds'])
        self.assertEqual((self.root / 'a.pdf').read_bytes(), original)
        self.assertEqual(taxonomy.read()['assignments']['a'], primary['id'])

    def test_uncertain_matches_stay_suggestions_until_manually_included(self):
        uid = self.begin()
        scan.record(uid, [self.decision(confidence=.65), self.decision('b', False)])
        result = scan.finish(uid)
        self.assertEqual(result['counts'][self.domain['id']]['suggested'], 1)
        self.assertNotIn(self.domain['id'], lib.paper('a')['record']['domainIds'])
        taxonomy.include('a', self.domain['id'])
        self.assertIn(self.domain['id'], lib.paper('a')['record']['domainIds'])
        self.assertNotIn('a', taxonomy.read()['assignments'])

    def test_manual_exclusion_survives_future_positive_rescans(self):
        uid = self.begin()
        self.complete(uid)
        taxonomy.exclude('a', self.domain['id'])
        scan.finish(uid)
        self.assertNotIn(self.domain['id'], lib.paper('a')['record']['domainIds'])
        taxonomy.include('a', self.domain['id'])
        self.assertIn(self.domain['id'], lib.paper('a')['record']['domainIds'])

    def test_changed_domain_or_paper_blocks_stale_commit(self):
        uid = self.begin()
        scan.record(uid, [self.decision(), self.decision('b', False)])
        taxonomy.save({**self.domain, 'description': '新的研究范围'})
        with self.assertRaisesRegex(ValueError, '范围已改变'):
            scan.finish(uid)
        taxonomy.save(self.domain)
        with lib.db() as c:
            c.execute("UPDATE papers SET fingerprint='changed' WHERE id='a'")
        with self.assertRaisesRegex(ValueError, '内容已改变'):
            scan.finish(uid)

    def test_retry_reuses_verified_decisions_and_same_native_session(self):
        uid = self.begin()
        scan.record(uid, [self.decision()])
        data = scan.read(uid)
        data['session_id'] = 'persisted-session'
        scan.write(uid, data)
        jobs.update(uid, status='failed')
        again = scan.start([self.domain['id']], submit=False, previous=uid)
        restored = scan.read(again['id'])
        self.assertEqual(restored['decisions'], data['decisions'])
        self.assertEqual(restored['session_id'], 'persisted-session')

    def test_creation_and_scope_changes_schedule_but_rename_only_save_can_opt_out(self):
        with patch.object(scan.POOL, 'submit') as submit:
            result = scan.save_domain({'name': '预训练', 'description': '基础模型训练'})
            self.assertTrue(result['scan_job'])
            same = scan.save_domain({**self.domain, 'scan_existing': True})
            self.assertIsNone(same['scan_job'])
            result = scan.save_domain({'name': '评测', 'scan_existing': False})
            self.assertIsNone(result['scan_job'])
            self.assertEqual(submit.call_count, 1)

    def test_notes_tool_excludes_human_notes_and_outside_scope(self):
        uid = self.begin()
        output = scan.execute({'scan_id': uid}, 'archive_domain_notes', {'paper_id': 'a'})
        self.assertNotIn('PRIVATE HUMAN DRAFT', json.dumps(output))
        with self.assertRaises(ValueError):
            scan.execute({'scan_id': uid}, 'archive_domain_notes', {'paper_id': 'outside'})

    def test_invalid_manual_memberships_are_atomic(self):
        with self.assertRaises(ValueError):
            taxonomy.assign('a', self.domain['id'], ['not-a-domain'])
        self.assertNotIn('a', taxonomy.read()['assignments'])

    def test_removing_manual_membership_also_survives_future_auto_match(self):
        taxonomy.include('a', self.domain['id'])
        taxonomy.assign('a', 'unfiled', [])
        self.complete(self.begin())
        self.assertNotIn(self.domain['id'], lib.paper('a')['record']['domainIds'])
