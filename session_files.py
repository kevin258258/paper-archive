"""Open model-produced workspace files only after a visible user click."""
from pathlib import Path
import mimetypes
import re
import harness
import library as lib


def locate(uid, value):
    harness.snapshot(uid)
    if not isinstance(value,str) or not value or len(value)>10000: raise ValueError('无效文件路径')
    value=re.sub(r':\d+(?::\d+)?$', '', value)
    path=Path(value)
    if not path.is_absolute():path=lib.ROOT/path
    path=path.resolve()
    if not path.is_relative_to(lib.ROOT.resolve()) or not path.is_file(): raise ValueError('文件不在当前资料工作区中或不存在')
    mime=mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    return {'name':path.name,'path':str(path),'size':path.stat().st_size,'mime':mime},path
