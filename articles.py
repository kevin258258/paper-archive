"""Portable offline article packages. Original blocks are immutable; translations resume."""
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit
import hashlib
import base64
from urllib.parse import unquote_to_bytes
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
EXTRACTION_VERSION = 2
PAGE_LIMIT = 64_000_000
IMAGE_LIMIT = 16_000_000
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
    if 'image/svg+xml' in mime.lower() or b'<svg' in body[:1024].lower():
        import xml.etree.ElementTree as ET
        try: root = ET.fromstring(body)
        except ET.ParseError as exc: raise ValueError('无法读取 SVG 图片') from exc
        if root.tag.rsplit('}', 1)[-1] != 'svg': raise ValueError('不是 SVG')
        for parent in root.iter():
            for child in list(parent):
                if child.tag.rsplit('}', 1)[-1] in ('script', 'foreignObject', 'style', 'a', 'image', 'animate', 'animateMotion', 'animateTransform', 'set', 'discard'): parent.remove(child)
            for key, value in list(parent.attrib.items()):
                name = key.rsplit('}', 1)[-1].lower()
                local_reference = name == 'href' and re.fullmatch(r'#[A-Za-z0-9_.:-]+', value)
                urls = re.findall(r'url\(([^)]*)\)', value, re.I)
                external = any(not re.fullmatch(r'\s*[\'"]?#[A-Za-z0-9_.:-]+[\'"]?\s*', item) for item in urls)
                if name.startswith('on') or (name in ('href', 'src') and not local_reference) or external or re.search(r'javascript:|@import', value, re.I):
                    del parent.attrib[key]
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
    if not metadata['authors']:
        metadata['authors'] = [re.sub(r'[∗*†‡,]+', '', a.get_text(' ',strip=True)).strip() for a in soup.select('.d-byline .author')]
    if not metadata['published']:
        published_node=soup.select_one('.d-byline .published div')
        if published_node:
            try: metadata['published']=datetime.strptime(published_node.get_text(strip=True),'%b %d, %Y').date().isoformat()
            except ValueError: pass
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
    # Keep TeX out of Markdown conversion: markdownify otherwise consumes its
    # backslashes/underscores, and custom Distill tags lose equation boundaries.
    equations = {}
    def equation(node, tex, display=False):
        token = 'PAPEREXTRACTMATH' + str(len(equations)) + 'END'
        equations[token] = ('$$' if display else '$') + tex.strip() + ('$$' if display else '$')
        node.replace_with(' ' + token + ' ')
    for math in list(soup.select('d-math,script[type^="math/tex"],.math[data-tex],math[alttext],annotation[encoding="application/x-tex"]')):
        if math.parent is None: continue
        container = math.find_parent(class_='katex') or math.find_parent('math') or math
        tex = math.get('data-tex') or math.get('alttext') or math.get_text()
        display = 'block' in math.attrs or container.get('display') == 'block' or 'mode=display' in math.get('type','') or bool(container.find_parent(class_='katex-display'))
        equation(container, tex, display)
    for node in soup.select('nav,footer,aside,script,style,noscript,iframe,form,button,input,select,textarea,[hidden],[aria-hidden="true"],.katex-html'):
        node.decompose()
    root = soup.find('article') or soup.find('main') or soup.find(attrs={'role': 'main'})
    if root is None and soup.find('d-article'):
        root=soup.new_tag('article')
        for section in list(soup.select('d-article,d-appendix')): root.append(section.extract())
    if root is None:
        candidates = soup.select('.post-content,.entry-content,.article-content,.markdown,.prose,#content')
        root = max(candidates, key=lambda n: len(n.get_text()), default=soup.body or soup)
    # Distill footnotes are prose, not invisible tags concatenated with sentences.
    for note in root.find_all('d-footnote'):
        note.insert_before('（注：'); note.insert_after('）'); note.unwrap()
    for cite in root.find_all('d-cite'):
        if not cite.get_text(strip=True) and cite.get('key'):
            cite.string = ' [' + cite['key'] + '] '
    assets, warnings = {}, []
    total_bytes = 0
    def save_image(key, body, mime):
        nonlocal total_bytes
        if key in assets: return assets[key]
        if len(body) > IMAGE_LIMIT or total_bytes + len(body) > 200_000_000:
            raise ValueError('文章图片超过离线保存大小限制')
        if len(assets) >= 200: raise ValueError('图片数量超过 200 张')
        kind = image_bytes(body, mime)
        if isinstance(kind, tuple): kind, body = kind
        name = hashlib.sha256(body).hexdigest()[:24] + '.' + kind
        (path / 'images').mkdir(exist_ok=True)
        (path / 'images' / name).write_bytes(body)
        total_bytes += len(body)
        assets[key] = name
        return name
    # Static snapshots of known Distill figure components; never execute webpage JS.
    for component in root.select('.sn-figma-div[data-args]'):
        try:
            try: args = json.loads(component['data-args'])
            except ValueError:
                import ast
                args = ast.literal_eval(component['data-args'][:2000])
            if not isinstance(args, dict): raise ValueError('无效图表参数')
            slug = args.get('figma_slug', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', slug): raise ValueError('无效图表资源名')
            image = soup.new_tag('img', src=urljoin(url, 'figma/' + slug + '.svg'), alt=slug)
            component.append(image)
        except (ValueError, TypeError):
            warnings.append('动态 SVG 图表无法提取，请打开原文查看')
    # Inline SVG must become an offline image too, rather than disappearing as text.
    for svg in list(root.find_all('svg')):
        try:
            raw = str(svg)
            for low, camel in (('viewbox','viewBox'),('preserveaspectratio','preserveAspectRatio'),('clippath','clipPath'),('lineargradient','linearGradient'),('radialgradient','radialGradient'),('gradientunits','gradientUnits'),('gradienttransform','gradientTransform')):
                raw = re.sub(r'(?<=[ <])'+low+r'(?=[ =>])', camel, raw)
            name = save_image('inline-svg:' + hashlib.sha256(raw.encode()).hexdigest(), raw.encode(), 'image/svg+xml')
            svg.replace_with(soup.new_tag('img', src=f'/article-asset/{uid}/{name}', alt='SVG diagram'))
        except (ValueError, OSError) as exc:
            warnings.append('内嵌图表未能保存：' + str(exc)[:140]); svg.replace_with('[内嵌图表缺失，请查看原文]')
    # Download independent remote figures concurrently, with a bounded live
    # window: completed bodies are immediately saved and released from memory.
    remote_sources = set()
    for image in root.find_all('img'):
        src = image.get('data-src') or image.get('src') or ''
        if not src or src.lower().startswith('data:') or src.startswith(f'/article-asset/{uid}/'): continue
        try: remote_sources.add(normalize_url(urljoin(url, src)))
        except ValueError: pass
    download_errors = {}
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
    with ThreadPoolExecutor(max_workers=6) as downloads:
        sources = iter(sorted(remote_sources)[:200])
        pending = {}
        def replenish():
            while len(pending)<6:
                remote = next(sources, None)
                if remote is None: break
                pending[downloads.submit(fetch, remote, IMAGE_LIMIT)] = remote
        replenish()
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                remote = pending.pop(future)
                try:
                    body, mime, _ = future.result()
                    save_image(remote, body, mime)
                except (OSError, ValueError, RuntimeError) as exc: download_errors[remote]=str(exc)[:140]
            replenish()
    for image in list(root.find_all('img')):
        src = image.get('data-src') or image.get('src') or ''
        if src.startswith(f'/article-asset/{uid}/'): continue
        if not src and image.get('srcset'): src = image['srcset'].split(',')[-1].strip().split(' ')[0]
        try:
            if src.lower().startswith('data:'):
                head, encoded = src.split(',', 1)
                if len(encoded) > IMAGE_LIMIT * 1.5: raise ValueError('内嵌图片过大')
                mime = head[5:].split(';')[0].lower()
                body = base64.b64decode(re.sub(rb'\s+', b'', unquote_to_bytes(encoded)), validate=True) if ';base64' in head.lower() else unquote_to_bytes(encoded)
                remote = 'embedded:' + hashlib.sha256(body).hexdigest()
                name = save_image(remote, body, mime)
            else:
                if not src: raise ValueError('图片缺少来源')
                remote = normalize_url(urljoin(url, src))
                if remote in download_errors: raise ValueError(download_errors[remote])
                if remote not in assets: raise ValueError('图片数量超过 200 张')
                name = assets[remote]
            image.attrs = {'src': f'/article-asset/{uid}/{name}', 'alt': image.get('alt', '')}
        except (OSError, ValueError, RuntimeError) as exc:
            warnings.append('未能离线保存图片：' + str(exc)[:140])
            image.replace_with('[图片未能离线保存：' + image.get('alt', '无说明') + ']')
    # Empty script-driven visualizations must never silently disappear. Keep a
    # visible source link and disclose that the offline snapshot is incomplete.
    dynamic_count = 0
    for component in root.select('[data-args]'):
        if component.select_one('img') or component.get_text(strip=True): continue
        if 'sn-figma-div' in component.get('class', []): continue
        dynamic_count += 1
        link = soup.new_tag('a', href=url)
        link.string = '交互图表：打开原文查看'
        component.append(link)
    if dynamic_count: warnings.append(f'{dynamic_count} 个交互图表需在原文网站查看；离线版本仅包含静态正文和可保存图片')
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
        for token, tex in equations.items(): text = text.replace(token, tex)
        if not text: continue
        if len(text) > 40000: raise RuntimeError('文章含超长段落，暂不能完整提取')
        anchors = ([node.get('id')] if getattr(node, 'get', None) and node.get('id') else []) + ([n['id'] for n in node.select('[id]')] if getattr(node, 'select', None) else [])
        blocks.append({'index': len(blocks) + 1, 'original': text, 'chinese': '', 'anchors': anchors})
    full = '\n\n'.join(b['original'] for b in blocks)
    if len(full) < 180 or len(full) > 1_000_000 or not blocks:
        raise RuntimeError('没有提取到完整文章正文；可能需要登录或由脚本动态加载。已保留网页，可重试')
    related = []
    for ident in re.findall(r'https?://(?:www\.)?arxiv\.org/(?:abs|pdf|html)/([^\s)<>]+)', full):
        try: related.append(lib.parse_arxiv(ident.split('?')[0].removesuffix('.pdf')))
        except ValueError: pass
    return {**metadata, 'extraction_version': EXTRACTION_VERSION, 'source_complete': not warnings, 'blocks': blocks, 'images': assets, 'warnings': warnings, 'related_arxiv': list(dict.fromkeys(related))}


def prepare(url):
    url = normalize_url(url)
    path = folder(url)
    path.mkdir(parents=True, exist_ok=True)
    target = path / 'article.json'
    if target.exists(): return json.loads(target.read_text()), path
    body, mime, final = fetch(url, PAGE_LIMIT)
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


def translation_problem(original, translated):
    if protected(original) != protected(translated):
        return '译文改变了代码、公式、图片或链接；请保持这些内容逐字不变'
    prose = PROTECTED.sub('', original)
    words = re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)*", prose)
    chinese = len(re.findall(r'[\u4e00-\u9fff]', PROTECTED.sub('', translated)))
    # A conservative omission signal, not a semantic quality score. Proper names,
    # references and equations can legitimately stay unchanged.
    if len(words) >= 80 and chinese < len(words) * .8:
        return '译文疑似被压缩或遗漏：请逐句完整翻译，保留论证、限定条件和细节'
    if len(words) >= 8 and not chinese:
        return '此段仍包含未翻译的英文正文'
    return ''


def set_translation(url, index, text):
    with LOCK:
        value, path = prepare(url)
        if type(index) is not int or not 1 <= index <= len(value['blocks']) or not isinstance(text, str) or not text.strip() or len(text) > 100000:
            raise ValueError('无效译文段落')
        original = value['blocks'][index-1]['original']
        problem = translation_problem(original, text)
        if problem: raise ValueError(problem)
        value['blocks'][index-1]['chinese'] = text.strip()
        value['blocks'][index-1].pop('review_sha256', None)
        value['blocks'][index-1].pop('review_seen_sha256', None)
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
            problem = translation_problem(b['original'], b['chinese'])
            if problem: raise ValueError(f"第 {b['index']} 段：{problem}")
        if value.get('extraction_version', 1) >= 2 and any(b.get('review_sha256') != translation_hash(b) for b in value['blocks']):
            raise ValueError('请逐段对照复核全文译文，再调用 archive_review_blog_translation 保存复核；修改后需重新核对')
        domain = next((d for d in taxonomy.read()['domains'] if d['id'] == data.get('domain_id') and not d['archived']), None)
        title, reason = data.get('chinese_title'), data.get('reason')
        if not domain or not isinstance(title, str) or not 1 <= len(title) <= 500 or not isinstance(reason, str) or not reason.strip():
            raise ValueError('需要有效领域、中文标题和全文分类依据')
        value.update(chinese_title=title, classification_reason=reason, primary_domain=domain['id'], completed=True, repair_in_progress=False)
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
    return {'paper_id': record['id'], 'message': 'Blog 译文已入库' + ('；部分原文交互内容需在线查看' if value['warnings'] else ''), 'duplicate': False, 'warnings': value['warnings']}


def document(paper):
    path = Path(paper['files']['article'])
    value = json.loads(path.read_text())
    return {**{k: value[k] for k in ('title', 'chinese_title', 'authors', 'site', 'published', 'saved', 'source_url', 'blocks', 'warnings')}, 'completed': value.get('completed', False)}


def page_text(paper, language, page):
    blocks = document(paper)['blocks']
    if language not in ('original', 'chinese') or type(page) is not int or not 1 <= page <= len(blocks):
        raise ValueError('无效文章段落')
    return blocks[page-1][language]


def translation_hash(block):
    return hashlib.sha256((block['original'] + '\0' + block['chinese']).encode()).hexdigest()


def review_translation(url, start=1, end=None, confirmed=False):
    with LOCK:
        value, path = prepare(url)
        end = min(start + 19, len(value['blocks'])) if end is None else end
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(value['blocks']) or end-start >= 40:
            raise ValueError('每次复核 1–40 段')
        blocks = value['blocks'][start-1:end]
        if confirmed is True:
            for b in blocks:
                problem = translation_problem(b['original'], b['chinese']) if b['chinese'] else '尚未翻译'
                if problem: raise ValueError(f"第 {b['index']} 段：{problem}")
            if any(b.get('review_seen_sha256') != translation_hash(b) for b in blocks):
                raise ValueError('请先读取当前原文与译文对照，修改后重新读取，再确认复核')
            for b in blocks: b['review_sha256'] = translation_hash(b)
            write(path/'article.json', value)
        else:
            for b in blocks: b['review_seen_sha256'] = translation_hash(b)
            write(path/'article.json', value)
        return {'blocks': blocks, 'total': len(value['blocks']), 'confirmed': confirmed is True,
                'next_block': end+1 if end<len(value['blocks']) else None,
                'instruction': '逐句对照原文，核对事实、数字、限定语、引文、图注与公式；修正遗漏或摘要后，调用 confirmed=true 确认当前译文。'}


def needs_repair(url):
    path = folder(url)/'article.json'
    if not path.exists(): return False
    value = json.loads(path.read_text())
    return value.get('extraction_version', 1) < EXTRACTION_VERSION or not value.get('completed', False)


def repair(url):
    """Re-extract a legacy snapshot, keeping a recoverable copy and reading anchors.

    Original source.html is unchanged. Exact/near-exact source block matching maps
    old translations and personal annotations onto the corrected extraction.
    Every retained translation still needs the new full comparison pass.
    """
    import difflib
    import shutil
    path = folder(url)
    old = json.loads((path/'article.json').read_text())
    if old.get('extraction_version', 1) >= EXTRACTION_VERSION: return old, path
    backup = path/'backups'/'extraction-v1'
    backup.mkdir(parents=True, exist_ok=True)
    for name in ('article.json','original.md','chinese.md','metadata.json'):
        if (path/name).exists() and not (backup/name).exists(): shutil.copy2(path/name, backup/name)
    value = extract((path/'source.html').read_bytes(), old['source_url'], old['id'], path)
    def canonical(text):
        text = re.sub(r'!\[[^]]*\]\([^\n]*?\)|\[图片未能离线保存：[^]]*\]', 'IMAGE', text)
        text = text.replace('（注：','').replace('）','').replace('$','')
        text = re.sub(r'\[[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*\]', '', text)
        return re.sub(r'\s+', '', text)
    before = [canonical(b['original']) for b in old['blocks']]
    after = [canonical(b['original']) for b in value['blocks']]
    mapping = {}
    matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
    for tag,a,b,c,d in matcher.get_opcodes():
        if tag == 'equal': mapping.update({i+1:c+i-a+1 for i in range(a,b)})
        elif tag == 'replace':
            available = set(range(c,d))
            for i in range(a,b):
                if not available: break
                j = max(available, key=lambda j:difflib.SequenceMatcher(None,before[i],after[j],autojunk=False).ratio())
                if difflib.SequenceMatcher(None,before[i],after[j],autojunk=False).ratio() >= .65:
                    mapping[i+1]=j+1;available.remove(j)
    for i,j in mapping.items():
        source = value['blocks'][j-1]['original']; translated = old['blocks'][i-1].get('chinese','')
        # Reattach TeX delimiters only where the exact unchanged expression exists.
        for formula in re.findall(r'\$\$[\s\S]*?\$\$|\$[^\n$]+?\$', source):
            raw = formula.strip('$')
            if raw in translated and formula not in translated:
                translated = re.sub(r'(?<![A-Za-z0-9])'+re.escape(raw)+r'(?![A-Za-z0-9])', lambda _:formula, translated, count=1)
        images = re.findall(r'!\[[^]]*\]\([^\n]*?\)', source)
        for image in images:
            translated = re.sub(r'\[图片未能离线保存：[^]]*\]', lambda _:image, translated, count=1)
        if translated and not translation_problem(source, translated): value['blocks'][j-1]['chinese']=translated
    # Keep identity, custom metadata, and classification. Rebuilt fields win.
    value = {**old, **value, 'completed':False, 'repair_in_progress':True, 'read_blocks':[], 'repair_mapping':mapping}
    original = '\n\n'.join(b['original'] for b in value['blocks'])
    value['original_sha256'] = hashlib.sha256(original.encode()).hexdigest()
    with LOCK:
        write(path/'article.json', value)
        (path/'original.md').write_text(original)
        (path/'chinese.md').write_text('\n\n'.join(b['chinese'] for b in value['blocks']))
        if (path/'metadata.json').exists():
            write(path/'metadata.json', {k:v for k,v in value.items() if k not in ('blocks','images','read_blocks')})
        with lib.db() as c:
            row=c.execute('SELECT data FROM reading WHERE id=?',(old['id'],)).fetchone()
            if row:
                state=json.loads(row[0])
                if not (backup/'reading.json').exists(): write(backup/'reading.json',state)
                for position in state.get('positions',{}).values():
                    if 'page' in position: position['page']=mapping.get(position['page'],min(position['page'],len(value['blocks'])))
                for h in state.get('highlights',[]):
                    # Preserve every quote/comment even if a source block has changed.
                    h['page']=mapping.get(h['page'],min(h['page'],len(value['blocks'])))
                c.execute('UPDATE reading SET data=? WHERE id=?',(json.dumps(state,ensure_ascii=False),old['id']))
    return value,path
