from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import jobs
import library as lib


class BatchImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = patch.object(lib, 'STATE', Path(self.temp.name))
        self.state.start()
        lib.init_db()

    def tearDown(self):
        self.state.stop()
        self.temp.cleanup()

    def test_mixed_pasted_links_markdown_old_ids_and_versions(self):
        raw = ('- [paper](https://arxiv.org/pdf/2406.02469v2.pdf?x=1)\n'
               '1. https://arxiv.org/abs/2406.02469\n'
               'arXiv: 2501.12345，<https://arxiv.org/html/2502.12345v1>; '
               'arxiv.org/abs/hep-th/9901001')
        self.assertEqual(lib.parse_arxiv_many(raw),
                         ['2406.02469v2', '2501.12345', '2502.12345v1', 'hep-th/9901001'])

    def test_invalid_later_item_submits_nothing(self):
        for raw in ['2406.02469\nhttps://arxiv.org.evil.test/abs/2501.12345',
                    '2406.02469; touch /tmp/oops', '收集近几年 Anthropic 的可解释性文章']:
            with self.assertRaises(ValueError):
                jobs.create_many(raw)
        self.assertEqual(jobs.recent(), [])
        with self.assertRaisesRegex(ValueError, '50'):
            lib.parse_arxiv_many('\n'.join(f'2501.{n:05d}' for n in range(51)))

    def test_repeated_batches_reuse_pending_jobs_without_resubmission(self):
        with patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            first = jobs.create_many('2406.02469\n2501.12345\n2406.02469v2')
            again = jobs.create_many('https://arxiv.org/pdf/2406.02469.pdf,2501.12345')
        self.assertEqual(first['count'], 2)
        self.assertEqual([j['id'] for j in first['jobs']], [j['id'] for j in again['jobs']])
        self.assertEqual(submit.call_count, 2)

    def test_all_active_jobs_remain_visible_beyond_recent_history_limit(self):
        batch = jobs.create_many('\n'.join(f'2501.{n:05d}' for n in range(50)), submit=False)
        self.assertEqual(len(jobs.recent()), 50)
        for job in batch['jobs']:
            jobs.cancel(job['id'])
        self.assertEqual(len(jobs.recent()), 30)

    def test_serial_imports_keep_search_free_and_continue_after_failure(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        calls = []

        def import_paper(uid, arxiv):
            calls.append(arxiv)
            if arxiv == '2501.10001':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('test did not release import')
                raise RuntimeError('one broken source package')
            finished.set()
            return {'paper_id': 'synthetic'}

        with ThreadPoolExecutor(max_workers=1) as imports, ThreadPoolExecutor(max_workers=1) as search:
            with patch.object(jobs, 'IMPORT_POOL', imports), patch.object(jobs, 'POOL', search), \
                 patch.object(jobs, 'import_paper', side_effect=import_paper), \
                 patch.object(jobs, 'semantic_search', return_value={'results': []}):
                batch = jobs.create_many('2501.10001\n2501.10002')
                try:
                    self.assertTrue(entered.wait(5))
                    self.assertEqual(jobs.get(batch['jobs'][1]['id'])['status'], 'queued')
                    lookup = jobs.create('search', 'a live search')
                    search.submit(lambda: None).result(timeout=5)
                    self.assertEqual(jobs.get(lookup['id'])['status'], 'completed')
                finally:
                    release.set()
                self.assertTrue(finished.wait(5))
                imports.submit(lambda: None).result(timeout=5)
        self.assertEqual(calls, ['2501.10001', '2501.10002'])
        self.assertEqual([jobs.get(j['id'])['status'] for j in batch['jobs']], ['failed', 'completed'])

    def test_real_import_dispatch_runs_distinct_sources_concurrently(self):
        import blog_import
        entered, release = threading.Barrier(26), threading.Event()
        def work(*args):
            entered.wait(timeout=3)
            release.wait(timeout=4)
            return {'paper_id': 'synthetic'}
        with patch.object(blog_import, 'run', side_effect=work), patch.object(jobs, 'existing_result', return_value=None), patch('agent_import.run', side_effect=work), patch('settings.read', return_value={'import_mode':'codex'}), patch.object(lib, 'refresh'), patch.object(lib, 'find_arxiv', return_value=None):
            batch=[jobs.create('blog', 'https://research.example.org/'+str(i)) for i in range(24)]
            batch.append(jobs.create('import', '2501.10009'))
            try:
                entered.wait(timeout=3)
                self.assertEqual([jobs.get(j['id'])['status'] for j in batch], ['running']*25)
            finally:
                release.set()
                # Both must leave their workers before the temporary database closes.
                import time
                deadline=time.monotonic()+5
                while time.monotonic()<deadline and any(jobs.get(j['id'])['status'] in ('queued','running') for j in batch): time.sleep(.01)

    def test_archived_papers_open_without_waiting_for_import_queue(self):
        result = {'paper_id': 'existing', 'duplicate': True, 'message': '已在库中，直接打开'}
        with patch.object(jobs, 'existing_result', return_value=result), \
             patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            batch = jobs.create_many('2406.02469')
        self.assertEqual(batch['jobs'][0]['status'], 'completed')
        self.assertEqual(batch['jobs'][0]['result'], result)
        submit.assert_not_called()
