import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz
import library
import jobs
import collections_store as collections
import conversation


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patcher = patch.object(library, "STATE", self.root)
        self.patcher.start()
        library.init_db()
        doc = fitz.open()
        for text in ("Page one: DepthBench compares compute depth.", "Page two: Experiments use equal FLOPs."):
            doc.new_page().insert_text((60, 60), text)
        doc.save(self.root / "paper.pdf")
        doc.close()
        with library.db() as c:
            for uid in ("p1", "p2"):
                c.execute("INSERT INTO papers VALUES(?,?,?,?,?)",
                          (uid, json.dumps({"id": uid, "title": uid}),
                           json.dumps({"original": str(self.root / "paper.pdf")}), "", "v1"))

    def tearDown(self):
        self.patcher.stop()
        self.temp.cleanup()

    def test_many_collections_and_archive_restoration(self):
        a, b = collections.save({"name": "深度"}), collections.save({"name": "待读"})
        collections.assign("p1", [a["id"], b["id"]])
        collections.save({"archived": True, "name": "计算深度"}, a["id"])
        collections.assign("p1", [])  # Must preserve archived membership.
        collections.save({"archived": False}, a["id"])
        restored = next(c for c in collections.listing() if c["id"] == a["id"])
        self.assertEqual(restored["papers"], ["p1"])
        self.assertEqual(restored["name"], "计算深度")
        self.assertEqual(next(c for c in collections.listing() if c["id"] == b["id"])["papers"], [])

    def test_invalid_membership_does_not_erase_existing(self):
        a = collections.save({"name": "A"})
        collections.assign("p1", [a["id"]])
        with self.assertRaises(ValueError):
            collections.assign("p1", ["unknown"])
        self.assertEqual(collections.listing()[0]["papers"], ["p1"])

    def test_migration_runs_once_without_readding_removed_paper(self):
        library.save_reading("p1", {"marked": True})
        with library.db() as c:
            c.execute("DELETE FROM app_meta WHERE key='collections_migrated'")
        collections.initialize()
        a = collections.listing()[0]
        self.assertEqual(a["papers"], ["p1"])
        collections.assign("p1", [])
        collections.initialize()
        self.assertEqual(collections.listing()[0]["papers"], [])

    def test_annotation_comment_survives_position_and_reopen(self):
        h = {"id": "abcd", "page": 2, "language": "original", "text": "equal FLOPs",
             "comment": "需要留意计算预算", "rects": []}
        library.save_reading("p1", {"highlights": [h], "draft": "已有笔记"})
        library.save_reading("p1", {"positions": {"original": {"page": 1}}})
        self.assertEqual(library.all_reading()["p1"]["highlights"][0]["comment"], h["comment"])
        for bad in ({"comment": 3}, {"page": -1}):
            with self.assertRaises(ValueError):
                library.save_reading("p1", {"highlights": [{**h, **bad}]})

    def test_conversations_are_isolated_and_duplicate_submit_is_idempotent(self):
        data = {"question": "核心结论？", "language": "original", "page": 2}
        a = conversation.start("p1", data, submit=False)
        self.assertEqual(conversation.start("p1", data, submit=False)["id"], a["id"])
        with self.assertRaises(ValueError):
            conversation.start("p1", {**data, "question": "新问题"}, submit=False)
        b = conversation.start("p2", data, submit=False)
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual([t["id"] for t in conversation.history("p1")], [a["id"]])
        self.assertEqual([t["id"] for t in conversation.history("p2")], [b["id"]])

    def test_chat_restart_and_retry_preserve_single_turn(self):
        a = conversation.start("p1", {"question": "方法？"}, submit=False)
        jobs.update(a["id"], status="running")
        jobs.recover()
        self.assertEqual(conversation.history("p1")[0]["status"], "interrupted")
        with patch.object(jobs.POOL, "submit"):
            retried = jobs.retry(a["id"])
        self.assertEqual(retried["id"], a["id"])
        self.assertEqual(len(conversation.history("p1")), 1)

    def test_pdf_context_page_numbers_coverage_and_citation_validation(self):
        pages, coverage = conversation.source_pages(library.paper("p1"), {"language": "original", "page": 2})
        self.assertTrue(coverage["complete"])
        self.assertEqual(pages[0]["page"], 2)
        answer = conversation.validate_answer({"answer": "等 FLOPs 比较", "citations": [
            {"language": "original", "page": 2, "quote": "Experiments use equal FLOPs."},
            {"language": "chinese", "page": 2, "quote": "Experiments use equal FLOPs."},
            {"language": "original", "page": 1, "quote": "Experiments use equal FLOPs."},
        ]}, pages, coverage)
        self.assertEqual(len(answer["citations"]), 1)
        self.assertTrue(answer["unverified"])
        _, partial = conversation.source_pages(library.paper("p1"), {"language": "original", "page": 2}, budget=45)
        self.assertFalse(partial["complete"])
        self.assertEqual(partial["pages"], [2])

    def test_answer_prompt_has_only_current_paper_history_and_no_private_notes(self):
        library.save_reading("p1", {"draft": "DO NOT SEND PRIVATE DRAFT"})
        own = conversation.start("p1", {"question": "Own question"}, submit=False)
        jobs.update(own["id"], status="completed", result={"answer": "Own answer"})
        other = conversation.start("p2", {"question": "OTHER PAPER QUESTION"}, submit=False)
        jobs.update(other["id"], status="completed", result={"answer": "OTHER PAPER ANSWER"})
        current = conversation.start("p1", {"question": "Follow up"}, submit=False)
        with patch.object(jobs, "execute", return_value='{"answer":"Answer","citations":[]}') as execute:
            conversation.answer(current["id"])
        prompt = execute.call_args.args[1]
        self.assertIn("Own answer", prompt)
        self.assertNotIn("OTHER PAPER", prompt)
        self.assertNotIn("PRIVATE DRAFT", prompt)


if __name__ == "__main__":
    unittest.main()
