"""One-time SQLite backup of an earlier local reader; source stays untouched."""
import shutil
import sqlite3
import library as lib


def migrate():
    old = lib.ROOT / '00-阅读系统' / 'paper-reader' / 'state'
    target = lib.STATE / 'library.sqlite3'
    if target.exists() or not (old / 'library.sqlite3').exists() or old.resolve() == lib.STATE.resolve():
        return
    with sqlite3.connect('file:' + str(old / 'library.sqlite3') + '?mode=ro', uri=True) as source:
        with sqlite3.connect(target) as dest:
            source.backup(dest)
    assets = old.parent / 'public' / 'assets'
    if assets.exists():
        shutil.copytree(assets, lib.STATE / 'assets', dirs_exist_ok=True)
