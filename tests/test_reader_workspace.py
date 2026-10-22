import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import attachments
import library as lib
import reader_workspace

class ReaderWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.patchers=[patch.object(lib,'STATE',Path(self.tmp.name)),patch.object(lib,'papers',return_value=[{'id':'one'},{'id':'two'}])]
        for p in self.patchers:p.start()
    def tearDown(self):
        for p in reversed(self.patchers):p.stop()
        self.tmp.cleanup()
    def test_tabs_and_active_paper_survive_reloads_and_port_changes(self):
        reader_workspace.save({'tabs':['one','two','one'],'active':'two'})
        self.assertEqual(reader_workspace.read(),{'tabs':['one','two'],'active':'two'})
        reader_workspace.save({'tabs':['two'],'active':None})
        self.assertEqual(reader_workspace.read(),{'tabs':['two'],'active':None})
        with self.assertRaises(ValueError):reader_workspace.save({'tabs':['one'],'active':'two'})
        self.assertEqual(reader_workspace.read()['tabs'],['two'])
    def test_drafts_are_durable_and_isolated_by_paper_and_session(self):
        item=attachments.receive(io.BytesIO(b'full bytes'),'notes.txt',10)
        reader_workspace.draft('paper:one:new',{'text':'first draft','attachments':[item['id']]})
        reader_workspace.draft('paper:two:new',{'text':'second draft','attachments':[]})
        self.assertEqual(reader_workspace.draft('paper:one:new')['text'],'first draft')
        self.assertEqual(reader_workspace.draft('paper:one:new')['attachments'][0]['id'],item['id'])
        reader_workspace.draft('paper:one:new',{'text':'','attachments':[]})
        self.assertEqual(reader_workspace.draft('paper:two:new')['text'],'second draft')
        with self.assertRaises(ValueError):reader_workspace.draft('../../preferences')

    def test_model_files_can_be_opened_only_inside_the_workspace(self):
        import session_files
        root=Path(self.tmp.name)/'vault';root.mkdir();(root/'result.md').write_text('Complete generated result')
        with patch.object(lib,'ROOT',root),patch('harness.snapshot',return_value={'id':'session'}):
            metadata,path=session_files.locate('session','result.md:12')
            self.assertEqual(path.read_text(),'Complete generated result')
            self.assertEqual(metadata['name'],'result.md')
            with self.assertRaises(ValueError):session_files.locate('session','../../etc/passwd')
            with self.assertRaises(ValueError):session_files.locate('session',str(Path(self.tmp.name)/'library.sqlite3'))

    def test_invalid_upload_never_creates_an_attachment_or_reads_a_local_path(self):
        for size in (-1,0,attachments.MAX_BYTES+1):
            with self.assertRaises(ValueError):attachments.receive(io.BytesIO(b''),'x',size)
        with self.assertRaises(ValueError):attachments.receive(io.BytesIO(b'short'),'x',20)
        self.assertEqual(list(attachments.root().iterdir()),[])
        for uid in ('../../etc/passwd','abcd',None):
            with self.assertRaises(ValueError):attachments.resolve(uid)
    def test_safe_names_keep_original_bytes_and_deduplicate_selected_ids(self):
        item=attachments.receive(io.BytesIO(b'whole file'),'../../notes.txt',10)
        self.assertNotIn('/',item['name'])
        self.assertEqual(attachments.resolve(item['id'])[1].read_bytes(),b'whole file')
        self.assertEqual(len(attachments.select([item['id'],item['id']])),1)
