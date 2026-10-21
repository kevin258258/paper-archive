"""Local library index. Original paper packages remain the source of truth."""
from pathlib import Path
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time

import fitz
import yaml

BASE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("PAPER_VAULT_ROOT", Path.home() / "Documents/Paper Archive")).resolve()
STATE = Path(os.environ.get("PAPER_READER_STATE", ROOT / ".paper-archive/state"))
STATE.mkdir(parents=True, exist_ok=True)
PDF_LOCK = threading.RLock()
INDEX_LOCK = threading.Lock()
NOTE_NAMES = {
    "insight": ("精简 Insight", "Agent-精简Insight.md"),
    "method": ("核心方法", "Agent-核心方法.md"),
    "guide": ("详细导读", "Agent-详细导读.md"),
    "audit": ("关联与 Novelty", "Agent-关联与Novelty审判.md"),
}


@contextmanager
def db():
    conn = sqlite3.connect(STATE / "library.sqlite3", timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript("""
        CREATE TABLE IF NOT EXISTS papers (
          id TEXT PRIMARY KEY, record TEXT NOT NULL, files TEXT NOT NULL,
          evidence TEXT NOT NULL, fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reading (
          id TEXT PRIMARY KEY, data TEXT NOT NULL, updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
          query TEXT NOT NULL, stage TEXT NOT NULL, result TEXT, error TEXT,
          created REAL NOT NULL, updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          job TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message TEXT NOT NULL, created REAL NOT NULL);
        """)
    import collections_store
    import conversation
    collections_store.initialize()
    import waiting_list
    waiting_list.initialize()
    conversation.initialize()
    import global_chat
    global_chat.initialize()
    import harness
    harness.initialize()


def parse_arxiv(raw):
    raw = raw.strip()
    if raw.startswith(("http://", "https://")):
        from urllib.parse import urlparse
        u = urlparse(raw)
        if u.hostname not in ("arxiv.org", "www.arxiv.org", "export.arxiv.org"):
            raise ValueError("请输入 arxiv.org 的论文链接或 arXiv 编号")
        raw = re.sub(r"^/(abs|pdf|html)/", "", u.path).removesuffix(".pdf")
    raw = re.sub(r"^arxiv:\s*", "", raw, flags=re.I)
    if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[a-zA-Z.-]+/\d{7})(?:v[1-9]\d*)?", raw):
        raise ValueError("无法识别 arXiv 编号")
    return raw


def arxiv_base(value):
    try:
        return re.sub(r"v\d+$", "", parse_arxiv(value))
    except ValueError:
        return ""


def parse_arxiv_many(raw):
    """Validate the complete paste before creating any import jobs."""
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 32000:
        raise ValueError('请输入 arXiv 链接或编号（最多 32000 字）')
    raw = re.sub(r'\[[^\]\n]*\]\((https?://[^\s)]+)\)', r'\1', raw)
    raw = re.sub(r'(?m)^\s*(?:[-*•]|\d+[.)、])\s+', '', raw)
    raw = re.sub(r'\barxiv:\s*', '', raw, flags=re.I)
    tokens = [part for part in re.split(r'[\s,，;；]+', raw.strip()) if part]
    result, seen = [], set()
    for n, token in enumerate(tokens, 1):
        token = token.strip('<>()[]"\'。').rstrip('.')
        if token.startswith(('arxiv.org/', 'www.arxiv.org/', 'export.arxiv.org/')):
            token = 'https://' + token
        try:
            arxiv = parse_arxiv(token)
        except ValueError:
            raise ValueError(f'第 {n} 项不是有效的 arXiv 链接或编号；请用换行或逗号分隔。主题收集需求请先在研究台查找候选。') from None
        key = arxiv_base(arxiv)
        if key not in seen:
            seen.add(key)
            result.append(arxiv)
        if len(result) > 50:
            raise ValueError('一次最多添加 50 篇不同论文，请分批提交')
    if not result:
        raise ValueError('请输入至少一个 arXiv 链接或编号')
    return result


def stable_id(arxiv, relative):
    return hashlib.sha256((arxiv_base(arxiv) or relative).encode()).hexdigest()[:20]


def parse_sources(raw):
    """Validate an entire mixed arXiv / public article paste before submission."""
    from web_sources import normalize_url
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 32000:
        raise ValueError('请输入链接或 arXiv 编号（最多 32000 字）')
    raw = re.sub(r'\[[^\]\n]*\]\((https?://[^\s)]+)\)', r'\1', raw)
    raw = re.sub(r'(?m)^\s*(?:[-*•]|\d+[.)、])\s+', '', raw)
    raw = re.sub(r'\barxiv:\s*', '', raw, flags=re.I)
    tokens = re.split(r'[\s，；;]+|,(?=\s*(?:https?://|\d{4}\.))', raw.strip())
    result, seen = [], set()
    for token in tokens:
        token = token.strip('<>()[]"\'。,')
        if not token: continue
        if token.startswith(('arxiv.org/', 'www.arxiv.org/', 'export.arxiv.org/')): token = 'https://' + token
        try:
            value = parse_arxiv(token)
            kind, key = 'import', 'arxiv:' + arxiv_base(value)
        except ValueError:
            value = normalize_url(token)
            from urllib.parse import urlsplit
            if urlsplit(value).hostname in ('arxiv.org', 'www.arxiv.org', 'export.arxiv.org'):
                raise ValueError('无效的 arXiv 论文链接')
            kind, key = 'blog', value
        if key not in seen:
            seen.add(key)
            result.append((kind, value))
        if len(result) > 50: raise ValueError('一次最多添加 50 篇，请分批提交')
    if not result: raise ValueError('请输入至少一个链接或编号')
    return result


def frontmatter(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    return (yaml.safe_load(m[1]) or {}) if m else {}


def refresh():
    with INDEX_LOCK:
        return _refresh()


def _refresh():
    warnings, seen, records = [], set(), []
    with db() as c:
        old = {r["id"]: r["fingerprint"] for r in c.execute("SELECT id,fingerprint FROM papers")}
    for card in sorted((ROOT / "10-领域").glob("*/*/00-论文卡片.md")):
        folder, domain = card.parent, card.parent.parent
        try:
            props = frontmatter(card)
            metadata = folder / "metadata.json"
            meta = json.loads(metadata.read_text()) if metadata.exists() else {}
            arxiv = str(meta.get("arxiv_id") or props.get("arxiv_id") or "")
            is_blog = meta.get('source_type') == 'blog'
            uid = meta['id'] if is_blog else stable_id(arxiv, str(folder.relative_to(ROOT)))
            if uid in seen:
                warnings.append(f"重复编号：{arxiv}")
                continue
            seen.add(uid)
            pdfs = sorted(folder.glob("*.pdf"))
            chinese = next((p for p in pdfs if re.search(r"中文|译文", p.name)), None)
            original = next((p for p in pdfs if not re.search(r"中文|译文", p.name)), None)
            source_files = [card] + ([metadata] if metadata.exists() else []) + pdfs
            if is_blog:
                source_files += [folder / n for n in ('article.json', 'original.md', 'chinese.md') if (folder / n).exists()]
            source_files += [folder / n[1] for n in NOTE_NAMES.values() if (folder / n[1]).exists()]
            fingerprint = hashlib.sha256("|".join(f"{p}:{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in source_files).encode()).hexdigest()
            if old.get(uid) == fingerprint:
                records.append(uid)
                continue
            aliases = props.get("aliases") or []
            if isinstance(aliases, str):
                aliases = [aliases]
            english = meta.get("title") or next((str(a) for a in aliases if re.search("[A-Za-z]{4}", str(a))), "")
            title = str(props.get("title") or meta.get("chinese_title") or folder.name)
            authors = meta.get("authors") or props.get("authors") or []
            if not isinstance(authors, list):
                authors = [str(authors)]
            authors = [str(a) for a in authors]
            notes = []
            for key, (label, name) in NOTE_NAMES.items():
                f = folder / name
                if f.exists():
                    text = re.sub(r"^---\n.*?\n---\n", "", f.read_text(), flags=re.S)
                    notes.append({"key": key, "label": label, "text": text})
            summary = ""
            if notes:
                m = re.search(r"## 一句话判断\s+(.+?)(?=\n\n|\n##|$)", notes[0]["text"], re.S)
                summary = m[1].strip() if m else ""
            year = props.get("year")
            if not year and re.match(r"^\d{4}\.", arxiv_base(arxiv)):
                year = 2000 + int(arxiv_base(arxiv)[:2])
            topics = []
            haystack = f"{title} {english} {props.get('tags', '')}"
            for label, pattern in [
                ("模型增长", r"增长|生长|扩展|堆叠|stack|grow|warmstart"),
                ("循环与推理", r"循环|潜在|推理|loop|reason|recurr"),
                ("强化学习", r"强化学习|奖励|reinforcement"),
                ("多模态", r"多模态|视觉|multimodal|vision|\bvl\b|vlm"),
                ("智能体", r"智能体|agent"), ("蒸馏", r"蒸馏|distill"),
                ("技术报告", r"技术报告|technical report|kimi|qwen|glm|sensenova"),
                ("评测", r"评测|基准|污染|审计|evaluat|benchmark")]:
                if re.search(pattern, haystack, re.I):
                    topics.append(label)
            files = {"card": str(card)}
            pages, evidence = {}, ""
            if is_blog:
                article = json.loads((folder / 'article.json').read_text())
                files['article'] = str(folder / 'article.json')
                original, chinese = folder / 'original.md', folder / 'chinese.md'
                files.update(original=str(original), chinese=str(chinese))
                pages = {'original': len(article['blocks']), 'chinese': len(article['blocks'])}
                evidence = '\n\n'.join(b['original'] for b in article['blocks'])
                if (not article.get('completed') and not article.get('repair_in_progress')) or not original.exists() or not chinese.exists():
                    raise ValueError('文章翻译包尚未完成')
            for key, f in (("original", original), ("chinese", chinese)):
                if not f or is_blog:
                    continue
                files[key] = str(f)
                with PDF_LOCK, fitz.open(f) as pdf:
                    pages[key] = len(pdf)
                    if key == "original":
                        evidence = "\n".join(pdf[i].get_text() for i in range(min(2, len(pdf))))[:11000]
                        out = STATE / "assets" / (uid + ".png")
                        out.parent.mkdir(parents=True, exist_ok=True)
                        page = pdf[0]
                        r = page.rect
                        page.get_pixmap(matrix=fitz.Matrix(.65, .65), colorspace=fitz.csGRAY,
                                        clip=fitz.Rect(r.width*.09, r.height*.07, r.width*.91, r.height*.92)).save(out)
            record = dict(id=uid, title=title, english=english, arxiv=arxiv, year=year,
                          authors=authors, domain=domain.name.split("-")[0],
                          domainName=domain.name.partition("-")[2] or domain.name, topics=topics,
                          summary=summary, abstract=meta.get("abstract") or "",
                          notes=notes, human=str(props.get("human_status") or "未读"),
                          created=str(props.get("created") or meta.get("downloaded") or ""),
                          original=bool(original), chinese=bool(chinese), pages=pages,
                          thumb=f"/assets/{uid}.png" if original else None)
            record.update(sourceType='blog' if is_blog else 'paper',
                          sourceUrl=meta.get('source_url', '') if is_blog else ('https://arxiv.org/abs/' + arxiv if arxiv else ''),
                          sourceUrls=meta.get('source_urls', []), site=meta.get('site', ''),
                          relatedArxiv=meta.get('related_arxiv', []))
            if is_blog:
                record['thumb'] = None
                record['summary'] = record['summary'] or meta.get('classification_reason', '')
            with db() as c:
                c.execute("INSERT OR REPLACE INTO papers VALUES(?,?,?,?,?)",
                          (uid, json.dumps(record, ensure_ascii=False), json.dumps(files, ensure_ascii=False), evidence, fingerprint))
            records.append(uid)
        except (OSError, ValueError, RuntimeError, yaml.YAMLError) as exc:
            warnings.append(f"{folder.name}：{type(exc).__name__}")
    # Never purge persisted reading notes when a file is temporarily absent.
    with db() as c:
        if records:
            c.execute("DELETE FROM papers WHERE id NOT IN (" + ",".join("?" * len(records)) + ")", records)
    return {"count": len(records), "warnings": warnings}


def papers():
    with db() as c:
        import taxonomy
        registry = taxonomy.read()
        return [taxonomy.apply(json.loads(r[0]), registry) for r in c.execute("SELECT record FROM papers")]


def paper(uid):
    with db() as c:
        r = c.execute("SELECT * FROM papers WHERE id=?", (uid,)).fetchone()
    if not r:
        raise KeyError(uid)
    return {**dict(r), "record": __import__("taxonomy").apply(json.loads(r["record"])), "files": json.loads(r["files"])}


def find_arxiv(raw):
    key = arxiv_base(raw)
    return next((p for p in papers() if key and arxiv_base(p["arxiv"]) == key), None)


def all_reading():
    with db() as c:
        return {r["id"]: json.loads(r["data"]) for r in c.execute("SELECT * FROM reading")}


def save_reading(uid, patch):
    paper(uid)
    allowed = {"marked", "draft", "positions", "highlights", "language", "status"}
    if set(patch) - allowed:
        raise ValueError("未知阅读字段")
    if "draft" in patch and (not isinstance(patch["draft"], str) or len(patch["draft"]) > 200000):
        raise ValueError("笔记过长")
    if "marked" in patch and not isinstance(patch["marked"], bool):
        raise ValueError("无效选集状态")
    if 'status' in patch and patch['status'] not in ('未读', '在读', '已读'):
        raise ValueError('无效阅读状态')
    if "language" in patch and patch["language"] not in ("original", "chinese"):
        raise ValueError("无效语言")
    if "positions" in patch:
        positions = patch["positions"]
        if not isinstance(positions, dict) or set(positions) - {"original", "chinese"}:
            raise ValueError("无效阅读位置")
        for pos in positions.values():
            if not isinstance(pos, dict) or not isinstance(pos.get("page"), int) or not 1 <= pos["page"] <= 10000:
                raise ValueError("无效页码")
            if len(str(pos.get("hash", ""))) > 300 or len(str(pos.get("scale", ""))) > 30:
                raise ValueError("无效缩放")
    if "highlights" in patch:
        highlights = patch["highlights"]
        if not isinstance(highlights, list) or len(highlights) > 500:
            raise ValueError("摘录数量过多")
        for h in highlights:
            if not isinstance(h, dict) or not re.fullmatch(r"[a-f0-9-]{1,40}", str(h.get("id", ""))):
                raise ValueError("无效摘录")
            if h.get("language") not in ("chinese", "original") or not isinstance(h.get("page"), int):
                raise ValueError("无效摘录位置")
            if not 1 <= h["page"] <= 10000:
                raise ValueError("无效批注页码")
            if not isinstance(h.get("comment", ""), str) or len(h.get("comment", "")) > 20000:
                raise ValueError("批注过长")
            if not isinstance(h.get("text"), str) or len(h["text"]) > 15000:
                raise ValueError("无效摘录内容")
            if not isinstance(h.get("rects"), list) or len(h["rects"]) > 300:
                raise ValueError("无效摘录范围")
            for rect in h["rects"]:
                if not isinstance(rect, dict) or set(rect) != {"x", "y", "w", "h"} or any(
                    not isinstance(v, (int, float)) or not math.isfinite(v) or not -0.1 <= v <= 1.2 for v in rect.values()
                ):
                    raise ValueError("无效摘录坐标")
    if len(json.dumps(patch)) > 500000:
        raise ValueError("阅读数据过长")
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT data FROM reading WHERE id=?", (uid,)).fetchone()
        data = json.loads(row[0]) if row else {}
        data.update(patch)
        c.execute("INSERT OR REPLACE INTO reading VALUES(?,?,?)", (uid, json.dumps(data, ensure_ascii=False), time.time()))
        if data.get('status') == '已读':
            c.execute('DELETE FROM reading_queue WHERE paper_id=?', (uid,))
    return data


def search_catalog():
    with db() as c:
        rows = c.execute("SELECT id,record,evidence FROM papers").fetchall()
    import taxonomy
    registry = taxonomy.read()
    result = []
    for r in rows:
        p = taxonomy.apply(json.loads(r["record"]), registry)
        result.append(dict(id=p["id"], title=p["title"], english=p["english"], year=p["year"],
                           sourceType=p.get('sourceType', 'paper'), sourceUrl=p.get('sourceUrl', ''), site=p.get('site', ''),
                           domain=p["domainName"], domainName=p["domainName"], topics=p["topics"], authors=p["authors"][:8],
                           abstract=p["abstract"][:1600], insight=p["summary"][:500],
                           source_excerpt=r["evidence"][:2300]))
    return result
