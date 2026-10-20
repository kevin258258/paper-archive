"""Shared user-owned domain registry, consumed by the UI and portable skills."""
import json
import re
import threading
import uuid
import library as lib

LOCK = threading.RLock()


def path():
    return lib.ROOT / '.paper-archive' / 'taxonomy.json'


def _write(value):
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(target)


def read():
    with LOCK:
        if path().exists():
            return json.loads(path().read_text())
        domains = []
        for folder in sorted((lib.ROOT / '10-领域').glob('*')):
            if folder.is_dir():
                ident, _, name = folder.name.partition('-')
                domains.append({'id': ident, 'name': name or ident, 'description': '', 'folder': folder.name, 'archived': False})
        domains.append({'id': 'unfiled', 'name': '未分类', 'description': '无法确定归属的论文，等待人工分类', 'folder': 'unfiled-未分类', 'archived': False})
        value = {'version': 1, 'domains': domains, 'assignments': {}}
        _write(value)
        return value


def save(data):
    name, description = data.get('name', ''), data.get('description', '')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or re.search(r'[\\/\x00-\x1f]', name):
        raise ValueError('领域名称需为 1–60 字，且不能包含路径符号')
    if not isinstance(description, str) or len(description) > 2000:
        raise ValueError('领域范围最多 2000 字')
    with LOCK:
        value = read()
        ident = data.get('id')
        domain = next((d for d in value['domains'] if d['id'] == ident), None)
        if ident and not domain:
            raise KeyError(ident)
        if any(d['name'] == name.strip() and d['id'] != ident for d in value['domains']):
            raise ValueError('该领域名称已存在')
        if not domain:
            ident = uuid.uuid4().hex[:10]
            domain = {'id': ident, 'folder': ident + '-' + name.strip(), 'archived': False}
            value['domains'].append(domain)
        if ident == 'unfiled' and data.get('archived'):
            raise ValueError('未分类领域不能归档')
        if 'archived' in data and not isinstance(data['archived'], bool):
            raise ValueError('无效归档状态')
        domain.update(name=name.strip(), description=description.strip(), archived=data.get('archived', domain['archived']))
        _write(value)
        return value


def assign(paper_id, domain_id):
    lib.paper(paper_id)
    with LOCK:
        value = read()
        if not any(d['id'] == domain_id and not d['archived'] for d in value['domains']):
            raise ValueError('请选择有效领域')
        value['assignments'][paper_id] = domain_id
        _write(value)
    return {'paper_id': paper_id, 'domain_id': domain_id}


def apply(record, registry=None):
    if "id" not in record or "domain" not in record:
        return record
    value = registry or read()
    ident = value['assignments'].get(record['id'], record['domain'])
    domain = next((d for d in value['domains'] if d['id'] == ident), None)
    return {**record, 'domain': ident, 'domainName': domain['name'] if domain else record['domainName']}
