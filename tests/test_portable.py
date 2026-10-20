import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import fitz
import library as lib
import jobs
import global_chat
import importer
import providers
import settings
import taxonomy


class PortableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / '.paper-archive/state'
        self.state.mkdir(parents=True)
        self.patches = [patch.object(lib, 'ROOT', self.root), patch.object(lib, 'STATE', self.state)]
        for p in self.patches: p.start()
        lib.init_db()
        for ident, phrase in [('a', 'Depth changes the computation path.'), ('b', 'Growth changes the training cost.')]:
            file = self.root / (ident + '.pdf')
            doc = fitz.open(); page = doc.new_page(); page.insert_text((50, 50), phrase); doc.save(file); doc.close()
            record = dict(id=ident, domain='unfiled', domainName='未分类', title=ident, english=ident, year=2025,
                          topics=[], authors=[], abstract=phrase, summary='', arxiv='2501.0000'+str(1 if ident=='a' else 2))
            with lib.db() as c:
                c.execute('INSERT INTO papers VALUES(?,?,?,?,?)', (ident, json.dumps(record), json.dumps({'original': str(file)}), phrase, 'f'))

    def tearDown(self):
        for p in self.patches[::-1]: p.stop()
        self.tmp.cleanup()

    def test_domains_rename_assignment_and_archive(self):
        domain = taxonomy.save({'name':'深度', 'description':'计算深度与模型增长'})['domains'][-1]
        taxonomy.assign('a', domain['id'])
        taxonomy.save({**domain, 'name':'计算机制'})
        self.assertEqual(lib.paper('a')['record']['domainName'], '计算机制')
        self.assertEqual(lib.search_catalog()[0]['domainName'], '计算机制')
        self.assertEqual(taxonomy.read()['domains'][-1]['folder'], domain['folder'])
        taxonomy.save({**domain, 'archived': True})
        with self.assertRaises(ValueError): taxonomy.assign('b', domain['id'])
        self.assertEqual(lib.paper('a')['record']['domain'], domain['id'])
        with self.assertRaises(ValueError): taxonomy.save({'name':'../../escape'})

    def test_scope_and_grounded_cross_paper_answer(self):
        lib.save_reading('a', {'draft':'PRIVATE_NOTES_NOT_FOR_MODEL'})
        turn = global_chat.start({'question':'Compare', 'paper_ids':['a','b']}, submit=False)
        with self.assertRaises(ValueError): global_chat.start({'question':'unknown','paper_ids':['unknown']}, submit=False)
        prompts=[]
        def execute(uid, prompt, schema, timeout):
            prompts.append(prompt)
            if schema == global_chat.SELECT:
                return json.dumps({'ids':['a','b','invented'], 'reason':'compare'})
            return json.dumps({'answer':'Two methods. This is a hypothesis.', 'citations':[
                {'paper_id':'a','language':'original','page':1,'quote':'Depth changes the computation path.'},
                {'paper_id':'b','language':'original','page':1,'quote':'Growth changes the training cost.'},
                {'paper_id':'a','language':'original','page':2,'quote':'Invented unsupported quote.'}]})
        with patch.object(jobs,'execute',side_effect=execute):
            result=global_chat.answer(turn['id'])
        self.assertEqual(len(result['citations']),2)
        self.assertTrue(result['unverified'])
        self.assertEqual(len(result['coverage']),2)
        self.assertTrue(all(c['complete'] for c in result['coverage']))
        self.assertNotIn('PRIVATE_NOTES_NOT_FOR_MODEL',''.join(prompts))
        jobs.update(turn['id'],status='completed',result=result)
        self.assertEqual(global_chat.history()[0]['result'],result)

    def test_scope_excludes_unselected_paper(self):
        turn=global_chat.start({'question':'A only', 'paper_ids':['a']},submit=False)
        with patch.object(jobs,'execute',return_value=json.dumps({'ids':[],'reason':'none'})) as execute:
            result=global_chat.answer(turn['id'])
        self.assertNotIn('Growth changes the training cost.',execute.call_args.args[1])
        self.assertEqual(result['citations'],[])

    def test_config_never_exposes_key_and_rejects_insecure_remote(self):
        with patch.dict(os.environ,{'PAPER_API_KEY':'test-secret-value'}):
            self.assertTrue(settings.public()['has_key'])
            self.assertNotIn('test-secret-value',json.dumps(settings.public()))
        with self.assertRaises(ValueError): settings.save({'base_url':'http://example.com/v1'})
        with self.assertRaises(ValueError): settings.save({'base_url':'https://user:password@example.com'})
        with self.assertRaises(ValueError): settings.save({'api_key':'secret'})
        settings.save({'base_url':'http://127.0.0.1:9000/v1'})

    def test_api_protocols_and_incomplete_output(self):
        config={'provider':'api','model':'test-model','base_url':'https://api.example.test/v1','protocol':'responses'}
        response={'status':'completed','output':[{'content':[{'type':'output_text','text':'{"text":"done"}'}]}]}
        with patch.dict(os.environ,{'PAPER_API_KEY':'fake-test-key'}), patch.object(settings,'read',return_value=config), patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value.__enter__.return_value=io.BytesIO(json.dumps(response).encode())
            self.assertEqual(json.loads(providers.complete('prompt',importer.TEXT))['text'],'done')
            req=opener.return_value.open.call_args.args[0]
            self.assertEqual(req.full_url,'https://api.example.test/v1/responses')
            payload=json.loads(req.data);self.assertFalse(payload['store']);self.assertTrue(payload['text']['format']['strict'])
            response['status']='incomplete'
            opener.return_value.open.return_value.__enter__.return_value=io.BytesIO(json.dumps(response).encode())
            with self.assertRaises(RuntimeError):providers.complete('prompt')
            config['protocol']='chat'
            response={'choices':[{'finish_reason':'stop','message':{'content':'{"text":"chat"}'}}]}
            opener.return_value.open.return_value.__enter__.return_value=io.BytesIO(json.dumps(response).encode())
            self.assertEqual(json.loads(providers.complete('prompt',importer.TEXT))['text'],'chat')
            self.assertTrue(opener.return_value.open.call_args.args[0].full_url.endswith('/chat/completions'))
            opener.return_value.open.side_effect=urllib.error.HTTPError('https://api.example.test',401,'fake-test-key',{},None)
            with self.assertRaisesRegex(RuntimeError,'HTTP 401') as caught: providers.complete('prompt')
            self.assertNotIn('fake-test-key',str(caught.exception))

    def test_archive_traversal_and_symlinks_are_rejected(self):
        for name,link in [('../escape',False),('symlink',True)]:
            archive=self.root/'source.tar.gz'
            with tarfile.open(archive,'w:gz') as t:
                item=tarfile.TarInfo(name)
                if link:item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd'
                else:item.size=4
                t.addfile(item, None if link else io.BytesIO(b'test'))
            with self.assertRaises(RuntimeError): importer.extract(archive,self.root/'tex')
        self.assertFalse((self.root.parent/'escape').exists())

    def test_latex_math_and_references_cannot_change(self):
        original=r'\section{Method} Text $a+b$ \cite{work}.'
        good=r'\section{方法} 文本 $a+b$ \cite{work}.'
        self.assertEqual(importer.invariant(original),importer.invariant(good))
        self.assertNotEqual(importer.invariant(original),importer.invariant(good.replace('a+b','a-b')))
        self.assertNotEqual(importer.invariant(original),importer.invariant(good.replace('work','fake')))

    @unittest.skipUnless(shutil.which('xelatex'), 'XeLaTeX optional integration dependency')
    def test_complete_import_with_dynamic_domain_and_real_compiler(self):
        domain=taxonomy.save({'name':'计算方法','description':'方法与机制'})['domains'][-1]
        original_text='A synthetic paper for pipeline validation.'
        tex='\\documentclass{article}\n\\begin{document}\n\\section{Method}\nA synthetic paper. $a+b$\n\\end{document}\n'
        def fake_download(url,dest,limit=0):
            if '/pdf/' in url:
                d=fitz.open();p=d.new_page();p.insert_text((40,40),original_text);d.save(dest);d.close()
            else:
                with tarfile.open(dest,'w:gz') as t:
                    data=tex.encode();item=tarfile.TarInfo('main.tex');item.size=len(data);t.addfile(item,io.BytesIO(data))
        def fake_ask(uid,instruction,data,schema=importer.TEXT):
            if schema==importer.CLASSIFY:return {'domain_id':domain['id'],'reason':'完整方法证据','chinese_title':'合成测试论文'}
            if 'latex' in data:return {'text':data['latex'].replace('Method','方法').replace('A synthetic paper.','合成论文。')}
            return {'text':'## 一句话判断\n\n合成验证论文，第 1 页。'}
        meta={'arxiv_id':'2501.12345','title':'Synthetic test','abstract':original_text,'authors':['Example'],'published':'2025-01-01'}
        job=jobs.create('import','2501.12345',submit=False)
        with patch.object(importer,'metadata',return_value=meta),patch.object(importer,'download',side_effect=fake_download),patch.object(importer,'ask',side_effect=fake_ask):
            result=importer.import_paper(job['id'],'2501.12345')
        paper=lib.paper(result['paper_id'])
        self.assertEqual(paper['record']['domain'],domain['id'])
        self.assertTrue(paper['record']['chinese'])
        self.assertEqual(len(paper['record']['notes']),4)
        self.assertIsNotNone(jobs.existing_result('2501.12345'))
