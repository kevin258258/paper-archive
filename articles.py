"""Portable offline article packages. Original blocks are immutable; translations resume."""
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit
import hashlib
import json
import re
import threading
import yaml
from bs4 import BeautifulSoup
from markdownify import markdownify
import library as lib
import taxonomy
from web_sources import normalize_url, source_id, fetch

LOCK = threading.RLock()
PROTECTED = re.compile(r'```[\s\S]*?```|`[^`\n]+`|!\[[^\]]*\]\([^\n]*?\)|(?<=\]\()[^\s)]+|\$\$[\s\S]*?\$\$|(?<![\\\w])\$[^\n$]+?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)')


def write(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)


def find(url):
    url = normalize_url(url)
    return next((p for p in lib.papers() if p.get('sourceType') == 'blog' and url in p.get('sourceUrls', [])), None)


def folder(url):
    known = find(url)
    return Path(lib.paper(known['id'])['files']['card']).parent if known else lib.ROOT / '90-待整理' / ('blog-' + source_id(url))


def image_bytes(body, mime):
    if body.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if body.startswith(b'\xff\xd8\xff'): return 'jpg'
    if body.startswith((b'GIF87a', b'GIF89a')): return 'gif'
    if body[:4] == b'RIFF' and body[8:12] == b'WEBP': return 'webp'
    if b'ftypavif' in body[:32]: return 'avif'
    if 'image/svg+xml' in mime:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(body)
        if root.tag.rsplit('}', 1)[-1] != 'svg': raise ValueError('不是 SVG')
        for parent in root.iter():
            for child in list(parent):
                if child.tag.rsplit('}', 1)[-1] in ('script', 'foreignObject', 'style', 'a', 'image', 'use'): parent.remove(child)
            for key, value in list(parent.attrib.items()):
                if key.lower().startswith('on') or key.rsplit('}', 1)[-1] in ('href', 'src') or re.search(r'url\(|javascript:', value, re.I): del parent.attrib[key]
        return 'svg', ET.tostring(root)
    raise ValueError('不支持的图片格式')


def extract(html, url, uid, path):
    soup = BeautifulSoup(html, 'html.parser')
    def meta(*names):
        for name in names:
            el = soup.find('meta', attrs={'property': name}) or soup.find('meta', attrs={'name': name})
            if el and el.get('content'): return el['content'].strip()
        return ''
    title = meta('og:title', 'twitter:title') or (soup.h1.get_text(' ', strip=True) if soup.h1 else '') or (soup.title.get_text(' ', strip=True) if soup.title else urlsplit(url).hostname)
    author = meta('author', 'article:author')
    published = meta('article:published_time', 'date', 'datePublished')
    if not published and soup.find('time'): published = soup.find('time').get('datetime', '')
    metadata = dict(title=title, authors=[author] if author else [], published=published,
                    site=meta('og:site_name') or urlsplit(url).hostname, abstract=meta('description', 'og:description'))
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string or script.get_text())
            entries = data if isinstance(data, list) else data.get('@graph', [data])
            for item in entries:
                if not isinstance(item, dict) or not any(t in str(item.get('@type', '')) for t in ('Article', 'BlogPosting')): continue
                authors = item.get('author', [])
                if not isinstance(authors, list): authors = [authors]
                names = [a.get('name', '') if isinstance(a, dict) else str(a) for a in authors]
                if not metadata['authors']: metadata['authors'] = [n for n in names if n]
                if not metadata['published']: metadata['published'] = str(item.get('datePublished', ''))
        except (ValueError, TypeError, AttributeError): pass
    for math in list(soup.select('script[type^="math/tex"]')):
        tex = math.get_text()
        math.replace_with(' $$'+tex+'$$ ' if 'mode=display' in math.get('type', '') else ' $'+tex+'$ ')
    # Restrict extraction to the principal article; never execute author scripts.
    for node in soup.select('nav,footer,aside,script,style,noscript,iframe,form,button,input,select,textarea,svg:has(script),[hidden],[aria-hidden="true"],.katex-html'):
        node.decompose()
    root = soup.find('article') or soup.find('main') or soup.find(attrs={'role': 'main'})
    if root is None:
        candidates = soup.select('.post-content,.entry-content,.article-content,.markdown,.prose,#content')
        root = max(candidates, key=lambda n: len(n.get_text()), default=soup.body or soup)
    for math in list(root.select('annotation[encoding="application/x-tex"],script[type^="math/tex"],.math[data-tex],math[alttext]')):
        tex = math.get('data-tex') or math.get('alttext') or math.get_text()
        container = math.find_parent(class_='katex') or math.find_parent('math') or math
        container.replace_with(' $$' + tex + '$$ ' if container.name == 'math' and container.get('display') == 'block' else ' $' + tex + '$ ')
    assets, warnings = {}, []
    for image in list(root.find_all('img')):
        src = image.get('data-src') or image.get('src') or ''
        if (not src or src.startswith('data:')) and image.get('srcset'): src = image['srcset'].split(',')[-1].strip().split(' ')[0]
        try:
            remote = normalize_url(urljoin(url, src))
            if remote not in assets:
                if len(assets) >= 40: raise ValueError('图片数量超过 40 张')
                body, mime, _ = fetch(remote, 8_000_000)
                kind = image_bytes(body, mime)
                if isinstance(kind, tuple): kind, body = kind
                name = hashlib.sha256(body).hexdigest()[:24] + '.' + kind
                (path / 'images').mkdir(exist_ok=True)
                (path / 'images' / name).write_bytes(body)
                assets[remote] = name
            image.attrs = {'src': f'/article-asset/{uid}/{assets[remote]}', 'alt': image.get('alt', '')}
        except (OSError, ValueError, RuntimeError) as exc:
            warnings.append('未能离线保存图片：' + str(exc)[:140])
            image.replace_with('[图片未能离线保存：' + image.get('alt', '无说明') + ']')
    for link in root.find_all('a'):
        href = link.get('href', '')
        if href.startswith('#'): continue
        joined = urljoin(url, href)
        if urlsplit(joined).scheme in ('http', 'https'): link['href'] = joined
        else: link.attrs.pop('href', None)
    # Preserve structural blocks for stable bilingual alignment and citations.
    nodes = []
    def visit(node):
        if getattr(node, 'name', None) in ('p', 'pre', 'table', 'ul', 'ol', 'blockquote', 'figure', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            nodes.append(node)
        elif getattr(node, 'name', None) == 'img': nodes.append(node)
        elif getattr(node, 'children', None) is not None:
            for child in node.children: visit(child)
        elif str(node).strip(): nodes.append(str(node))
    visit(root)
    blocks = []
    for node in nodes:
        text = markdownify(str(node), heading_style='ATX', bullets='-', keep_inline_images_in=['td', 'th'], escape_underscores=False).strip()
        if not text: continue
        if len(text) > 40000: raise RuntimeError('文章含超长段落，暂不能完整提取')
        blocks.append({'index': len(blocks) + 1, 'original': text, 'chinese': ''})
    full = '\n\n'.join(b['original'] for b in blocks)
    if len(full) < 180 or len(full) > 1_000_000 or not blocks:
        raise RuntimeError('没有提取到完整文章正文；可能需要登录或由脚本动态加载。已保留网页，可重试')
    related = []
    for ident in re.findall(r'https?://(?:www\.)?arxiv\.org/(?:abs|pdf|html)/([^\s)<>]+)', full):
        try: related.append(lib.parse_arxiv(ident.split('?')[0].removesuffix('.pdf')))
        except ValueError: pass
    return {**metadata, 'blocks': blocks, 'images': assets, 'warnings': warnings, 'related_arxiv': list(dict.fromkeys(related))}


def prepare(url):
    url = normalize_url(url)
    path = folder(url)
    path.mkdir(parents=True, exist_ok=True)
    target = path / 'article.json'
    if target.exists(): return json.loads(target.read_text()), path
    body, mime, final = fetch(url)
    if not any(t in mime.lower() for t in ('text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown')):
        raise RuntimeError('这个链接不是网页文章；PDF 论文请使用 arXiv 链接')
    (path / 'source.html').write_bytes(body)
    uid = source_id(url)
    if 'text/plain' in mime or 'text/markdown' in mime:
        text = body.decode('utf-8')
        from html import escape
        html = '<article>' + ''.join('<p>' + escape(x) + '</p>' for x in text.split('\n\n')) + '</article>'
    else: html = body
    value = extract(html, final, uid, path)
    known = find(final)
    if known:
        # Preserve the original URL alias so later pastes skip the download too.
        existing_path = Path(lib.paper(known['id'])['files']['article'])
        existing = json.loads(existing_path.read_text())
        if url not in existing['source_urls']:
            existing['source_urls'].append(url)
            write(existing_path, existing)
            meta_file = existing_path.parent / 'metadata.json'
            metadata = json.loads(meta_file.read_text())
            metadata['source_urls'] = existing['source_urls']
            write(meta_file, metadata)
            lib.refresh()
    value.update(id=uid, source_type='blog', source_url=final, source_urls=list(dict.fromkeys([url, normalize_url(final)])),
                 saved=datetime.now(timezone.utc).isoformat(), completed=False, read_blocks=[])
    original_text = '\n\n'.join(b['original'] for b in value['blocks'])
    value['original_sha256'] = hashlib.sha256(original_text.encode()).hexdigest()
    write(target, value)
    (path / 'original.md').write_text(original_text)
    return value, path


def protected(text):
    return PROTECTED.findall(text)


def set_translation(url, index, text):
    with LOCK:
        value, path = prepare(url)
        if type(index) is not int or not 1 <= index <= len(value['blocks']) or not isinstance(text, str) or not text.strip() or len(text) > 100000:
            raise ValueError('无效译文段落')
        original = value['blocks'][index-1]['original']
        if protected(original) != protected(text):
            raise ValueError('译文改变了代码、公式、图片或链接；请保持这些内容逐字不变')
        prose = PROTECTED.sub('', original)
        if re.search(r'[A-Za-z]{3}', prose) and not re.search(r'[\u4e00-\u9fff]', text):
            raise ValueError('此段仍包含未翻译的英文正文')
        value['blocks'][index-1]['chinese'] = text.strip()
        write(path / 'article.json', value)
    return {'translated': sum(bool(b['chinese']) for b in value['blocks']), 'total': len(value['blocks'])}


def read_import(url, start=1, end=None):
    with LOCK:
        value, path = prepare(url)
        end = min(start + 19, len(value['blocks'])) if end is None else end
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(value['blocks']) or end-start >= 40:
            raise ValueError('每次读取 1–40 段，段号需在文章范围内')
        blocks = value['blocks'][start-1:end]
        value['read_blocks'] = sorted(set(value['read_blocks']) | set(range(start, end+1)))
        write(path / 'article.json', value)
        return {'metadata': {k: value[k] for k in ('title', 'authors', 'site', 'published', 'source_url', 'warnings')},
                'blocks': blocks, 'total': len(value['blocks']), 'next_block': end+1 if end < len(value['blocks']) else None,
                'domains': [d for d in taxonomy.read()['domains'] if not d['archived']]}


def finish(url, data):
    with LOCK:
        value, path = prepare(url)
        original = '\n\n'.join(b['original'] for b in value['blocks']).encode()
        if hashlib.sha256(original).hexdigest() != value.get('original_sha256') or (path / 'original.md').read_bytes() != original:
            raise ValueError('原文已改变，不能使用旧的翻译与阅读校验；请检查离线原稿')
        if any(not b['chinese'] for b in value['blocks']) or len(value['read_blocks']) != len(value['blocks']):
            raise ValueError('尚未阅读全文或完成每段翻译；请补齐后再入库')
        for b in value['blocks']:
            if protected(b['original']) != protected(b['chinese']): raise ValueError('代码或公式校验未通过')
        domain = next((d for d in taxonomy.read()['domains'] if d['id'] == data.get('domain_id') and not d['archived']), None)
        title, reason = data.get('chinese_title'), data.get('reason')
        if not domain or not isinstance(title, str) or not 1 <= len(title) <= 500 or not isinstance(reason, str) or not reason.strip():
            raise ValueError('需要有效领域、中文标题和全文分类依据')
        value.update(chinese_title=title, classification_reason=reason, primary_domain=domain['id'], completed=True)
        (path / 'chinese.md').write_text('\n\n'.join(b['chinese'] for b in value['blocks']))
        write(path / 'article.json', value)
        meta = {k: v for k, v in value.items() if k not in ('blocks', 'images', 'read_blocks')}
        write(path / 'metadata.json', meta)
        card = path / '00-论文卡片.md'
        if not card.exists():
            fields = {'title': title, 'aliases': [value['title']], 'authors': value['authors'], 'year': int(value['published'][:4]) if re.match(r'^\d{4}', value['published']) else None,
                      'created': value['saved'], 'human_status': '未读', 'source_type': 'blog', 'source_url': value['source_url']}
            card.write_text('---\n'+yaml.safe_dump(fields, allow_unicode=True, sort_keys=False)+'---\n\n# '+title+'\n\n'+value.get('abstract', ''))
        if path.parent.name == '90-待整理':
            import shutil
            dest = lib.ROOT / '10-领域' / domain['folder'] / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists(): raise ValueError('文章目标目录已存在，请检查重复收录')
            shutil.move(str(path), dest)
    lib.refresh()
    record = lib.paper(value['id'])['record']
    return {'paper_id': record['id'], 'message': 'Blog 已完整翻译并入库', 'duplicate': False, 'warnings': value['warnings']}


def document(paper):
    path = Path(paper['files']['article'])
    value = json.loads(path.read_text())
    return {k: value[k] for k in ('title', 'chinese_title', 'authors', 'site', 'published', 'saved', 'source_url', 'blocks', 'warnings')}


def page_text(paper, language, page):
    blocks = document(paper)['blocks']
    if language not in ('original', 'chinese') or type(page) is not int or not 1 <= page <= len(blocks):
        raise ValueError('无效文章段落')
    return blocks[page-1][language]
