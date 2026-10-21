"""User-owned, many-to-many paper collections, independent of vault taxonomy."""
import json
import time
import uuid

import library as lib


def initialize():
    with lib.db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
          created REAL NOT NULL, updated REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS collection_items (
          collection_id TEXT NOT NULL, paper_id TEXT NOT NULL,
          PRIMARY KEY(collection_id,paper_id));
        CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT);
        """)
        c.execute("BEGIN IMMEDIATE")
        if not c.execute("SELECT 1 FROM app_meta WHERE key='collections_migrated'").fetchone():
            marked = [r["id"] for r in c.execute("SELECT id,data FROM reading")
                      if json.loads(r["data"]).get("marked")]
            if marked:
                uid, now = uuid.uuid4().hex, time.time()
                c.execute("INSERT INTO collections VALUES(?,?,0,?,?)", (uid, "默认收藏", now, now))
                c.executemany("INSERT INTO collection_items VALUES(?,?)", [(uid, p) for p in marked])
            c.execute("INSERT INTO app_meta VALUES('collections_migrated','1')")


def listing():
    with lib.db() as c:
        return [dict(r, papers=[p[0] for p in c.execute(
            "SELECT paper_id FROM collection_items WHERE collection_id=?", (r["id"],))])
            for r in c.execute("SELECT * FROM collections ORDER BY created,id").fetchall()]


def save(data, uid=None):
    name = data.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name.strip()) > 60):
        raise ValueError("收藏集名称需为 1–60 字")
    if "archived" in data and not isinstance(data["archived"], bool):
        raise ValueError("无效归档状态")
    if set(data) - {"name", "archived"}:
        raise ValueError("无效收藏集字段")
    with lib.db() as c:
        c.execute("BEGIN IMMEDIATE")
        if uid:
            old = c.execute("SELECT * FROM collections WHERE id=?", (uid,)).fetchone()
            if not old:
                raise KeyError(uid)
            c.execute("UPDATE collections SET name=?,archived=?,updated=? WHERE id=?",
                      (name.strip() if name is not None else old["name"],
                       data.get("archived", old["archived"]), time.time(), uid))
        else:
            if name is None:
                raise ValueError("请输入收藏集名称")
            uid, now = uuid.uuid4().hex, time.time()
            c.execute("INSERT INTO collections VALUES(?,?,0,?,?)", (uid, name.strip(), now, now))
    return next(x for x in listing() if x["id"] == uid)


def assign(paper_id, ids):
    lib.paper(paper_id)
    if not isinstance(ids, list) or len(ids) > 500 or any(not isinstance(x, str) for x in ids):
        raise ValueError("无效收藏集")
    with lib.db() as c:
        c.execute("BEGIN IMMEDIATE")
        active = {r[0] for r in c.execute("SELECT id FROM collections WHERE archived=0")}
        if set(ids) - active:
            raise ValueError("收藏集不存在或已归档，请刷新")
        previous = {r[0] for r in c.execute('SELECT collection_id FROM collection_items WHERE paper_id=? AND collection_id IN (SELECT id FROM collections WHERE archived=0)', (paper_id,))}
        # Archived memberships are retained for restoration.
        c.execute("DELETE FROM collection_items WHERE paper_id=? AND collection_id IN "
                  "(SELECT id FROM collections WHERE archived=0)", (paper_id,))
        c.executemany("INSERT INTO collection_items VALUES(?,?)", [(i, paper_id) for i in set(ids)])
        if set(ids) - previous:
            import waiting_list
            waiting_list.enqueue(c, paper_id, 'collection')
    return {"collections": listing()}
