"""A persistent reading plan, independent of collections and domain membership."""
import json
import time
import library as lib


def initialize():
    with lib.db() as c:
        c.execute('CREATE TABLE IF NOT EXISTS reading_queue (paper_id TEXT PRIMARY KEY, added REAL NOT NULL, priority INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL)')
        c.execute('BEGIN IMMEDIATE')
        if not c.execute("SELECT 1 FROM app_meta WHERE key='reading_queue_migrated'").fetchone():
            ids = {r[0] for r in c.execute('SELECT i.paper_id FROM collection_items i JOIN collections c ON c.id=i.collection_id WHERE c.archived=0')}
            for paper_id in sorted(ids):
                enqueue(c, paper_id, 'collection')
            c.execute("INSERT INTO app_meta VALUES('reading_queue_migrated','1')")


def enqueue(c, paper_id, source='manual'):
    row = c.execute('SELECT data FROM reading WHERE id=?', (paper_id,)).fetchone()
    reading = json.loads(row[0]) if row else {}
    paper = c.execute('SELECT record FROM papers WHERE id=?', (paper_id,)).fetchone()
    status = reading.get('status') or (json.loads(paper[0]).get('human') if paper else '')
    if status in ('已读', '已读完', '读完'):
        if source == 'collection':
            return
        reading['status'] = '未读'
        c.execute('INSERT OR REPLACE INTO reading VALUES(?,?,?)', (paper_id, json.dumps(reading, ensure_ascii=False), time.time()))
    c.execute('INSERT OR IGNORE INTO reading_queue VALUES(?,?,0,?)', (paper_id, time.time(), source))


def listing():
    with lib.db() as c:
        return [dict(r) for r in c.execute('SELECT q.* FROM reading_queue q JOIN papers p ON p.id=q.paper_id ORDER BY priority DESC,added,paper_id')]


def change(paper_id, data):
    lib.paper(paper_id)
    action = data.get('action')
    if set(data) != {'action'} or action not in ('add', 'remove', 'pin', 'unpin'):
        raise ValueError('无效待读操作')
    with lib.db() as c:
        c.execute('BEGIN IMMEDIATE')
        if action == 'add':
            enqueue(c, paper_id)
        elif action == 'remove':
            c.execute('DELETE FROM reading_queue WHERE paper_id=?', (paper_id,))
        else:
            if not c.execute('SELECT 1 FROM reading_queue WHERE paper_id=?', (paper_id,)).fetchone():
                raise ValueError('论文尚未加入待读清单')
            c.execute('UPDATE reading_queue SET priority=? WHERE paper_id=?', (action == 'pin', paper_id))
    return {'items': listing(), 'reading': lib.all_reading()}
