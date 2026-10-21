import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import harness
import intake
import jobs
import library as lib
import settings
from test_harness import FakeRPC

RAW = ('  1. A Mathematical Framework for Transformer Circuits (2021)\n\n'
       'https://transformer-\ncircuits.pub/2021/framework/index.html\n\n'
       '2. In-context Learning and Induction Heads (2022)\n'
       'https://transformer-circuits.pub/2022/in-context-learning-and-induction-heads/index.html\n'
       '请收录原文和中文翻译，按现有领域分类。\n  ')


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.patches = [patch.object(lib, 'STATE', root/'state'), patch.object(lib, 'ROOT', root/'vault'),
                        patch.object(harness, 'SESSIONS', {}), patch.object(harness, 'LOADED', set()),
                        patch.object(harness, 'PENDING', {}), patch.object(jobs, 'CANCELLED', set())]
        (root/'state').mkdir();(root/'vault').mkdir()
        for p in self.patches: p.start()
        lib.init_db()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def test_numbered_titles_years_commentary_and_wrapped_links_are_accepted_verbatim(self):
        with patch.object(jobs.POOL, 'submit') as submit, patch.object(lib, 'parse_sources', side_effect=AssertionError('Raw prompt must not be parsed')):
            response = intake.submit(RAW)
            again = intake.submit(RAW)
        job = response['jobs'][0]
        self.assertEqual(response['mode'], 'prompt')
        self.assertEqual(job['query'], RAW)
        self.assertEqual(job['id'], again['jobs'][0]['id'])
        self.assertEqual(submit.call_count, 1)
        self.assertEqual(jobs.get(job['id'])['query'], RAW)

    def test_original_user_text_reaches_native_codex_unchanged_with_selected_model(self):
        job = intake.submit(RAW, submit=False)['jobs'][0]
        s = intake.create_session(job['id'])
        rpc = FakeRPC()
        caps = {'default_model':'gpt-6.1-sol','default_effort':'medium','models':[{
            'model':'gpt-6.1-sol','defaultReasoningEffort':'medium',
            'supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}]}
        with patch.object(harness, 'connect', return_value=rpc), patch.object(harness, 'capabilities', return_value=caps), patch('threading.Thread.start'):
            harness.start(s['id'], {'question': RAW})
            harness._start(s['id'])
        turn = next(p for m,p in rpc.calls if m=='turn/start')
        self.assertEqual(turn['input'][0], {'type':'text','text':RAW})
        self.assertEqual(turn['model'], 'gpt-6.1-sol')
        self.assertEqual(turn['effort'], 'medium')
        self.assertEqual(turn['input'][1]['name'], 'collect-sources')
        self.assertNotIn('outputSchema', turn)
        self.assertEqual(harness.snapshot(s['id'])['turns'][0]['question'], RAW)
        native = next(p for m,p in rpc.calls if m=='thread/start')
        self.assertIn('archive_submit_sources', [t['name'] for t in native['dynamicTools']])

    def test_topic_request_needs_no_url_before_submission_and_input_limit_is_clear(self):
        raw = '收集近几年 Anthropic 的可解释性文章，优先机制解释，排除纯产品介绍。'
        job = intake.submit(raw, submit=False)['jobs'][0]
        self.assertEqual(job['query'], raw)
        long = '研究清单\n' + '论文标题及说明。'*500
        self.assertEqual(intake.submit(long, submit=False)['jobs'][0]['query'], long)
        for invalid in ['', '  ', None, 'a'*100001]:
            with self.assertRaises(ValueError): intake.submit(invalid, submit=False)

    def test_resolved_sources_deduplicate_and_invalid_network_targets_submit_nothing(self):
        job = intake.submit(RAW, submit=False)['jobs'][0]
        uid = job['id']
        with patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            receipt = intake.schedule(uid, ['2406.02469', 'https://arxiv.org/abs/2406.02469v2', 'https://research.example.org/post'])
            repeat = intake.schedule(uid, ['2406.02469v2','https://research.example.org/post?utm_source=test'])
        self.assertEqual(receipt['count'], 2)
        self.assertEqual(repeat['count'], 2)
        self.assertEqual(submit.call_count, 2)
        before = len(jobs.recent())
        for invalid in ['http://127.0.0.1:8767/', 'file:///etc/passwd']:
            with self.assertRaises(ValueError): intake.schedule(uid, ['2501.12345', invalid])
        self.assertEqual(len(jobs.recent()), before)
        finished = intake.finish(uid, {'message':'两个来源已交给翻译任务。','unresolved':[]})
        self.assertTrue(finished['planned'])
        self.assertIn('已安排 2 项入库', finished['message'])
        self.assertEqual(jobs.get(uid)['query'], RAW)

    def test_retry_restores_same_conversation_original_and_partial_scheduling(self):
        uid = intake.submit(RAW, submit=False)['jobs'][0]['id']
        s = intake.create_session(uid)
        with patch.object(jobs.IMPORT_POOL,'submit'): intake.schedule(uid, ['2406.02469'])
        jobs.update(uid, status='failed', error='interrupted network')
        with patch.object(jobs.POOL,'submit'):
            retried = jobs.retry(uid)
        resumed = intake.create_session(uid)
        self.assertEqual(retried['id'], uid)
        self.assertEqual(resumed['id'], s['id'])
        self.assertEqual(retried['query'], RAW)
        self.assertEqual(len(retried['result']['children']), 1)

    def test_unresolved_title_is_reported_without_fabricating_a_source(self):
        uid = intake.submit('收集一个无法确认的论文标题', submit=False)['jobs'][0]['id']
        with self.assertRaises(ValueError): intake.finish(uid, {'message':'完成','unresolved':[]})
        done = intake.finish(uid, {'message':'需要作者或原始链接。','unresolved':['标题无法唯一确认']})
        self.assertEqual(done['unresolved'], ['标题无法唯一确认'])
        self.assertNotIn('children', done)
        self.assertIn('未安排入库', done['message'])

    def test_intake_cancel_keeps_original_and_source_tasks_independent(self):
        uid = intake.submit(RAW, submit=False)['jobs'][0]['id']
        with patch.object(jobs.IMPORT_POOL,'submit'): intake.schedule(uid,['2406.02469'])
        child = intake.result(uid)['children'][0]['job_id']
        jobs.cancel(uid)
        self.assertEqual(jobs.get(uid)['query'], RAW)
        self.assertEqual(jobs.get(child)['status'], 'queued')
        with self.assertRaises(InterruptedError): intake.schedule(uid,['2501.12345'])

    def test_api_mode_can_understand_free_form_list_without_regex_at_the_input(self):
        uid = intake.submit(RAW, submit=False)['jobs'][0]['id']
        config = {**settings.DEFAULT,'provider':'api'}
        answer = json.dumps({'sources':['2406.02469'],'unresolved':['另一标题未核实']})
        with patch.object(settings,'read',return_value=config), patch.object(jobs,'execute',return_value=answer) as execute, patch.object(jobs.IMPORT_POOL,'submit'):
            done = intake.run(uid)
        self.assertIn(RAW, execute.call_args.args[1])
        self.assertEqual(len(done['children']), 1)
        self.assertEqual(done['unresolved'], ['另一标题未核实'])
