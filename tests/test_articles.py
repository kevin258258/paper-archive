import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

import articles
import blog_import
import collections_store
import conversation
import domain_scan
import harness
import jobs
import library as lib
import paper_tools
import taxonomy
import waiting_list
from web_sources import normalize_url, public_address

URL = 'https://research.example.org/posts/features?utm_source=test'
HTML = '''<html><head><meta property="og:title" content="Understanding features"><meta name="author" content="Example Lab"><meta property="article:published_time" content="2025-02-01"></head><body><nav>BAD NAVIGATION</nav><article><h1>Understanding features</h1><p>We study interpretable features and sparse representations in neural networks. The full research evidence explains how features are identified and verified with controlled interventions.</p><h2>Method</h2><p>Our objective is <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">L = x^2</annotation></semantics></math></span><span class="katex-html">DUPLICATE MATH</span></span>.</p><pre><code>def feature(x):\n    return x * 2</code></pre><figure><img src="/figures/features.png" alt="Feature plot"><figcaption>The feature comparison.</figcaption></figure><p>Read the <a href="https://arxiv.org/abs/2406.02469">related paper</a> and <a href="/about">lab page</a>.</p><script>EVIL SCRIPT</script></article><footer>BAD FOOTER</footer></body></html>'''
PNG = __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=')


class ArticleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patchers = [patch.object(lib, 'ROOT', self.root/'vault'), patch.object(lib, 'STATE', self.root/'state')]
        (self.root/'state').mkdir()
        for p in self.patchers: p.start()
        lib.init_db()
        self.domain = taxonomy.save({'name': '可解释性', 'description': '内部特征和机制'})['domains'][-1]
        self.download = patch.object(articles, 'fetch', side_effect=lambda url, limit=0: (PNG, 'image/png', url) if url.endswith('.png') else (HTML.encode(), 'text/html', normalize_url(url)))
        self.download.start()

    def tearDown(self):
        self.download.stop()
        for p in reversed(self.patchers): p.stop()
        self.temp.cleanup()

    def translate(self):
        value, folder = articles.prepare(URL)
        articles.read_import(URL, 1, len(value['blocks']))
        for block in value['blocks']:
            # Synthetic translator preserves every protected span.
            articles.set_translation(URL, block['index'], block['original']+' 中文译文。')
        articles.review_translation(URL, 1, len(value['blocks']))
        articles.review_translation(URL, 1, len(value['blocks']), True)
        return value, folder

    def archive(self):
        self.translate()
        return articles.finish(URL, {'chinese_title': '理解特征', 'domain_id': self.domain['id'], 'reason': '全文讨论内部特征'})

    def test_extract_original_figures_math_code_links_and_remove_site_chrome(self):
        value, folder = articles.prepare(URL)
        full = '\n'.join(b['original'] for b in value['blocks'])
        for wanted in ('L = x^2', 'def feature(x):', 'https://research.example.org/about', '/article-asset/', '2406.02469'):
            self.assertIn(wanted, full)
        for removed in ('BAD NAVIGATION', 'BAD FOOTER', 'EVIL SCRIPT', 'DUPLICATE MATH'):
            self.assertNotIn(removed, full)
        self.assertEqual(value['authors'], ['Example Lab'])
        self.assertTrue((folder/'source.html').exists())
        self.assertEqual(len(list((folder/'images').glob('*.png'))), 1)
        self.assertEqual(value['related_arxiv'], ['2406.02469'])

    def test_distill_embedded_figures_and_equations_survive_markdown(self):
        import base64
        html = '<article><h1>Research</h1><p>' + 'Full scientific evidence and qualifications. ' * 6 + '</p><p>We minimize <d-math>L = \\frac{x_1^2}{2}</d-math>.</p><d-math block>W_Q^TW_K</d-math><figure><img alt="Plot" src="data:image/PNG;base64,'+base64.b64encode(PNG).decode()+'"/><figcaption>Full caption.</figcaption></figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg></article>'
        with patch.object(articles, 'fetch', return_value=(html.encode(), 'text/html', normalize_url(URL))):
            value, folder = articles.prepare(URL)
        full = '\n'.join(b['original'] for b in value['blocks'])
        self.assertEqual(full.count('/article-asset/'), 2)
        self.assertIn('$L = \\frac{x_1^2}{2}$', full)
        self.assertIn('$$W_Q^TW_K$$', full)
        self.assertEqual(len(value['images']), 2)
        self.assertEqual(value['warnings'], [])

    def test_summary_cannot_pass_for_full_translation(self):
        value, folder = articles.prepare(URL)
        original = ('The proposed method measures feature activations across all layers and all token positions. '
                    'The experiment uses 128 prompts, and the results only support the claim under these assumptions. '
                    'We do not claim this result generalizes to other architectures or other training distributions. ')*5
        value['blocks'] = [{'index': 1, 'original': original, 'chinese': ''}]
        articles.write(folder/'article.json', value)
        with self.assertRaisesRegex(ValueError, '压缩|完整|过短'):
            articles.set_translation(URL, 1, '本文研究特征。')

    def test_formula_only_does_not_need_fabricated_chinese(self):
        value, folder = articles.prepare(URL)
        value['blocks'] = [{'index': 1, 'original': '$W_Q^TW_K$', 'chinese': ''}]
        articles.write(folder/'article.json', value)
        articles.set_translation(URL, 1, '$W_Q^TW_K$')

    def test_review_is_invalidated_after_any_translation_edit(self):
        value, folder = self.translate()
        articles.set_translation(URL, 1, '# 再次修改标题')
        with self.assertRaisesRegex(ValueError, '先读取'):
            articles.review_translation(URL, 1, 1, True)
        with self.assertRaisesRegex(ValueError, '复核'):
            articles.finish(URL, {'chinese_title': '理解特征', 'domain_id': self.domain['id'], 'reason': '全文讨论内部特征'})
        articles.review_translation(URL, 1, 1)
        articles.review_translation(URL, 1, 1, True)
        articles.finish(URL, {'chinese_title': '理解特征', 'domain_id': self.domain['id'], 'reason': '全文讨论内部特征'})

    def test_legacy_repair_retains_annotations_collections_and_recoverable_files(self):
        receipt=self.archive()
        paper=lib.paper(receipt['paper_id']); folder=Path(paper['files']['article']).parent
        value=json.loads((folder/'article.json').read_text());value.pop('extraction_version',None)
        for block in value['blocks']: block.pop('review_sha256',None)
        articles.write(folder/'article.json',value)
        lib.save_reading(paper['id'], {'highlights':[{'id':'abcd','page':2,'language':'original','text':'interpretable features','rects':[],'comment':'我的注释'}]})
        collection=collections_store.save({'name':'保留收藏'})
        collections_store.assign(paper['id'],[collection['id']])
        original=(folder/'original.md').read_text()
        repaired,_=articles.repair(URL)
        self.assertEqual(repaired['extraction_version'],2)
        self.assertFalse(repaired['completed'])
        lib.refresh()
        self.assertEqual(lib.paper(paper['id'])['record']['id'],paper['id'])
        self.assertEqual((folder/'backups/extraction-v1/original.md').read_text(),original)
        with lib.db() as c:
            state=json.loads(c.execute('SELECT data FROM reading WHERE id=?',(paper['id'],)).fetchone()[0])
        self.assertEqual(state['highlights'][0]['comment'],'我的注释')
        self.assertEqual(state['highlights'][0]['page'],2)
        self.assertTrue((folder/'backups/extraction-v1/reading.json').exists())
        self.assertGreater(sum(bool(b['chinese']) for b in repaired['blocks']),0)
        with patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            job=jobs.create('blog',URL)
        self.assertEqual(job['status'],'queued');submit.assert_called_once()

    def test_anchors_and_script_driven_figures_are_not_silently_discarded(self):
        html='<article><h2 id="original-anchor">Findings</h2><p>'+'Scientific evidence with complete results. '*6+'</p><div data-args="sample"></div></article>'
        with patch.object(articles, 'fetch',return_value=(html.encode(),'text/html',normalize_url(URL))):
            value,_=articles.prepare(URL)
        self.assertIn('original-anchor',value['blocks'][0]['anchors'])
        self.assertFalse(value['source_complete'])
        self.assertTrue(value['warnings'])
        self.assertIn('交互图表', '\n'.join(b['original'] for b in value['blocks']))

    def test_mixed_batch_normalizes_tracking_deduplicates_and_validates_all_first(self):
        with patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            batch = jobs.create_many('2406.02469\n'+URL+'\nhttps://research.example.org/posts/features')
            self.assertEqual([j['kind'] for j in batch['jobs']], ['import', 'blog'])
            self.assertEqual(submit.call_count, 2)
            count = len(jobs.recent())
            with self.assertRaises(ValueError): jobs.create_many('2501.12345\nfile:///etc/passwd')
            self.assertEqual(len(jobs.recent()), count)

    def test_translation_resume_and_immutable_math_code_images(self):
        value, folder = articles.prepare(URL)
        block = next(b for b in value['blocks'] if 'L = x^2' in b['original'])
        with self.assertRaisesRegex(ValueError, '公式'):
            articles.set_translation(URL, block['index'], block['original'].replace('x^2', 'x^3')+' 中文')
        articles.set_translation(URL, 1, '# 理解特征')
        self.assertEqual(articles.prepare(URL)[0]['blocks'][0]['chinese'], '# 理解特征')
        with self.assertRaisesRegex(ValueError, '尚未'):
            articles.finish(URL, {'chinese_title': '测试', 'domain_id': self.domain['id'], 'reason': '测试'})

    def test_complete_blog_survives_refresh_and_uses_queue_annotations_and_full_ai_text(self):
        receipt = self.archive()
        paper = lib.paper(receipt['paper_id'])
        self.assertEqual(paper['record']['sourceType'], 'blog')
        self.assertTrue(paper['record']['original'] and paper['record']['chinese'])
        self.assertEqual(paper['record']['domain'], self.domain['id'])
        self.assertEqual(len(lib.papers()), 1)
        lib.refresh()
        self.assertEqual(len(lib.papers()), 1)
        collection = collections_store.save({'name': '研究'})
        collections_store.assign(paper['id'], [collection['id']])
        self.assertEqual(waiting_list.listing()[0]['paper_id'], paper['id'])
        lib.save_reading(paper['id'], {'highlights': [{'id': 'abcd', 'page': 2, 'language': 'original', 'text': 'interpretable features', 'rects': [], 'comment': '重点'}]})
        pages, coverage = conversation.source_pages(paper, {'language': 'chinese', 'page': 2})
        self.assertTrue(coverage['complete'])
        self.assertEqual(coverage['unit'], 'block')
        self.assertIn('controlled interventions', '\n'.join(p['text'] for p in pages))
        session = {'paper_ids': [paper['id']]}
        result = paper_tools.execute(session, 'archive_read_article', {'paper_id': paper['id'], 'start_block': 1, 'end_block': 3})
        text = json.loads(result['contentItems'][0]['text'])
        self.assertEqual(text['next_block'], 4)
        self.assertIn('/read/', text['blocks'][0]['citation'])
        with self.assertRaises(ValueError): paper_tools.execute({'paper_ids': ['other']}, 'archive_read_article', {'paper_id': paper['id']})
        with patch.object(jobs.IMPORT_POOL, 'submit') as submit:
            job = jobs.create('blog', URL)
        self.assertTrue(job['result']['duplicate'])
        submit.assert_not_called()

    def test_blog_domain_evidence_requires_actual_block_quote(self):
        receipt = self.archive()
        scan = domain_scan.start([self.domain['id']], submit=False)
        data = {'paper_id': receipt['paper_id'], 'domain_id': self.domain['id'], 'matches': True, 'confidence': .9,
                'reason': '内部特征', 'language': 'original', 'page': 2,
                'quote': 'We study interpretable features and sparse representations'}
        domain_scan.record(scan['id'], [data])
        with self.assertRaises(ValueError): domain_scan.record(scan['id'], [{**data, 'page': 1}])
        result = domain_scan.finish(scan['id'])
        self.assertTrue(result)

    def test_public_url_and_dns_boundary(self):
        for url in ['http://127.0.0.1/x', 'http://[::1]/x', 'http://169.254.169.254/', 'http://localhost/', 'file:///tmp/a', 'https://user:pass@example.org/', 'https://example.org:8767/', 'https://arxiv.org.evil.test/abs/2406.02469']:
            with self.assertRaises(ValueError): normalize_url(url)
        for address in ['127.0.0.1', '10.1.1.1', '169.254.169.254', '::1']:
            with patch.object(socket, 'getaddrinfo', return_value=[(2, 1, 6, '', (address, 443))]):
                with self.assertRaises(ValueError): public_address('example.org', 443)
        self.assertEqual(normalize_url(URL+'#section'), 'https://research.example.org/posts/features')

    def test_native_blog_session_resumes_and_uses_bundled_skill(self):
        a = blog_import.create(normalize_url(URL), 'job-a')
        b = blog_import.create(normalize_url(URL), 'job-b')
        self.assertEqual(a['id'], b['id'])
        stored = harness._load(a['id'])
        self.assertEqual(stored['model'], 'gpt-6.1-sol')
        self.assertEqual(stored['effort'], 'medium')
        self.assertTrue(stored['skill_path'].endswith('blog-translate/SKILL.md'))
        self.assertEqual(stored['source_type'], 'blog')

    def test_damaged_original_cannot_be_marked_complete(self):
        value, folder = self.translate()
        (folder/'original.md').write_text('changed original')
        with self.assertRaisesRegex(ValueError, '原文已改变'):
            articles.finish(URL, {'chinese_title': '理解特征', 'domain_id': self.domain['id'], 'reason': '测试'})

    def test_failed_image_is_disclosed_and_source_scripts_never_render(self):
        value, folder = articles.prepare(URL)
        def failed(url, limit=0):
            if url.endswith('.png'): raise RuntimeError('synthetic image failure')
            return HTML.encode(), 'text/html', normalize_url(url)
        other = 'https://research.example.org/posts/another'
        with patch.object(articles, 'fetch', side_effect=failed): value, _ = articles.prepare(other)
        self.assertEqual(value['images'], {})
        self.assertIn('synthetic image failure', value['warnings'][0])
        self.assertIn('图片未能离线保存', '\n'.join(b['original'] for b in value['blocks']))

    def test_redirect_to_local_network_is_rejected_before_second_connection(self):
        from unittest.mock import MagicMock
        import web_sources
        response = MagicMock(status=302)
        response.getheader.return_value = 'http://127.0.0.1:8767/api/bootstrap'
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch.object(web_sources, 'public_address', return_value='8.8.8.8'), \
             patch.object(web_sources.http.client, 'HTTPConnection', return_value=connection), \
             patch.object(web_sources.socket, 'create_connection') as connect, \
             patch.object(web_sources, 'tls_context'):
            with self.assertRaises(ValueError): web_sources.fetch(URL)
        self.assertEqual(connect.call_count, 1)

    def test_fuzzy_search_contains_blog_source_and_full_original_evidence(self):
        receipt = self.archive()
        catalog = lib.search_catalog()
        item = next(p for p in catalog if p['id'] == receipt['paper_id'])
        self.assertEqual(item['sourceType'], 'blog')
        self.assertEqual(item['site'], 'research.example.org')
        self.assertIn('controlled interventions', item['source_excerpt'])
        answer = {'interpretation': '机构 Blog 的可解释性研究', 'results': [
            {'id': item['id'], 'score': .9, 'reason': '讨论内部特征', 'uncertainty': '', 'evidence': item['site']}]}
        result = jobs.validate_results(answer, catalog)
        self.assertTrue(result['results'][0]['verified'])

    def test_svg_preserves_local_plot_shapes_and_removes_active_external_content(self):
        svg = b'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="curve" d="M0 0 L10 10"/><clipPath id="clip"><rect width="20" height="20"/></clipPath></defs><g clip-path="url(#clip)"><use xlink:href="#curve"/></g><use href="https://evil.test/plot.svg"/><script>bad()</script><animate attributeName="href" values="https://evil.test"/><rect onload="bad()" style="fill:url(https://evil.test)"/></svg>'''
        kind, body = articles.image_bytes(svg, 'text/plain')
        self.assertEqual(kind, 'svg')
        self.assertIn(b'#curve', body)
        self.assertIn(b'url(#clip)', body)
        for forbidden in (b'evil.test', b'onload', b'bad()', b'<script', b'<animate'):
            self.assertNotIn(forbidden, body)
