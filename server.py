"""Run the local application: python3 server.py"""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, unquote, parse_qs
import json
import mimetypes
import os
import re
import secrets
import threading
import sys
import signal
import shutil

if __name__ == "__main__" and "--cli" in sys.argv:
    from archive_cli import main as cli_main
    raise SystemExit(cli_main([a for a in sys.argv[1:] if a != "--cli"]))

import library as lib
import jobs
import collections_store
import conversation
import global_chat
import taxonomy
import settings
import harness
import domain_scan

PORT = int(os.environ.get("PAPER_READER_PORT", "8767"))
TOKEN = secrets.token_urlsafe(32)
DESKTOP_TOKEN = os.environ.get("PAPER_DESKTOP_TOKEN", "")
PUBLIC = lib.BASE / "public"
VENDOR = lib.BASE / "node_modules"
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


def range_bounds(header, size):
    if not header:
        return 0, size - 1, False
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not m or not any(m.groups()):
        raise ValueError("range")
    if m[1]:
        start = int(m[1])
        end = min(int(m[2]) if m[2] else size - 1, size - 1)
    else:
        count = int(m[2])
        if count < 1:
            raise ValueError("range")
        start, end = max(0, size - count), size - 1
    if start < 0 or start >= size or end < start:
        raise ValueError("range")
    return start, end, True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Queries are sent in POST bodies, never logged.
        if args and str(args[0]).startswith(("GET /api/jobs", "GET /api/harness/sessions/", "GET /assets/")):
            return
        super().log_message(fmt, *args)

    def response_headers(self, status, mime, length):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

    def json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.response_headers(status, "application/json; charset=utf-8", len(body))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def check_host(self):
        if (DESKTOP_TOKEN and not secrets.compare_digest(self.headers.get("X-Desktop-Token", ""), DESKTOP_TOKEN)) or self.headers.get("Host") not in ALLOWED_HOSTS:
            self.send_error(403)
            return False
        return True

    def do_GET(self):
        if not self.check_host():
            return
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/bootstrap":
                return self.json({"token": TOKEN, "codex": bool(shutil.which("codex")),
                                  "skill": jobs.SKILL.exists(), "reading": lib.all_reading(), "settings": settings.public()})
            m = re.fullmatch(r"/api/file-location/([a-zA-Z0-9]+)/(original|chinese)", path)
            if m and DESKTOP_TOKEN:
                file = lib.paper(m[1])["files"].get(m[2])
                if not file:
                    raise KeyError(m[1])
                return self.json({"path": file})
            if path == "/api/library":
                return self.json({"papers": lib.papers()})
            if path == "/api/settings":
                return self.json(settings.public())
            if path == "/api/harness/sessions":
                query = parse_qs(urlparse(self.path).query)
                return self.json({"sessions": harness.listing(query.get("kind", ["library"])[0],
                                                             query.get("paper_id", [""])[0])})
            if path == "/api/harness/activity":
                return self.json({"active": harness.active()})
            m = re.fullmatch(r"/api/harness/sessions/([a-f0-9]+)", path)
            if m:
                query = parse_qs(urlparse(self.path).query)
                return self.json(harness.snapshot(m[1], query.get("after", [None])[0]))
            if path == "/api/domains":
                return self.json(taxonomy.read())
            m = re.fullmatch(r'/api/domain-scans/([a-f0-9]+)', path)
            if m:
                value = domain_scan.read(m[1])
                return self.json({**value, 'titles': {p['id']: p['title'] for p in lib.papers()}})
            if path == "/api/global-chat":
                return self.json({"turns": global_chat.history()})
            if path == "/api/collections":
                return self.json({"collections": collections_store.listing()})
            m = re.fullmatch(r"/api/papers/([a-zA-Z0-9]+)/chat", path)
            if m:
                return self.json({"turns": conversation.history(m[1])})
            if path == "/api/jobs":
                return self.json(jobs.recent())
            if path.startswith("/api/jobs/"):
                return self.json(jobs.get(path.split("/")[-1]))
            if path.startswith("/file/"):
                parts = path.strip("/").split("/")
                if len(parts) != 3 or parts[2] not in ("original", "chinese", "card"):
                    return self.send_error(404)
                f = lib.paper(parts[1])["files"].get(parts[2])
                if not f:
                    return self.send_error(404)
                return self.file(Path(f), "application/pdf" if parts[2] != "card" else "text/plain; charset=utf-8")
            if path.startswith("/assets/"):
                if not re.fullmatch(r"/assets/[a-f0-9]{20}\.png", path):
                    return self.send_error(404)
                return self.file(lib.STATE / "assets" / path.split("/")[-1])
            if path.startswith("/vendor/"):
                rel = path.removeprefix("/vendor/")
                f = (VENDOR / rel).resolve()
                if not f.is_relative_to(VENDOR.resolve()) or rel.split("/")[0] not in ("pdfjs-dist", "marked", "dompurify", "katex"):
                    return self.send_error(404)
            else:
                f = (PUBLIC / (path.lstrip("/") or "index.html")).resolve()
                if not f.is_relative_to(PUBLIC.resolve()):
                    return self.send_error(404)
            if not f.is_file():
                return self.send_error(404)
            return self.file(f)
        except KeyError:
            self.json({"error": "未找到记录"}, 404)
        except (ValueError, RuntimeError) as exc:
            self.json({"error": str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def file(self, path, mime=None):
        if not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        try:
            start, end, partial = range_bounds(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        mime = mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix in (".js", ".mjs"):
            mime = "text/javascript"
        self.response_headers(206 if partial else 200, mime, end - start + 1)
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                block = f.read(min(65536, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def do_POST(self):
        if not self.check_host():
            return
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{h}" for h in ALLOWED_HOSTS}:
            return self.json({"error": "不允许的来源"}, 403)
        if not secrets.compare_digest(self.headers.get("X-Paper-Token", ""), TOKEN):
            return self.json({"error": "请刷新页面后重试"}, 403)
        if self.headers.get_content_type() != "application/json":
            return self.json({"error": "需要 JSON"}, 415)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or length > 1000000:
                return self.json({"error": "请求过大"}, 413)
            data = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("无效请求")
            path = urlparse(self.path).path
            if path == "/api/settings":
                return self.json(settings.save(data))
            if path == "/api/harness/connect":
                return self.json(harness.capabilities())
            if path == "/api/harness/sessions":
                return self.json(harness.create(data), 201)
            m = re.fullmatch(r"/api/harness/sessions/([a-f0-9]+)/(turn|interrupt|respond)", path)
            if m:
                operation = {"turn": harness.start, "respond": harness.respond,
                             "interrupt": lambda uid, _: harness.interrupt(uid)}[m[2]]
                return self.json(operation(m[1], data))
            if path == "/api/domains":
                return self.json(domain_scan.save_domain(data))
            if path == '/api/domain-scans':
                return self.json(domain_scan.start(data.get('domain_ids')), 202)
            m = re.fullmatch(r'/api/domains/([a-zA-Z0-9]+)/scan', path)
            if m:
                return self.json(domain_scan.start([m[1]]), 202)
            m = re.fullmatch(r'/api/papers/([a-zA-Z0-9]+)/domains/([a-zA-Z0-9]+)/exclude', path)
            if m:
                return self.json(taxonomy.exclude(m[1], m[2]))
            m = re.fullmatch(r'/api/papers/([a-zA-Z0-9]+)/domains/([a-zA-Z0-9]+)/include', path)
            if m:
                return self.json(taxonomy.include(m[1], m[2]))
            if path == "/api/global-chat":
                return self.json(global_chat.start(data), 202)
            m = re.fullmatch(r"/api/papers/([a-zA-Z0-9]+)/domain", path)
            if m:
                return self.json(taxonomy.assign(m[1], data.get('domain_id'), data.get('memberships')))
            if path == "/api/jobs":
                return self.json(jobs.create(data.get("kind"), data.get("query")), 202)
            if path == "/api/imports":
                return self.json(jobs.create_many(data.get('query')), 202)
            if path == "/api/collections":
                return self.json(collections_store.save(data), 201)
            m = re.fullmatch(r"/api/collections/([a-f0-9]+)", path)
            if m:
                return self.json(collections_store.save(data, m[1]))
            m = re.fullmatch(r"/api/papers/([a-zA-Z0-9]+)/(?P<action>collections|chat)", path)
            if m:
                if m["action"] == "chat":
                    return self.json(conversation.start(m[1], data), 202)
                return self.json(collections_store.assign(m[1], data.get("ids")))
            if path.startswith("/api/reading/"):
                return self.json(lib.save_reading(path.split("/")[-1], data))
            if path == "/api/refresh":
                return self.json(lib.refresh())
            m = re.fullmatch(r"/api/jobs/([a-f0-9]+)/(?P<action>cancel|retry)", path)
            if m:
                return self.json(jobs.cancel(m[1]) if m["action"] == "cancel" else jobs.retry(m[1]))
            self.json({"error": "未知操作"}, 404)
        except (ValueError, TypeError, RuntimeError, OSError) as exc:
            self.json({"error": str(exc)}, 400)
        except KeyError:
            self.json({"error": "未找到记录"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    global PORT, ALLOWED_HOSTS
    import migration
    migration.migrate()
    lib.init_db()
    print("Index:", lib.refresh(), flush=True)
    jobs.recover()
    if DESKTOP_TOKEN:
        def private_input():
            for line in sys.stdin:
                try:
                    value = json.loads(line)
                    if isinstance(value.get('api_key'), str):
                        os.environ['PAPER_API_KEY'] = value['api_key']
                except (ValueError, AttributeError):
                    pass
        threading.Thread(target=private_input, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    PORT = server.server_address[1]
    ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
    print(json.dumps({"ready": True, "port": PORT}), flush=True)
    def terminate(signum, frame):
        harness.shutdown()
        for uid, proc in list(jobs.PROCESSES.items()):
            jobs.CANCELLED.add(uid)
            jobs.stop_process(proc)
        # The OS is stopping the backend; durable running jobs recover as interrupted.
        os._exit(0)
    signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        harness.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
