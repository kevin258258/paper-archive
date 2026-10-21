"""The user's Codex app-server, over its documented JSON-lines stdio protocol."""
import json
import os
import queue
import subprocess
import threading


class CodexRPC:
    def __init__(self, executable, cwd, notify, request, disconnected):
        self.notify, self.request, self.disconnected = notify, request, disconnected
        self.lock = threading.Lock()
        self.pending = {}
        self.sequence = 0
        self.closed = False
        self.process = subprocess.Popen(
            [executable, "app-server"], cwd=cwd, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1,
            start_new_session=os.name != "nt",
        )
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.call("initialize", {
                "clientInfo": {"name": "paper_archive", "title": "Paper Archive", "version": "0.4.0"},
                "capabilities": {"experimentalApi": True},
            })
            self.send({"method": "initialized", "params": {}})
        except Exception:
            self.close()
            raise

    def send(self, value):
        with self.lock:
            if self.closed or self.process.poll() is not None:
                raise RuntimeError("Codex 连接已断开；重新发送可恢复原会话")
            self.process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
            self.process.stdin.flush()

    def call(self, method, params=None, timeout=60):
        with self.lock:
            self.sequence += 1
            uid = self.sequence
            channel = self.pending[uid] = queue.Queue(maxsize=1)
        try:
            self.send({"id": uid, "method": method, "params": params or {}})
            try:
                response = channel.get(timeout=timeout)
            except queue.Empty:
                raise RuntimeError(f"Codex {method} 响应超时；请检查本机 Codex") from None
            if "error" in response:
                raise RuntimeError(response["error"].get("message", "Codex 调用失败"))
            return response.get("result", {})
        finally:
            with self.lock:
                self.pending.pop(uid, None)

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if "method" in message:
                    # Dispatch server requests separately: tool execution must never block
                    # the sole reader responsible for RPC responses and streaming deltas.
                    if "id" in message:
                        threading.Thread(target=self.request, args=(self, message), daemon=True).start()
                    else:
                        self.notify(message["method"], message.get("params", {}))
                elif "id" in message:
                    with self.lock:
                        channel = self.pending.get(message["id"])
                        if channel and channel.empty():
                            channel.put_nowait(message)
        finally:
            with self.lock:
                self.closed = True
                for channel in self.pending.values():
                    if channel.empty():
                        channel.put_nowait({"error": {"message": "本机 Codex 已退出；会话保留，可重新连接"}})
            self.disconnected()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.closed = True
