"""Portable automation entry point for the bundled arxiv-translate skill."""
import argparse
import json
import os


def main(argv=None):
    parser = argparse.ArgumentParser(description='Paper Archive automation')
    parser.add_argument('--vault', required=True, help='User-selected paper vault directory')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('domains')
    sub.add_parser('validate')
    sub.add_parser('refresh')
    imp = sub.add_parser('import')
    imp.add_argument('arxiv')
    args = parser.parse_args(argv)
    os.environ['PAPER_VAULT_ROOT'] = os.path.abspath(os.path.expanduser(args.vault))
    os.environ['PAPER_READER_STATE'] = os.path.join(os.environ['PAPER_VAULT_ROOT'], '.paper-archive', 'state')
    import library as lib
    import taxonomy
    import jobs
    lib.init_db()
    if args.command == 'domains':
        print(json.dumps(taxonomy.read(), ensure_ascii=False, indent=2))
        return 0
    result = lib.refresh()
    if args.command == 'import':
        sources = lib.parse_sources(args.arxiv)
        if len(sources) != 1: raise ValueError('CLI import 每次处理一个链接')
        job = jobs.create(*sources[0], submit=False)
        if job['status'] in ('running',):
            print('该论文已有导入任务，请在应用中查看进度')
            return 1
        jobs.run(job['id'])
        job = jobs.get(job['id'])
        print(json.dumps(job, ensure_ascii=False, indent=2))
        return 0 if job['status'] == 'completed' else 1
    if args.command == 'validate':
        failures = []
        for paper in lib.papers():
            try:
                (__import__('articles').document(lib.paper(paper['id'])) if paper.get('sourceType') == 'blog' else jobs.verify_import(paper['arxiv']))
            except (RuntimeError, ValueError) as exc:
                failures.append({'arxiv': paper['arxiv'], 'error': str(exc)})
        result['incomplete'] = failures
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get('warnings') or result.get('incomplete') else 0
