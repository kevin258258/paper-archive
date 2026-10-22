"""User-selected local attachments, kept whole for native Codex file tools."""
from pathlib import Path
import json
import mimetypes
import re
import uuid
import library as lib

MAX_BYTES = 100_000_000


def root():
    return lib.STATE / 'attachments'


def receive(stream, name, size):
    if type(size) is not int or not 0 < size <= MAX_BYTES:
        raise ValueError('请选择 100 MB 以内的文件')
    name = re.sub(r'[\x00-\x1f/\\]', '_', str(name))[:220].strip(' .') or 'attachment'
    uid = uuid.uuid4().hex
    folder = root()/uid
    folder.mkdir(parents=True, mode=0o700)
    (folder/'files').mkdir()
    target = folder/'files'/name
    try:
        remaining = size
        with target.open('xb') as out:
            while remaining:
                chunk = stream.read(min(65536, remaining))
                if not chunk: raise ValueError('附件上传未完成，请重试')
                out.write(chunk)
                remaining -= len(chunk)
        with target.open('rb') as source: head = source.read(32)
        image = next((mime for magic,mime in ((b'\x89PNG\r\n\x1a\n','image/png'),(b'\xff\xd8\xff','image/jpeg'),(b'GIF8','image/gif')) if head.startswith(magic)), None)
        if head.startswith(b'RIFF') and head[8:12]==b'WEBP': image='image/webp'
        data = {'id':uid,'name':name,'size':size,'mime':image or mimetypes.guess_type(name)[0] or 'application/octet-stream','kind':'image' if image else 'file'}
        (folder/'manifest.json').write_text(json.dumps(data,ensure_ascii=False))
        return data
    except Exception:
        target.unlink(missing_ok=True)
        (folder/'files').rmdir()
        folder.rmdir()
        raise


def resolve(uid):
    if not isinstance(uid,str) or not re.fullmatch(r'[a-f0-9]{32}',uid): raise ValueError('无效附件')
    folder = root()/uid
    try: data=json.loads((folder/'manifest.json').read_text())
    except (OSError, ValueError): raise ValueError('附件不存在，请重新添加') from None
    path=(folder/'files'/data['name']).resolve()
    if not path.is_relative_to(folder.resolve()) or not path.is_file(): raise ValueError('附件不存在')
    return data, path


def select(ids):
    if not isinstance(ids,list) or len(ids)>100 or any(not isinstance(uid,str) for uid in ids): raise ValueError('无效附件列表')
    return [resolve(uid)[0] for uid in dict.fromkeys(ids)]


def inputs(files):
    result=[]
    paths=[]
    for attachment in files:
        data,path=resolve(attachment['id'])
        if data['kind']=='image': result.append({'type':'localImage','path':str(path)})
        else: paths.append({'name':data['name'],'path':str(path),'bytes':data['size']})
    if paths:
        result.append({'type':'text','text':'User-attached local files (complete files, not excerpts). Read them with your normal file/PDF tools as needed:\n'+json.dumps(paths,ensure_ascii=False)})
    return result
