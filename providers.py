"""AI transport with a user-owned key. Never persist keys or upstream error bodies."""
import json
import os
import urllib.request
import urllib.error
import settings
from networking import tls_context


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward Authorization to another origin.
        return None


def complete(prompt, schema=None, timeout=180):
    config = settings.read()
    key = os.environ.get('PAPER_API_KEY') or os.environ.get('OPENAI_API_KEY') or ''
    if not key:
        raise RuntimeError('请在设置中添加 API key，或设置 PAPER_API_KEY 环境变量')
    if not config['model']:
        raise RuntimeError('请在设置中填写 API 模型名称')
    if config['protocol'] == 'responses':
        payload = {'model': config['model'], 'input': prompt, 'store': False, 'max_output_tokens': 20000}
        if schema:
            payload['text'] = {'format': {'type': 'json_schema', 'name': 'paper_archive', 'schema': schema, 'strict': True}}
        endpoint = '/responses'
    else:
        payload = {'model': config['model'], 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': 20000}
        if schema:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {'name': 'paper_archive', 'schema': schema, 'strict': True}}
        endpoint = '/chat/completions'
    req = urllib.request.Request(config['base_url'] + endpoint, data=json.dumps(payload).encode(),
                                 headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=tls_context())).open(req, timeout=timeout) as res:
            data = json.load(res)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'API 请求失败（HTTP {exc.code}），请检查模型、协议、密钥或额度') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise RuntimeError('无法连接 API 或请求超时，请检查 API 地址与网络') from None
    if config['protocol'] == 'responses':
        if data.get('status') not in ('completed', None) or data.get('incomplete_details'):
            raise RuntimeError('API 输出未完成；请使用支持足够输出长度的模型重试')
        parts = [c for item in data.get('output', []) for c in item.get('content', [])]
        if any(c.get('type') == 'refusal' for c in parts):
            raise RuntimeError('模型拒绝了本次请求')
        text = '\n'.join(c.get('text', '') for c in parts if c.get('type') == 'output_text')
    else:
        choice = (data.get('choices') or [{}])[0]
        if choice.get('finish_reason') != 'stop' or choice.get('message', {}).get('refusal'):
            raise RuntimeError('API 输出不完整或模型拒绝了请求')
        text = choice.get('message', {}).get('content', '')
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError('API 未返回文本')
    if schema:
        try:
            json.loads(text)
        except ValueError:
            raise RuntimeError('模型没有返回有效 JSON，请确认 API 支持 Structured Outputs') from None
    return text
