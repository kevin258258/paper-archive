"""The browser-like reading workspace; positions remain in per-paper reading state."""
import json
import threading
import library as lib

LOCK=threading.Lock()


def read():
    with lib.db() as c:
        c.execute('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, data TEXT NOT NULL)')
        row=c.execute("SELECT data FROM app_state WHERE key='reader-tabs'").fetchone()
    return json.loads(row[0]) if row else {'tabs':[],'active':None}


def save(data):
    tabs=data.get('tabs');active=data.get('active')
    if not isinstance(tabs,list) or len(tabs)>1000 or any(not isinstance(x,str) for x in tabs): raise ValueError('无效阅读标签页')
    known={p['id'] for p in lib.papers()}
    if any(uid not in known for uid in tabs) or (active is not None and active not in tabs): raise ValueError('阅读标签页不在文献库中')
    value={'tabs':list(dict.fromkeys(tabs)),'active':active}
    with LOCK:
        read()
        with lib.db() as c:c.execute("INSERT OR REPLACE INTO app_state VALUES('reader-tabs',?)",(json.dumps(value),))
    return value


def draft(key, data=None):
    import attachments
    import re
    if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,200}',key): raise ValueError('无效草稿标识')
    read()
    if data is not None:
        text=data.get('text','');files=data.get('attachments',[])
        if not isinstance(text,str) or len(text)>100000: raise ValueError('草稿过长')
        value={'text':text,'attachments':attachments.select(files)}
        with lib.db() as c:c.execute('INSERT OR REPLACE INTO app_state VALUES(?,?)',('draft:'+key,json.dumps(value,ensure_ascii=False)))
        return value
    with lib.db() as c:row=c.execute('SELECT data FROM app_state WHERE key=?',('draft:'+key,)).fetchone()
    return json.loads(row[0]) if row else {'text':'','attachments':[]}
