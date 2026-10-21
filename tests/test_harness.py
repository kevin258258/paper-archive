import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
import harness
import library as lib
import paper_tools


class FakeRPC:
    def __init__(self):
        self.calls, self.sent = [], []
        self.closed = False

    def call(self, method, params=None, **kwargs):
        self.calls.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": "native-thread"}}
        if method == "thread/resume":
            return {"thread": {"id": params["threadId"]}}
        if method == "turn/start":
            thread = params["threadId"]
            harness.notification("turn/started", {"threadId": thread, "turn": {"id": "turn-1"}})
            harness.notification("item/agentMessage/delta", {"threadId": thread, "itemId": "message-1", "delta": "First "})
            harness.notification("item/agentMessage/delta", {"threadId": thread, "itemId": "message-1", "delta": "second"})
            harness.notification("item/completed", {"threadId": thread, "item": {
                "id": "reason-1", "type": "reasoning", "summary": ["Public summary"], "content": ["PRIVATE_RAW"]}})
            harness.notification("turn/completed", {"threadId": thread, "turn": {"id": "turn-1", "status": "completed"}})
            return {"turn": {"id": "turn-1"}}
        return {}

    def send(self, data):
        self.sent.append(data)


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(lib, "STATE", self.root), patch.object(lib, "ROOT", self.root),
                        patch.object(harness, "SESSIONS", {}), patch.object(harness, "PENDING", {}),
                        patch.object(harness, "LOADED", set())]
        for p in self.patches:
            p.start()
        lib.init_db()
        with fitz.open() as pdf:
            for n in range(1, 26):
                pdf.new_page().insert_text((50, 50), f"Exact evidence on page {n}.")
            pdf.save(self.root / "full.pdf")
        with lib.db() as c:
            for uid in ("p1", "p2"):
                c.execute("INSERT INTO papers VALUES(?,?,?,?,?)",
                          (uid, json.dumps({"id": uid, "title": uid}),
                           json.dumps({"original": str(self.root / "full.pdf")}), "", "v1"))
        self.rpc = FakeRPC()
        self.caps = {"default_model": "test-model", "default_effort": "xhigh", "models": [{
            "model": "test-model", "isDefault": True, "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [{"reasoningEffort": e} for e in ("medium", "xhigh")]}]}
        self.patches += [patch.object(harness, "connect", return_value=self.rpc),
                         patch.object(harness, "capabilities", return_value=self.caps)]
        self.patches[-2].start()
        self.patches[-1].start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def start(self, uid, question="Explain the entire paper", **kwargs):
        with patch("threading.Thread.start"):
            harness.start(uid, {"question": question, **kwargs})
        harness._start(uid)
        return harness.snapshot(uid)

    def test_native_thread_streaming_model_effort_and_resume(self):
        s = harness.create({"kind": "paper", "paper_id": "p1"})
        uid = s["id"]
        completed = self.start(uid)
        self.assertEqual(completed["status"], "completed")  # completion may precede RPC response
        self.assertEqual(completed["thread_id"], "native-thread")
        self.assertEqual(completed["turns"][0]["items"][0]["text"], "First second")
        self.assertNotIn("PRIVATE_RAW", json.dumps(completed))
        start = next(p for m, p in self.rpc.calls if m == "thread/start")
        self.assertFalse(start["ephemeral"])
        self.assertEqual(start["sandbox"], "read-only")
        turn = next(p for m, p in self.rpc.calls if m == "turn/start")
        self.assertEqual((turn["model"], turn["effort"]), ("test-model", "xhigh"))
        self.assertNotIn("outputSchema", turn)
        self.assertIn(str(self.root / "full.pdf"), json.dumps(turn))
        self.assertNotIn("Exact evidence", json.dumps(turn))  # no truncated PDF prompt wrapper
        harness.SESSIONS.clear()
        harness.LOADED.clear()
        result = self.start(uid, "Follow up without losing prior turns")
        self.assertEqual(len(result["turns"]), 2)
        self.assertEqual(sum(m == "thread/start" for m, _ in self.rpc.calls), 1)
        self.assertIn(("thread/resume", unittest.mock.ANY), self.rpc.calls)

    def test_command_stream_accepts_native_null_initial_output(self):
        session = harness.create({"kind": "paper", "paper_id": "p1"})
        self.start(session["id"])
        harness.notification("item/started", {"threadId": "native-thread", "item": {
            "id": "command-1", "type": "commandExecution", "aggregatedOutput": None}})
        harness.notification("item/commandExecution/outputDelta", {
            "threadId": "native-thread", "itemId": "command-1", "delta": "compile output"})
        item = harness.snapshot(session["id"])["turns"][-1]["items"][-1]
        self.assertEqual(item["aggregatedOutput"], "compile output")

    def test_all_pdf_pages_and_real_image_are_available_with_scope_enforced(self):
        s = harness.create({"kind": "paper", "paper_id": "p1"})
        result = paper_tools.execute(s, "archive_read_pdf", {"paper_id": "p1", "start_page": 21, "end_page": 25})
        text = json.loads(result["contentItems"][0]["text"])
        self.assertEqual(text["total_pages"], 25)
        self.assertIn("Exact evidence on page 25.", text["pages"][-1]["text"])
        self.assertIsNone(text["next_page"])
        image = paper_tools.execute(s, "archive_view_page", {"paper_id": "p1", "page": 25})
        self.assertTrue(image["contentItems"][1]["imageUrl"].startswith("data:image/png;base64,"))
        with self.assertRaises(ValueError):
            paper_tools.execute(s, "archive_read_pdf", {"paper_id": "p2"})
        with self.assertRaises(ValueError):
            paper_tools.execute(s, "archive_view_page", {"paper_id": "p1", "page": 26})

    def test_approvals_are_explicit_and_scoped_to_their_session(self):
        uid = harness.create({"kind": "paper", "paper_id": "p1"})["id"]
        self.start(uid)
        harness.SESSIONS[uid]["status"] = "running"
        harness.server_request(self.rpc, {"id": 51, "method": "item/commandExecution/requestApproval",
                                         "params": {"threadId": "native-thread", "command": "example"}})
        pending = harness.snapshot(uid)["requests"][0]
        self.assertFalse(self.rpc.sent)
        other = harness.create({"kind": "paper", "paper_id": "p2"})["id"]
        with self.assertRaises(ValueError):
            harness.respond(other, {"request_id": pending["id"], "decision": "accept"})
        harness.respond(uid, {"request_id": pending["id"], "decision": "decline"})
        self.assertEqual(self.rpc.sent[-1], {"id": 51, "result": {"decision": "decline"}})
        with self.assertRaises(ValueError):
            harness.respond(uid, {"request_id": pending["id"], "decision": "accept"})

    def test_stop_during_start_and_restart_never_leave_running_forever(self):
        uid = harness.create({"kind": "paper", "paper_id": "p1"})["id"]
        with patch("threading.Thread.start"):
            harness.start(uid, {"question": "Explain"})
        harness.interrupt(uid)
        harness._start(uid)
        self.assertEqual(harness.snapshot(uid)["status"], "interrupted")
        self.assertFalse(any(m == "turn/start" for m, _ in self.rpc.calls))
        with patch("threading.Thread.start"):
            harness.start(uid, {"question": "Continue"})
        harness.disconnected()
        harness.SESSIONS.clear()
        self.assertEqual(harness.snapshot(uid)["status"], "interrupted")
        self.assertIsNone(harness.snapshot(uid)["thread_id"])  # no native turn was ever submitted

    def test_invalid_effort_and_concurrent_turn_rejected(self):
        uid = harness.create({"kind": "paper", "paper_id": "p1"})["id"]
        with self.assertRaises(ValueError):
            harness.start(uid, {"question": "Explain", "effort": "low"})
        with patch("threading.Thread.start"):
            harness.start(uid, {"question": "Explain"})
            with self.assertRaises(ValueError):
                harness.start(uid, {"question": "Duplicate"})

    def test_unclean_restart_updates_revision_and_turn_state(self):
        uid = harness.create({"kind": "paper", "paper_id": "p1"})["id"]
        with patch("threading.Thread.start"):
            original = harness.start(uid, {"question": "Explain"})
        harness.SESSIONS.clear()
        recovered = harness.snapshot(uid, str(original["revision"]))
        self.assertNotIn("unchanged", recovered)
        self.assertEqual(recovered["turns"][-1]["status"], "interrupted")

    def test_resume_failure_never_discards_an_existing_native_thread(self):
        uid = harness.create({"kind": "paper", "paper_id": "p1"})["id"]
        self.start(uid)
        harness.LOADED.clear()
        original_call = self.rpc.call
        def fail_resume(method, params=None, **kwargs):
            if method == "thread/resume":
                raise RuntimeError("Native history is temporarily unavailable")
            return original_call(method, params, **kwargs)
        with patch.object(self.rpc, "call", side_effect=fail_resume):
            result = self.start(uid, "Continue")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["thread_id"], "native-thread")
        self.assertEqual(sum(m == "thread/start" for m, _ in self.rpc.calls), 1)
