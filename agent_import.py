"""Drive an ordinary persistent Codex skill conversation from a durable import job."""
import time
import harness
import jobs
import library as lib
import agent_import_tools

INSTRUCTIONS = '''You are the user's external Codex agent performing one Paper Archive import.
The user explicitly authorized downloading, translating, compiling, repairing, visually reviewing,
creating four reading notes, classifying and archiving this arXiv paper in the selected local vault.
Use the explicitly attached arxiv-translate skill and the requested model/effort. Perform translation
and research in THIS persistent Codex session with your normal file/command/image tools.
Do not call the legacy import command, legacy importer AI loop, another LLM API, or a credential-backed
translation script. Never read credential files or change the user's global Codex configuration.
Use archive_prepare_import to reuse downloads and get the real paths and current domain registry.
Original tex_source and original PDF are immutable. Edit only tex_cn and agent-owned paper artifacts;
preserve human notes, collection/reading state and seed decisions. Stay within this paper package.
Use archive_compile_translation for compilation and diagnostics, then repair actual problems yourself.
Use archive_read_import_pdf to read every original page, including appendices, and verify key details
against sources. Use archive_view_import_page for actual images: original evidence where needed and
Chinese title, body, dense mathematics, figures/tables, references, middle and final pages. The visual
checks must refer to the final compiled PDF, so repeat them after any recompilation.
Prepare all four research notes with real physical PDF page evidence. Read the skill references.
Use archive_check_translation to catch omitted files, unmodified prose and actual mathematical damage.
Chinese word order can move a variable mention; do not treat equivalent math ordering as corruption.
Only archive_finish_import can declare the archive complete. It validates artifacts and coverage;
if it reports missing work, complete that work and call again. Do not claim success from compilation
alone. Report genuine blockers with the actionable cause and retained paths. No publishing or messaging.
'''


def run(uid, arxiv):
    session = harness.create_import(arxiv, uid)
    sid = session['id']
    jobs.update(uid, result={'session_id': sid}, stage='Codex 技能会话 · 准备连接')
    jobs.event(uid, '入库使用独立的 Codex skill 会话：' + session['model'] + ' / ' + session['effort'])
    question = ('$arxiv-translate https://arxiv.org/abs/' + arxiv +
                '\n请按附带技能完整翻译并入库。复用已有文件与进度，修复未完成部分，核验最终译本后归档。')
    harness.start(sid, {'question': question})
    last_revision = None
    last_progress = None
    while True:
        if uid in jobs.CANCELLED:
            harness.interrupt(sid)
            raise InterruptedError()
        state = harness.snapshot(sid)
        if state['revision'] != last_revision:
            last_revision = state['revision']
            if state['thread_id']:
                jobs.update(uid, result={'session_id': sid, 'thread_id': state['thread_id']})
            stage = '等待入库会话审批或回复' if state['status'] == 'waiting' else 'Codex 正在翻译、修复与核验'
            items = state['turns'][-1]['items'] if state['turns'] else []
            for item in reversed(items):
                if item['type'] == 'dynamicToolCall':
                    stage = {'archive_prepare_import': '准备原文与源文件',
                             'archive_compile_translation': '编译译文与检查诊断',
                             'archive_read_import_pdf': '阅读全文与核对证据',
                             'archive_view_import_page': '查看 PDF 页面并核验排版',
                             'archive_check_translation': '核对翻译覆盖与公式',
                             'archive_finish_import': '验证完成并分类入库'}.get(item.get('tool'), stage)
                    break
                if item['type'] == 'commandExecution':
                    stage = 'Codex 正在处理论文文件'
                    break
            if state['status'] == 'waiting':
                stage = '等待入库会话审批或回复'
            jobs.update(uid, stage=stage)
            messages = [i['text'] for i in items if i['type'] == 'agentMessage' and i.get('text')]
            if messages and messages[-1] != last_progress:
                # Record completed sentences rather than every token delta.
                message = messages[-1]
                if message.endswith(('。', '！', '？', '.', '\n')) or state['status'] not in harness.BUSY:
                    last_progress = message
                    jobs.event(uid, message[-1100:])
        if state['status'] == 'completed':
            receipt = agent_import_tools.audit(arxiv)
            if not receipt.get('completed'):
                messages = [i.get('text', '') for i in state['turns'][-1]['items'] if i['type'] == 'agentMessage']
                detail = messages[-1][-600:] if messages else ''
                raise RuntimeError('尚未通过最终入库校验，重试可继续原会话。' + detail)
            verified = jobs.verify_import(arxiv)
            return {'paper_id': verified['id'], 'session_id': sid, 'thread_id': state['thread_id'],
                    'message': '已由 Codex 完成翻译、核验与入库', 'duplicate': False}
        if state['status'] in ('failed', 'interrupted'):
            raise RuntimeError(state.get('error') or 'Codex 入库会话已停止，重试可继续原会话')
        time.sleep(0.6)
