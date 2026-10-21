"""Deterministic paper I/O for an external Codex skill session; no nested AI calls."""
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import threading

import fitz
import yaml
import library as lib
import importer
import taxonomy
from paper_tools import spec, text_result, integer

LOCK = threading.RLock()
S = {'type': 'string'}
I = {'type': 'integer'}
PDF = {'language': {'type': 'string', 'enum': ['original', 'chinese']}}
TOOLS = [
    spec('archive_prepare_import', 'Prepare/resume this arXiv package: metadata, original PDF, immutable TeX sources, editable tex_cn, current domain registry. No AI translation is run here.', {}),
    spec('archive_compile_translation', 'Compile the translated TeX with XeLaTeX and return diagnostics. Repair editable tex_cn files and call again if needed. Does not mark the import complete.', {'main_file': S}, ['main_file']),
    spec('archive_read_import_pdf', 'Read physical PDF pages, including appendices; paginate to read the complete original before writing notes.', {**PDF, 'start_page': I, 'end_page': I}),
    spec('archive_view_import_page', 'View a real PDF page image. Chinese PDF visual checks are recorded against the current compiled PDF.', {**PDF, 'page': I}, ['language', 'page']),
    spec('archive_check_translation', 'Report source/translation coverage, mathematical differences and missing files before finalizing. Explain legitimate differences; repair actual loss of math or prose.', {}),
    spec('archive_finish_import', 'Validate the package and recorded full-text/visual checks, write metadata/card, preserve manual decisions, archive into a current domain and refresh the library.', {
        'chinese_title': S, 'domain_id': S, 'reason': S,
        'translation_review': S, 'visual_review': S}, ['chinese_title', 'domain_id', 'reason', 'translation_review', 'visual_review']),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_path(arxiv):
    folder = lib.STATE / 'agent-imports'
    folder.mkdir(exist_ok=True)
    return folder / (hashlib.sha256(arxiv.encode()).hexdigest()[:24] + '.json')


def audit(arxiv):
    path = audit_path(arxiv)
    return json.loads(path.read_text()) if path.exists() else {}


def save(arxiv, value):
    path = audit_path(arxiv)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)


def folder(arxiv):
    arxiv = lib.parse_arxiv(arxiv)
    known = lib.find_arxiv(arxiv)
    if known:
        return Path(lib.paper(known['id'])['files']['card']).parent
    return lib.ROOT / '90-待整理' / re.sub(r'[^\w.-]', '_', arxiv)


def prepare(arxiv):
    arxiv = lib.parse_arxiv(arxiv)
    path = folder(arxiv)
    path.mkdir(parents=True, exist_ok=True)
    meta = path / 'metadata.json'
    if not meta.exists():
        meta.write_text(json.dumps(importer.metadata(arxiv), ensure_ascii=False, indent=2))
    pdf = next((p for p in path.glob('*.pdf') if not re.search('中文|译文', p.name)), path / 'original.pdf')
    if not pdf.exists():
        importer.download('https://arxiv.org/pdf/' + arxiv, pdf)
    source = path / 'tex_source'
    if not any(source.rglob('*.tex')):
        archive = path / 'source.archive'
        if not archive.exists():
            importer.download('https://arxiv.org/e-print/' + arxiv, archive)
        importer.extract(archive, source)
    if not (path / 'tex_cn').exists():
        shutil.copytree(source, path / 'tex_cn')
    hashes = {str(p.relative_to(source)): digest(p) for p in source.rglob('*') if p.is_file()}
    with LOCK:
        value = audit(arxiv)
        if value.get('source_hashes') and value['source_hashes'] != hashes:
            raise ValueError('原始源码已改变，请检查版本；不会覆盖原来的翻译记录')
        if value.get('original_sha') and value['original_sha'] != digest(pdf):
            raise ValueError('原始 PDF 已改变，请检查版本')
        value.update(folder=str(path), original=str(pdf), original_sha=digest(pdf), source_hashes=hashes)
        value.setdefault('read_pages', [])
        value.setdefault('viewed_pages', [])
        save(arxiv, value)
    with lib.PDF_LOCK, fitz.open(pdf) as doc:
        count = len(doc)
    return {'arxiv': arxiv, 'folder': str(path), 'metadata': json.loads(meta.read_text()),
            'original_pdf': str(pdf), 'pages': count, 'tex_source': str(source),
            'tex_cn': str(path / 'tex_cn'),
            'tex_files': [{'path': str(p.relative_to(source)), 'characters': p.stat().st_size}
                          for p in sorted(source.rglob('*.tex'))],
            'domains': [d for d in taxonomy.read()['domains'] if not d['archived']],
            'prior_read_pages': value['read_pages'], 'prior_visual_pages': value['viewed_pages']}


def ensure(arxiv):
    value = audit(arxiv)
    if not value.get('original'):
        raise ValueError('请先调用 archive_prepare_import')
    return value, folder(arxiv)


def compile_translation(arxiv, main_file, uid=''):
    value, path = ensure(arxiv)
    base = (path / 'tex_cn').resolve()
    main = (base / main_file).resolve()
    if not main.is_relative_to(base) or main.suffix != '.tex' or not main.is_file():
        raise ValueError('主文件必须位于本论文的 tex_cn 中')
    if not shutil.which('xelatex'):
        raise RuntimeError('需要安装 XeLaTeX、ctex 与 Fandol 字体后继续')
    try:
        output = importer.compile_pdf(uid, main)
    except RuntimeError as exc:
        log = main.parent / 'compile-diagnostic.txt'
        return {'compiled': False, 'error': str(exc), 'log': str(log),
                'diagnostic': log.read_text(errors='replace')[-6500:] if log.exists() else ''}
    chinese = next((p for p in sorted(path.glob('*.pdf')) if re.search('中文|译文', p.name)), path / '中文版.pdf')
    shutil.copy2(output, chinese)
    with lib.PDF_LOCK, fitz.open(chinese) as doc:
        pages = len(doc)
    with LOCK:
        value = audit(arxiv)
        sha = digest(chinese)
        if value.get('chinese_sha') != sha:
            value['viewed_pages'] = []
        value.update(chinese=str(chinese), chinese_name=chinese.name, chinese_sha=sha,
                     main_file=main_file, compiled=True, completed=False)
        save(arxiv, value)
    return {'compiled': True, 'pdf': str(chinese), 'pages': pages,
            'next': 'Read and visually inspect the newly compiled PDF before finalization.'}


def read_pdf(arxiv, args, image=False):
    value, path = ensure(arxiv)
    language = args.get('language', 'original')
    if language not in ('original', 'chinese'):
        raise ValueError('无效语言')
    pdf = Path(value['original']) if language == 'original' else path / value.get('chinese_name', '中文版.pdf')
    if not pdf.is_file():
        raise ValueError('译本尚未编译')
    with lib.PDF_LOCK, fitz.open(pdf) as doc:
        if image:
            page = integer(args, 'page', 1, 1, len(doc))
            pix = doc[page-1].get_pixmap(matrix=fitz.Matrix(1.4, 1.4), alpha=False)
            result = text_result({'language': language, 'page': page, 'total_pages': len(doc)})
            result['contentItems'].append({'type': 'inputImage', 'imageUrl': 'data:image/png;base64,' + base64.b64encode(pix.tobytes('png')).decode()})
            if language == 'chinese':
                with LOCK:
                    value = audit(arxiv)
                    if value.get('chinese_sha') != digest(pdf):
                        raise ValueError('译本已改变，请重新编译以重置视觉检查记录')
                    value['viewed_pages'] = sorted(set(value['viewed_pages'] + [page]))
                    save(arxiv, value)
            return result
        first = integer(args, 'start_page', 1, 1, len(doc))
        last = integer(args, 'end_page', min(first+9, len(doc)), first, min(first+19, len(doc)))
        pages = [{'page': n, 'text': doc[n-1].get_text()} for n in range(first, last+1)]
    if language == 'original':
        with LOCK:
            value = audit(arxiv)
            value['read_pages'] = sorted(set(value['read_pages'] + list(range(first, last+1))))
            save(arxiv, value)
    return text_result({'language': language, 'pages': pages})


def check(arxiv):
    value, path = ensure(arxiv)
    source = path / 'tex_source'
    changed_originals = [name for name, sha in value['source_hashes'].items()
                         if not (source / name).is_file() or digest(source / name) != sha]
    if not Path(value['original']).is_file() or digest(Path(value['original'])) != value['original_sha']:
        changed_originals.append('original PDF')
    rows = []
    for file in sorted(source.rglob('*.tex')):
        rel = file.relative_to(source)
        target = path / 'tex_cn' / rel
        old = file.read_text(errors='replace')
        new = target.read_text(errors='replace') if target.exists() else ''
        original_math = importer.invariant(old)[2]
        translated_math = importer.invariant(new)[2]
        rows.append({'file': str(rel), 'exists': target.exists(), 'changed': old != new,
                     'chinese_characters': len(re.findall(r'[\u4e00-\u9fff]', new)),
                     'mathematics_unchanged': original_math == translated_math})
    return {'files': rows, 'changed_originals': changed_originals,
            'original_read_pages': value['read_pages'], 'chinese_viewed_pages': value['viewed_pages']}


def finish(arxiv, data):
    value, path = ensure(arxiv)
    report = check(arxiv)
    if report['changed_originals']:
        raise ValueError('原始源码被修改，不能完成入库：' + ', '.join(report['changed_originals'][:5]))
    if any(not f['exists'] for f in report['files']):
        raise ValueError('译文缺少源文件')
    damaged_math = [f['file'] for f in report['files'] if not f['mathematics_unchanged']]
    if damaged_math:
        raise ValueError('公式内容检查存在差异，请对照原文修复：' + ', '.join(damaged_math[:6]))
    if not any(f['chinese_characters'] >= 30 and f['changed'] for f in report['files']):
        raise ValueError('未检测到实质性中文翻译')
    chinese = path / value.get('chinese_name', '中文版.pdf')
    if not value.get('compiled') or not chinese.exists() or digest(chinese) != value.get('chinese_sha'):
        raise ValueError('译本缺少当前版本的成功编译记录')
    with lib.PDF_LOCK, fitz.open(value['original']) as original, fitz.open(chinese) as translated:
        if set(value['read_pages']) != set(range(1, len(original)+1)):
            raise ValueError('原文尚未读取全部页面，包括附录')
        views = set(value['viewed_pages'])
        required = {1, max(1, len(translated)//2), len(translated)}
        if not required <= views:
            raise ValueError('请查看译本首页、中间页和末页，另核对图表、公式及参考文献')
    for name in ['chinese_title', 'domain_id', 'reason', 'translation_review', 'visual_review']:
        if not isinstance(data.get(name), str) or not data[name].strip():
            raise ValueError('缺少完成检查：' + name)
    missing = [name for _, name in lib.NOTE_NAMES.values() if not (path / name).is_file() or (path / name).stat().st_size < 60]
    if missing:
        raise ValueError('缺少研究笔记：' + ', '.join(missing))
    domains = taxonomy.read()
    domain = next((d for d in domains['domains'] if d['id'] == data['domain_id'] and not d['archived']), None)
    if not domain:
        raise ValueError('请选择当前有效领域')
    existing = lib.find_arxiv(arxiv)
    if existing and existing['id'] in domains['assignments']:
        domain = next(d for d in domains['domains'] if d['id'] == domains['assignments'][existing['id']])
    meta_path = path / 'metadata.json'
    meta = json.loads(meta_path.read_text())
    meta.update(chinese_title=data['chinese_title'], primary_domain=domain['id'],
                classification_reason=data['reason'], classification_status='full_text_reviewed',
                import_engine='codex-skill', translation_review=data['translation_review'],
                visual_review={'notes': data['visual_review'], 'pages': value['viewed_pages'], 'pdf_sha256': value['chinese_sha']})
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    card = path / '00-论文卡片.md'
    if not card.exists():
        props = {'title': data['chinese_title'], 'aliases': [meta['title']], 'arxiv_id': arxiv,
                 'authors': meta['authors'], 'year': int(meta['published'][:4]), 'human_status': '未读',
                 'primary_domain': domain['id'], 'seed_status': '未筛选'}
        card.write_text('---\n' + yaml.safe_dump(props, allow_unicode=True, sort_keys=False) + '---\n\n# ' + data['chinese_title'] + '\n\n' + meta.get('abstract', ''))
    if not existing:
        destination = lib.ROOT / '10-领域' / domain['folder'] / re.sub(r'[^\w.-]', '_', arxiv)
        if destination.exists():
            raise ValueError('归档目标已存在，请检查重复论文')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), destination)
        path = destination
    lib.refresh()
    import jobs
    paper = jobs.verify_import(arxiv)
    with LOCK:
        value = audit(arxiv)
        value.update(completed=True, paper_id=paper['id'], folder=str(path),
                     original=str(path / Path(value['original']).name),
                     chinese=str(path / value.get('chinese_name', '中文版.pdf')))
        save(arxiv, value)
    return {'paper_id': paper['id'], 'duplicate': False, 'message': 'Codex 已完成翻译、视觉检查与入库', 'report': data['reason']}


def execute(session, tool, args):
    arxiv = session['arxiv']
    if not isinstance(args, dict):
        raise ValueError('无效工具参数')
    if tool == 'archive_prepare_import':
        return text_result(prepare(arxiv))
    if tool == 'archive_compile_translation':
        return text_result(compile_translation(arxiv, args.get('main_file', ''), session.get('job_id', '')))
    if tool == 'archive_read_import_pdf':
        return read_pdf(arxiv, args)
    if tool == 'archive_view_import_page':
        return read_pdf(arxiv, args, image=True)
    if tool == 'archive_check_translation':
        return text_result(check(arxiv))
    if tool == 'archive_finish_import':
        return text_result(finish(arxiv, args))
    raise ValueError('未知入库工具')
