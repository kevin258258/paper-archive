import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz
import library as lib
import harness
import importer
import agent_import_tools as tools
import settings


class AgentImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.patches = [patch.object(lib, 'ROOT', self.root), patch.object(lib, 'STATE', self.state),
                        patch.object(harness, 'SESSIONS', {})]
        for p in self.patches:
            p.start()
        lib.init_db()
        self.arxiv = '2501.12345'
        self.folder = self.root / '90-待整理' / self.arxiv
        source = self.folder / 'tex_source'
        source.mkdir(parents=True)
        (source / 'main.tex').write_text('\\documentclass{article}\n\\begin{document}\nThe original text uses $x=1$.\n\\end{document}')
        (self.folder / 'metadata.json').write_text(json.dumps({'arxiv_id': self.arxiv, 'title': 'Example', 'authors': ['A'], 'published': '2025-01-01', 'abstract': 'Example'}))
        with fitz.open() as pdf:
            for n in range(5):
                pdf.new_page().insert_text((50, 50), 'Original evidence ' + str(n+1))
            pdf.save(self.folder / 'original.pdf')
        tools.prepare(self.arxiv)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_formula_prose_reordering_is_not_corruption_but_actual_math_changes_are(self):
        original = r'The score $x+y$ uses the matrix $R$.'
        translated = r'对于矩阵 $R$，分数为 $x+y$。'
        self.assertEqual(importer.invariant(original), importer.invariant(translated))
        self.assertNotEqual(importer.invariant(original), importer.invariant(translated.replace('$x+y$', '$x-y$')))

    def test_native_session_has_explicit_skill_model_and_medium_effort(self):
        import test_harness
        rpc = test_harness.FakeRPC()
        session = harness.create_import(self.arxiv, 'job-1')
        caps = {'default_model': 'other-model', 'default_effort': 'xhigh', 'models': [{
            'model': 'gpt-6.1-sol', 'isDefault': False, 'defaultReasoningEffort': 'low',
            'supportedReasoningEfforts': [{'reasoningEffort': 'medium'}]}]}
        with patch.object(harness, 'connect', return_value=rpc), patch.object(harness, 'capabilities', return_value=caps), patch('threading.Thread.start'):
            harness.start(session['id'], {'question': '$arxiv-translate https://arxiv.org/abs/' + self.arxiv})
            harness._start(session['id'])
        start = next(params for method, params in rpc.calls if method == 'thread/start')
        turn = next(params for method, params in rpc.calls if method == 'turn/start')
        self.assertEqual(start['sandbox'], 'workspace-write')
        self.assertTrue(any(t['name'] == 'archive_finish_import' for t in start['dynamicTools']))
        self.assertEqual((turn['model'], turn['effort']), ('gpt-6.1-sol', 'medium'))
        self.assertEqual(turn['input'][1]['type'], 'skill')
        self.assertTrue(turn['input'][1]['path'].endswith('arxiv-translate/SKILL.md'))
        self.assertNotIn('outputSchema', turn)

    def ready_translation(self):
        (self.folder / 'tex_cn/main.tex').write_text('中文译文内容。' * 20 + '$x=1$')
        chinese = self.folder / '中文版.pdf'
        with fitz.open() as pdf:
            for _ in range(5):
                pdf.new_page().insert_text((50, 50), '中文测试内容', fontname='china-s')
            pdf.save(chinese)
        value = tools.audit(self.arxiv)
        value.update(compiled=True, chinese_sha=tools.digest(chinese), chinese=str(chinese))
        tools.save(self.arxiv, value)
        for _, name in lib.NOTE_NAMES.values():
            (self.folder / name).write_text('测试研究笔记与原文页码依据。' * 15)
        return {'chinese_title': '示例', 'domain_id': 'unfiled', 'reason': 'Evidence',
                'translation_review': 'Checked full source', 'visual_review': 'Checked actual PDF images'}

    def test_completion_requires_actual_original_page_reads_and_current_pdf_images(self):
        data = self.ready_translation()
        with self.assertRaisesRegex(ValueError, '全部页面'):
            tools.finish(self.arxiv, data)
        tools.read_pdf(self.arxiv, {'start_page': 1, 'end_page': 5})
        with self.assertRaisesRegex(ValueError, '首页'):
            tools.finish(self.arxiv, data)
        for page in [1, 2, 5]:
            image = tools.read_pdf(self.arxiv, {'language': 'chinese', 'page': page}, image=True)
            self.assertEqual(image['contentItems'][1]['type'], 'inputImage')
        result = tools.finish(self.arxiv, data)
        self.assertTrue(result['paper_id'])
        self.assertTrue(tools.audit(self.arxiv)['completed'])
        self.assertFalse(self.folder.exists())

    def test_original_sources_are_immutable(self):
        (self.folder / 'tex_source/main.tex').write_text('modified')
        with self.assertRaisesRegex(ValueError, '原始源码'):
            tools.prepare(self.arxiv)

    def test_math_damage_blocks_finalization(self):
        data = self.ready_translation()
        (self.folder / 'tex_cn/main.tex').write_text('中文内容。' * 20 + '$x=2$')
        with self.assertRaisesRegex(ValueError, '公式内容'):
            tools.finish(self.arxiv, data)

    def test_native_import_resumes_its_previous_session(self):
        first = harness.create_import(self.arxiv, 'job-1')
        again = harness.create_import(self.arxiv, 'job-2')
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(again['job_id'], 'job-2')

    def test_settings_reject_invalid_import_skill(self):
        with self.assertRaises(ValueError):
            settings.save({'import_skill': 'relative/SKILL.md'})
