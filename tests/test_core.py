import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import library
import jobs
from server import range_bounds


class InputTests(unittest.TestCase):
    def test_arxiv_urls_and_versions(self):
        self.assertEqual(library.parse_arxiv("https://arxiv.org/pdf/2406.02469v1.pdf"), "2406.02469v1")
        self.assertEqual(library.parse_arxiv("https://arxiv.org/abs/hep-th/9901001"), "hep-th/9901001")
        self.assertEqual(library.arxiv_base("2406.02469v3"), "2406.02469")
        self.assertEqual(library.parse_arxiv("https://arxiv.org/abs/2609.32534?utm_source=chatgpt.com"), "2609.32534")

    def test_reject_foreign_hosts_and_shell_payloads(self):
        for value in ["https://arxiv.org.evil.test/abs/2406.02469", "2406.02469; touch /tmp/oops",
                      "https://evil.test/abs/2406.02469", "file:///tmp/paper", "../2406.02469"]:
            with self.assertRaises(ValueError):
                library.parse_arxiv(value)

    def test_stable_identity_after_move_or_version_change(self):
        self.assertEqual(library.stable_id("2406.02469v1", "old"), library.stable_id("2406.02469v2", "new"))

    def test_ranges_for_pdf_seek_and_suffix(self):
        self.assertEqual(range_bounds("bytes=100-199", 1000), (100, 199, True))
        self.assertEqual(range_bounds("bytes=900-", 1000), (900, 999, True))
        self.assertEqual(range_bounds("bytes=-100", 1000), (900, 999, True))
        for value in ["bytes=1000-", "bytes=900-100", "bytes=-0", "bytes=0-1,2-3"]:
            with self.assertRaises(ValueError):
                range_bounds(value, 1000)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.patch = patch.object(library, "STATE", Path(self.temp.name))
        self.patch.start()
        library.init_db()
        with library.db() as c:
            c.execute("INSERT INTO papers VALUES(?,?,?,?,?)", ("paper1", "{}", "{}", "", "fingerprint"))

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_patch_keeps_note_when_position_changes(self):
        library.save_reading("paper1", {"draft": "个人笔记", "marked": True})
        library.save_reading("paper1", {"positions": {"original": {"page": 4}}})
        data = library.all_reading()["paper1"]
        self.assertEqual(data["draft"], "个人笔记")
        self.assertTrue(data["marked"])
        self.assertEqual(data["positions"]["original"]["page"], 4)

    def test_no_reading_for_nonexistent_paper_or_vault_fields(self):
        with self.assertRaises(KeyError):
            library.save_reading("absent", {"draft": "x"})
        with self.assertRaises(ValueError):
            library.save_reading("paper1", {"seed_status": "已筛选"})

    def test_duplicate_import_is_one_queued_job(self):
        a = jobs.create("import", "https://arxiv.org/abs/2406.02469v1", submit=False)
        b = jobs.create("import", "2406.02469", submit=False)
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(a["status"], "queued")

    def test_restart_marks_running_interrupted(self):
        job = jobs.create("search", "测试", submit=False)
        jobs.update(job["id"], status="running")
        jobs.recover()
        self.assertEqual(jobs.get(job["id"])["status"], "interrupted")

    def test_cancellation_is_persisted(self):
        job = jobs.create("search", "测试取消", submit=False)
        self.assertEqual(jobs.cancel(job["id"])["status"], "cancelled")


class SearchTests(unittest.TestCase):
    def test_evidence_preserves_pdf_line_breaks(self):
        quote = "Qwen2.5-VL Technical Report\nQwen Team, Alibaba Group"
        result = jobs.validate_results({"results": [{"id": "a", "evidence": quote}]},
                                      [{"id": "a", "source_excerpt": quote + "\nAbstract"}])
        self.assertTrue(result["results"][0]["verified"])
        self.assertEqual(result["results"][0]["evidence"], quote)

    def test_unknown_ids_and_duplicate_results_are_removed(self):
        catalog = [{"id": "a", "english": "Qwen3-VL Technical Report", "source_excerpt": "Alibaba Group"}]
        answer = {"interpretation": "VLM 报告", "results": [
            {"id": "not-in-library", "score": 1, "reason": "invented"},
            {"id": "a", "score": 2, "reason": "报告", "evidence": "Qwen3-VL Technical Report", "uncertainty": ""},
            {"id": "a", "score": .5, "reason": "duplicate"},
        ]}
        hits = jobs.validate_results(answer, catalog)["results"]
        self.assertEqual(len(hits), 1)
        self.assertTrue(hits[0]["verified"])
        self.assertEqual(hits[0]["score"], 1)

    def test_invented_evidence_is_not_displayed(self):
        result = jobs.validate_results({"results": [{"id": "a", "evidence": "Invented institutional claim", "score": .5}]},
                                       [{"id": "a", "source_excerpt": "Actual text"}])
        hit = result["results"][0]
        self.assertFalse(hit["verified"])
        self.assertEqual(hit["evidence"], "")
        self.assertTrue(hit["uncertainty"])


class ImportTests(unittest.TestCase):
    def test_completed_paper_does_not_wait_for_translation_queue(self):
        paper = {"id": "paper1", "arxiv": "2406.02469v1"}
        with patch.object(library, "find_arxiv", return_value=paper), \
             patch.object(jobs, "verify_import", return_value=paper), \
             patch.object(jobs, "source_lock") as lock:
            result = jobs.import_paper("unused-job", "2406.02469")
        self.assertTrue(result["duplicate"])
        lock.assert_not_called()

    def test_different_explicit_version_is_not_silently_replaced(self):
        with patch.object(library, "find_arxiv", return_value={"arxiv": "2406.02469v1"}):
            with self.assertRaisesRegex(RuntimeError, "指定版本不同"):
                jobs.existing_result("2406.02469v2")


if __name__ == "__main__":
    unittest.main()
