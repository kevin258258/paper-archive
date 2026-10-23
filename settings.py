"""Non-secret preferences. Keys are supplied by the desktop key store or environment."""
import json
import os
import shutil
import threading
from urllib.parse import urlparse
import library as lib

LOCK = threading.RLock()
DEFAULT = {"provider": "codex", "model": "", "codex_path": "",
           "import_mode": "codex", "import_model": "gpt-6.1-sol",
           "import_effort": "medium", "import_skill": "",
           "base_url": "https://api.openai.com/v1", "protocol": "responses"}


def read():
    with LOCK:
        path = lib.STATE / 'preferences.json'
        return {**DEFAULT, **(json.loads(path.read_text()) if path.exists() else {})}


def save(data):
    if set(data) - set(DEFAULT):
        raise ValueError('未知设置字段')
    value = {**read(), **data}
    if value['provider'] not in ('codex', 'api') or value['protocol'] not in ('responses', 'chat'):
        raise ValueError('无效 AI 配置')
    if not isinstance(value['model'], str) or len(value['model']) > 150:
        raise ValueError('无效模型名称')
    if value['import_mode'] not in ('codex', 'pipeline'):
        raise ValueError('无效入库方式')
    if not isinstance(value['import_model'], str) or not value['import_model'].strip() or len(value['import_model']) > 150:
        raise ValueError('请输入入库模型')
    if value['import_effort'] not in ('low', 'medium', 'high', 'xhigh', 'max', 'ultra'):
        raise ValueError('无效入库推理强度')
    from pathlib import Path
    command = value["codex_path"]
    skill = value['import_skill']
    if not isinstance(skill, str) or (skill and (not Path(skill).is_absolute() or Path(skill).name != 'SKILL.md' or not Path(skill).is_file())):
        raise ValueError('Skill 必须是本机 SKILL.md 的绝对路径；留空使用随应用提供的翻译技能')
    if not isinstance(command, str) or (command and (
            not Path(command).is_absolute() or not Path(command).is_file() or not os.access(command, os.X_OK))):
        raise ValueError('Codex 路径必须是本机可执行文件的绝对路径；留空自动发现')
    url = urlparse(value['base_url'])
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ValueError('API 地址需要 HTTPS；本机服务可以使用 HTTP')
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('API 地址不能包含凭证或查询参数')
    value['base_url'] = value['base_url'].rstrip('/')
    if value['provider'] == 'api' and not value['model'].strip():
        raise ValueError('请输入 API 模型名称')
    if value["codex_path"] != read()["codex_path"]:
        import harness
        harness.reconfigure()
    with LOCK:
        tmp = lib.STATE / 'preferences.tmp'
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
        tmp.replace(lib.STATE / 'preferences.json')
    return public()


def public():
    return {**read(), 'app_version': '0.9.0', 'has_key': bool(os.environ.get('PAPER_API_KEY') or os.environ.get('OPENAI_API_KEY')),
            'codex_available': bool(read()["codex_path"] or shutil.which('codex')), 'vault': str(lib.ROOT),
            'translation_ready': bool(shutil.which('xelatex')), 'desktop': bool(os.environ.get('PAPER_DESKTOP_TOKEN'))}
