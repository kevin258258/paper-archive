"""Persistent, streaming Codex threads. Structured import/search jobs remain separate."""
import copy
import json
import shutil
import threading
import time
import uuid
from pathlib import Path

import library as lib
import paper_tools
import settings
from codex_rpc import CodexRPC

LOCK = threading.RLock()
CONNECT_LOCK = threading.Lock()
SESSIONS = {}
PENDING = {}
RPC = None
CAPABILITIES = None
LOADED = set()
BUSY = {"starting", "running", "waiting"}


def initialize():
    with lib.db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS harness_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)")


def _load(uid):
    if uid not in SESSIONS:
        with lib.db() as c:
            row = c.execute("SELECT data FROM harness_sessions WHERE id=?", (uid,)).fetchone()
        if not row:
            raise KeyError(uid)
        session = json.loads(row["data"])
        if session["status"] in BUSY:
            session["status"] = "interrupted"
            session["error"] = "应用关闭时回答中断。发送下一条消息将恢复同一个 Codex 会话。"
            session["requests"] = []
            if session["turns"]:
                session["turns"][-1]["status"] = "interrupted"
            _save(session)
        SESSIONS[uid] = session
    return SESSIONS[uid]


def _save(s, durable=True):
    s["revision"] = s.get("revision", 0) + 1
    s["updated"] = time.time()
    # Stream in memory; persist at most once per second and at item/turn boundaries.
    if durable or s["updated"] - s.get("_saved", 0) > 1:
        s["_saved"] = s["updated"]
        with lib.db() as c:
            c.execute("INSERT OR REPLACE INTO harness_sessions VALUES (?,?)",
                      (s["id"], json.dumps(s, ensure_ascii=False)))


def snapshot(uid, revision=None):
    with LOCK:
        s = _load(uid)
        if str(s["revision"]) == revision:
            return {"id": uid, "revision": s["revision"], "unchanged": True}
        return copy.deepcopy(s)


def listing(kind, paper_id=""):
    if kind not in ("paper", "library", "import", "domain", "intake"):
        raise ValueError("无效的会话类型")
    with LOCK, lib.db() as c:
        ids = [r["id"] for r in c.execute("SELECT id FROM harness_sessions")]
        rows = [_load(uid) for uid in ids]
        return [{k: s.get(k) for k in ("id", "thread_id", "title", "kind", "paper_id", "scope",
                                     "status", "model", "effort", "updated")}
                for s in sorted(rows, key=lambda x: x["updated"], reverse=True)
                if s["kind"] == kind and (kind != "paper" or s["paper_id"] == paper_id)]


def create(data):
    kind = data.get("kind", "library")
    ids = data.get("paper_ids", [])
    paper_id = data.get("paper_id", "")
    known = {p["id"] for p in lib.papers()}
    if kind == "paper":
        if paper_id not in known:
            raise ValueError("未找到论文")
        ids = [paper_id]
    elif kind != "library":
        raise ValueError("无效会话类型")
    if not isinstance(ids, list) or len(ids) > 10000 or any(not isinstance(i, str) or i not in known for i in ids):
        raise ValueError("无效论文范围")
    if not known:
        raise ValueError("先添加论文再开始讨论")
    s = dict(id=uuid.uuid4().hex, thread_id=None, kind=kind, paper_id=paper_id,
             paper_ids=list(dict.fromkeys(ids)), scope=str(data.get("scope", "全部藏品"))[:100],
             title="新对话", status="idle", model="", effort="", turns=[], requests=[],
             error="", revision=0, updated=time.time(), cancel_requested=False)
    with LOCK:
        SESSIONS[s["id"]] = s
        _save(s)
    return snapshot(s["id"])


def create_import(arxiv, job_id):
    arxiv = lib.parse_arxiv(arxiv)
    config = settings.read()
    skill = Path(config['import_skill']) if config['import_skill'] else lib.BASE / 'skills/arxiv-translate/SKILL.md'
    if not skill.is_file():
        raise ValueError('未找到入库 Skill：' + str(skill))
    with LOCK:
        for row in listing('import'):
            old = _load(row['id'])
            if old.get('arxiv') == arxiv:
                if old['status'] in BUSY:
                    raise ValueError('这篇论文的 Codex 入库会话仍在运行')
                old.update(job_id=job_id, skill_path=str(skill))
                _save(old)
                return snapshot(old['id'])
        uid = uuid.uuid4().hex
        s = dict(id=uid, thread_id=None, kind='import', paper_id='', paper_ids=[], arxiv=arxiv,
                 scope='arXiv ' + arxiv, title='翻译入库 · ' + arxiv, status='idle',
                 model=config['import_model'], effort=config['import_effort'], turns=[], requests=[],
                 error='', revision=0, updated=time.time(), cancel_requested=False,
                 job_id=job_id, skill_path=str(skill))
        SESSIONS[uid] = s
        _save(s)
    return snapshot(uid)


def executable():
    configured = settings.read().get("codex_path", "").strip()
    path = configured or shutil.which("codex")
    if not path or not Path(path).is_file():
        raise ValueError("未找到 Codex。请安装并运行 codex login，或在设置中指定可执行文件。")
    return str(path)


def connect():
    global RPC, CAPABILITIES
    with CONNECT_LOCK:
        if RPC is None or RPC.closed:
            RPC = CodexRPC(executable(), str(lib.ROOT), notification, server_request, disconnected)
            CAPABILITIES = None
        return RPC


def capabilities():
    global CAPABILITIES
    rpc = connect()
    if CAPABILITIES is None:
        models, cursor = [], None
        while True:
            result = rpc.call("model/list", {"limit": 100, "cursor": cursor})
            models.extend(result["data"])
            cursor = result.get("nextCursor")
            if not cursor:
                break
        config = rpc.call("config/read", {"includeLayers": False, "cwd": str(lib.ROOT)})["config"]
        # Never expose the full config: it can contain provider credentials or private URLs.
        CAPABILITIES = {"models": models, "default_model": config.get("model") or "",
                        "default_effort": config.get("model_reasoning_effort") or "",
                        "executable": executable(), "transport": "app-server"}
    return copy.deepcopy(CAPABILITIES)


def preferences(data):
    caps = capabilities()
    chosen = data.get("model") or settings.read()["model"] or caps["default_model"]
    model = next((m for m in caps["models"] if m["model"] == chosen), None)
    if not model:
        if chosen:
            raise ValueError("此模型不在本机 Codex 的模型列表中；请刷新后选择")
        model = next((m for m in caps["models"] if m.get("isDefault")), caps["models"][0])
    effort = data.get("effort") or caps["default_effort"] or model["defaultReasoningEffort"]
    supported = [v["reasoningEffort"] for v in model["supportedReasoningEfforts"]]
    if effort not in supported:
        if data.get("effort"):
            raise ValueError("所选模型不支持这个推理强度")
        effort = model["defaultReasoningEffort"]
    return model["model"], effort


def start(uid, data):
    question = data.get("question")
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 100000:
        raise ValueError("请输入问题（最多 100000 字）")
    initial = snapshot(uid)
    if initial['kind'] in ('import', 'domain', 'intake'):
        config = settings.read()
        data = {**data, 'model': data.get('model') or config['import_model'],
                'effort': data.get('effort') or config['import_effort']}
    model, effort = preferences(data)
    context = data.get("context") or {}
    if not isinstance(context, dict):
        raise ValueError("无效阅读上下文")
    selection = context.get("selection", "")
    if not isinstance(selection, str) or len(selection) > 20000:
        raise ValueError("选文过长")
    page = context.get("page", 1)
    if type(page) is not int or page < 1:
        raise ValueError("无效页码")
    language = context.get("language", "original")
    if language not in ("original", "chinese"):
        raise ValueError("无效语言")
    with LOCK:
        s = _load(uid)
        if s["status"] in BUSY:
            raise ValueError("当前回答尚未完成，可以先停止")
        s.update(status="starting", error="", model=model, effort=effort, requests=[], cancel_requested=False)
        turn = {"id": uuid.uuid4().hex, "native_id": None, "question": question if initial['kind'] == 'intake' else question.strip(),
                "context": {"page": page, "language": language, "selection": selection},
                "items": [], "status": "starting", "model": model, "effort": effort}
        s["turns"].append(turn)
        if len(s["turns"]) == 1 and s['kind'] != 'domain':
            s["title"] = ('翻译入库 · ' + s['arxiv']) if s['kind'] == 'import' else question.strip()[:70]
        _save(s)
    threading.Thread(target=_start, args=(uid,), daemon=True).start()
    return snapshot(uid)


def _start(uid):
    try:
        rpc = connect()
        with LOCK:
            s = copy.deepcopy(_load(uid))
        common = {"cwd": str(lib.ROOT), "model": s["model"], "sandbox": "read-only",
                  "approvalPolicy": "on-request", "approvalsReviewer": "user"}
        importing = s['kind'] == 'import'
        scanning = s['kind'] == 'domain'
        collecting = s['kind'] == 'intake'
        if collecting:
            import intake
        if scanning:
            import domain_scan
        if importing:
            import agent_import
            import agent_import_tools
            if s.get('source_type') == 'blog':
                import blog_import
                agent_import = blog_import
                agent_import_tools = blog_import
            common['sandbox'] = 'workspace-write'
        if not s["thread_id"]:
            result = rpc.call("thread/start", {**common, "ephemeral": False,
                              "developerInstructions": intake.INSTRUCTIONS if collecting else agent_import.INSTRUCTIONS if importing else domain_scan.INSTRUCTIONS if scanning else paper_tools.INSTRUCTIONS,
                              "dynamicTools": intake.TOOLS if collecting else agent_import_tools.TOOLS if importing else domain_scan.TOOLS if scanning else paper_tools.TOOLS})
            with LOCK:
                _load(uid)["thread_id"] = result["thread"]["id"]
                _save(_load(uid))
            s["thread_id"] = result["thread"]["id"]
            LOADED.add(s["thread_id"])
        elif s["thread_id"] not in LOADED:
            # Resume is mandatory. An unavailable thread must never silently become a new one.
            rpc.call("thread/resume", {**common, "threadId": s["thread_id"]})
            LOADED.add(s["thread_id"])
        with LOCK:
            current = _load(uid)
            if current["cancel_requested"]:
                current["status"] = current["turns"][-1]["status"] = "interrupted"
                # A newly created thread has no rollout until its first submitted turn.
                # Discard only this known-empty native handle; never replace real history.
                if not any(t.get("native_id") for t in current["turns"]):
                    LOADED.discard(current["thread_id"])
                    current["thread_id"] = None
                _save(current)
                return
        turn = s["turns"][-1]
        resources = []
        if s["kind"] == "paper":
            paper = lib.paper(s["paper_id"])
            resources = [{"paper_id": paper["id"], "title": paper["record"]["title"],
                          "source_type": paper["record"].get("sourceType", "paper"),
                          "complete_files": {k: v for k, v in paper["files"].items() if k in ("original", "chinese", "article")}}]
        context = {"scope": s["scope"], "paper_ids": s["paper_ids"], "complete_pdf_resources": resources,
                   "reader": turn["context"]}
        if importing:
            context.update(arxiv=s['arxiv'], vault=str(lib.ROOT), import_job=s.get('job_id'))
        # Context is supplied independently of the displayed question, without injecting
        # extracted snippets, shortened answers or a structured-output schema.
        inputs = [{"type": "text", "text": turn["question"]}]
        if importing:
            inputs.append({'type': 'skill', 'name': 'blog-translate' if s.get('source_type') == 'blog' else 'arxiv-translate', 'path': s['skill_path']})
        if collecting:
            inputs.append({'type': 'skill', 'name': 'collect-sources', 'path': s['skill_path']})
        result = rpc.call("turn/start", {"threadId": s["thread_id"], "input": inputs,
                          "additionalContext": {"paper_archive": {
                              "kind": "untrusted", "value": json.dumps(context, ensure_ascii=False)}},
                          "model": s["model"], "effort": s["effort"], "summary": "auto"})
        native_id = result["turn"]["id"]
        with LOCK:
            current = _load(uid)
            current["turns"][-1]["native_id"] = native_id
            if current["status"] == "starting":
                current["status"] = current["turns"][-1]["status"] = "running"
            cancelled = current["cancel_requested"]
            _save(current)
        if cancelled:
            rpc.call("turn/interrupt", {"threadId": s["thread_id"], "turnId": native_id})
    except Exception as e:
        with LOCK:
            s = _load(uid)
            s["status"] = s["turns"][-1]["status"] = "failed"
            s["error"] = str(e)
            s["turns"][-1]["error"] = str(e)
            _save(s)


def _by_thread(thread_id):
    return next((s for s in SESSIONS.values() if s["thread_id"] == thread_id), None)


def safe_item(item):
    """Keep rendered summaries, not private raw reasoning or image/base64 payloads."""
    keys = ("id", "type", "text", "phase", "summary", "command", "status", "tool",
            "server", "arguments", "aggregatedOutput", "exitCode", "changes", "plan")
    result = {k: item[k] for k in keys if k in item}
    if "aggregatedOutput" in result and result["aggregatedOutput"]:
        result["aggregatedOutput"] = result["aggregatedOutput"][-30000:]
    if item.get('tool') in ('archive_compile_translation', 'archive_check_translation', 'archive_finish_import', 'archive_domain_record', 'archive_domain_finish'):
        result['outputText'] = '\n'.join(c.get('text', '') for c in (item.get('contentItems') or [])
                                       if c.get('type') == 'inputText')[-20000:]
    return result


def notification(method, params):
    with LOCK:
        s = _by_thread(params.get("threadId"))
        if not s or not s["turns"]:
            return
        turn = s["turns"][-1]
        if method == "turn/started":
            turn["native_id"] = params["turn"]["id"]
            turn["status"] = s["status"] = "running"
        elif method == "turn/completed":
            native = params["turn"]
            if turn.get("native_id") and turn["native_id"] != native["id"]:
                return
            turn["status"] = s["status"] = native["status"]
            s["error"] = (native.get("error") or {}).get("message", "")
            turn["error"] = s["error"]
            _clear_requests(s)
        elif method in ("item/started", "item/completed"):
            item = safe_item(params["item"])
            if item["type"] == "userMessage":
                return
            prior = next((i for i in turn["items"] if i["id"] == item["id"]), None)
            if prior is None:
                turn["items"].append(item)
            else:
                prior.update(item)
        elif method in ("item/agentMessage/delta", "item/reasoning/summaryTextDelta",
                        "item/commandExecution/outputDelta", "item/plan/delta"):
            ident = params["itemId"]
            item = next((i for i in turn["items"] if i["id"] == ident), None)
            kind, field = {
                "item/agentMessage/delta": ("agentMessage", "text"),
                "item/reasoning/summaryTextDelta": ("reasoning", "summaryText"),
                "item/commandExecution/outputDelta": ("commandExecution", "aggregatedOutput"),
                "item/plan/delta": ("plan", "text"),
            }[method]
            if item is None:
                item = {"id": ident, "type": kind}
                turn["items"].append(item)
            item[field] = (item.get(field) or "") + (params.get("delta") or "")
            if field == "aggregatedOutput":
                item[field] = item[field][-30000:]
        elif method == "thread/tokenUsage/updated":
            s["usage"] = params.get("tokenUsage")
        elif method == "error":
            s["error"] = params.get("error", {}).get("message", "Codex 错误")
        elif method == "serverRequest/resolved":
            rid = params.get("requestId")
            s["requests"] = [r for r in s["requests"] if r["rpc_id"] != rid]
            if not s["requests"] and s["status"] == "waiting":
                s["status"] = "running"
        else:
            return
        _save(s, durable=not method.endswith(("Delta", "/delta")))


def _clear_requests(s):
    for request in s["requests"]:
        PENDING.pop(request["id"], None)
    s["requests"] = []


def server_request(rpc, message):
    method, params, rpc_id = message["method"], message.get("params", {}), message["id"]
    with LOCK:
        session = _by_thread(params.get("threadId"))
        s = copy.deepcopy(session) if session else None
    if method == "item/tool/call" and s:
        try:
            if s['kind'] == 'intake':
                import intake
                result = intake.execute(s, params['tool'], params.get('arguments', {}))
            elif s['kind'] == 'import':
                import agent_import_tools
                if s.get('source_type') == 'blog':
                    import blog_import
                    agent_import_tools = blog_import
                result = agent_import_tools.execute(s, params['tool'], params.get('arguments', {}))
            elif s['kind'] == 'domain':
                import domain_scan
                result = domain_scan.execute(s, params['tool'], params.get('arguments', {}))
            else:
                result = paper_tools.execute(s, params["tool"], params.get("arguments", {}))
        except Exception as exc:
            result = {"success": False, "contentItems": [{"type": "inputText", "text": str(exc)}]}
        rpc.send({"id": rpc_id, "result": result})
        return
    supported = ("item/commandExecution/requestApproval", "item/fileChange/requestApproval",
                 "item/permissions/requestApproval", "item/tool/requestUserInput", "tool/requestUserInput")
    if s and method in supported:
        request_id = uuid.uuid4().hex
        with LOCK:
            s = _load(s["id"])
            if s["status"] not in BUSY or s["cancel_requested"]:
                rpc.send({"id": rpc_id, "error": {"code": -32000, "message": "Turn is no longer active"}})
                return
            request = {"id": request_id, "rpc_id": rpc_id, "method": method, "params": params}
            PENDING[request_id] = (rpc, rpc_id, method, s["id"])
            s["requests"].append(request)
            s["status"] = "waiting"
            _save(s)
        return
    if method == "mcpServer/elicitation/request":
        rpc.send({"id": rpc_id, "result": {"action": "decline", "content": None}})
    else:
        rpc.send({"id": rpc_id, "error": {"code": -32601, "message": "Paper Archive does not support " + method}})
    if s:
        with LOCK:
            session = _load(s["id"])
            session["error"] = "此交互暂未支持：" + method + "。请求已拒绝，可以在 Codex CLI 中继续此会话。"
            _save(session)


def respond(uid, data):
    with LOCK:
        s = _load(uid)
        entry = PENDING.get(data.get("request_id"))
        request = next((r for r in s["requests"] if r["id"] == data.get("request_id")), None)
        if not entry or entry[3] != uid or not request:
            raise ValueError("这个请求已结束")
        rpc, rpc_id, method, _ = entry
        if method.endswith("requestUserInput"):
            answers = data.get("answers")
            if not isinstance(answers, dict):
                raise ValueError("请填写回答")
            result = {"answers": {}}
            for question in request["params"]["questions"]:
                answer = answers.get(question["id"])
                if not isinstance(answer, str) or not answer.strip() or len(answer) > 10000:
                    raise ValueError("请回答每个问题")
                result["answers"][question["id"]] = {"answers": [answer.strip()]}
        elif method == "item/permissions/requestApproval":
            if data.get("decision") not in ("accept", "decline"):
                raise ValueError("无效审批决定")
            result = {"permissions": request["params"].get("permissions", {}) if data["decision"] == "accept" else {},
                      "scope": "turn"}
        else:
            decision = data.get("decision")
            if decision not in ("accept", "decline"):
                raise ValueError("无效审批决定")
            result = {"decision": decision}
        rpc.send({"id": rpc_id, "result": result})
        PENDING.pop(data["request_id"], None)
        s["requests"] = [r for r in s["requests"] if r["id"] != data["request_id"]]
        if not s["requests"]:
            s["status"] = "running"
        _save(s)
    return snapshot(uid)


def interrupt(uid):
    with LOCK:
        s = _load(uid)
        if s["status"] not in BUSY:
            return copy.deepcopy(s)
        s["cancel_requested"] = True
        thread_id, turn_id = s["thread_id"], s["turns"][-1].get("native_id")
        _save(s)
    if turn_id:
        connect().call("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
    return snapshot(uid)


def disconnected():
    global CAPABILITIES
    with LOCK:
        LOADED.clear()
        PENDING.clear()
        CAPABILITIES = None
        for s in SESSIONS.values():
            if s["status"] in BUSY:
                s["status"] = s["turns"][-1]["status"] = "interrupted"
                s["requests"] = []
                s["error"] = "本机 Codex 连接断开。发送下一条消息可恢复同一个会话。"
                _save(s)


def active():
    with LOCK:
        return any(s["status"] in BUSY for s in SESSIONS.values())


def shutdown():
    if RPC:
        RPC.close()


def reconfigure():
    global RPC, CAPABILITIES
    if active():
        raise ValueError("请等当前 Codex 回答结束或停止后再切换 harness")
    shutdown()
    RPC = CAPABILITIES = None
