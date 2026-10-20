# 藏 · Paper Archive

A quiet desktop library for papers, reading, and research across papers.

灰白、平面、几何。收藏、阅读、批注，把不同论文放在一起讨论。

![Research workspace](docs/workspace.png)

## What it does

- **Library:** gallery, catalog and matrix views; keyword and semantic search; your own collections and domains.
- **Reader:** continuous PDF pages, selectable text, outlines, search, bilingual switching, saved positions, highlights and notes.
- **Paper conversations:** ask about the current paper or selected passage. Verified quotes link back to physical PDF pages.
- **Research workspace:** ask across the library or a collection. The assistant selects up to six relevant papers, reads a bounded set of pages and distinguishes evidence from hypotheses. Coverage is shown; this is not exhaustive literature review.
- **arXiv ingestion:** original PDF + LaTeX source → Chinese translation → XeLaTeX compilation → four reading notes → classification. Progress is retained for retries. Existing papers are deduplicated by arXiv ID.
- **Your AI:** local Codex login, or an API key with Responses / Chat Completions structured output support. The same provider powers search, conversations, translation and classification.

## Run the desktop app

Requires Python 3.11+ and Node.js 22+ for development. Packaged builds bundle Python and the reader dependencies.

```sh
git clone https://github.com/kevin258258/paper-archive.git
cd paper-archive
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci
npm start
```

On Windows, activate `.venv\Scripts\activate` and set `PAPER_PYTHON` to that environment's `python.exe` before `npm start`. On first launch, choose a paper directory. An empty directory works; the app creates its structure as needed.

**AI setup:** install and log in to [Codex CLI](https://developers.openai.com/codex/cli/), or open Settings and provide your API base URL, protocol, model and key. API endpoints must support JSON Schema structured output. Remote endpoints require HTTPS; local model servers may use loopback HTTP.

**Full translation:** install XeLaTeX with `ctex`, Fandol fonts and the LaTeX packages required by the paper. TeX Live and MiKTeX can provide these. Some arXiv papers have no usable LaTeX source or need manual compilation repair; failed work remains incomplete and resumable, never silently reported as translated. The retained compilation log helps diagnose missing packages. The portable skill also calls for visual review of the finished PDF; automated compilation alone does not guarantee publication-quality layout.

## Data and privacy

The program and your library are separate. There is no hosted account or built-in telemetry.

```text
<your-vault>/
  10-领域/<stable-domain-folder>/<paper>/
    00-论文卡片.md
    metadata.json
    original.pdf / 中文版.pdf
    tex_source/ / tex_cn/
    Agent-*.md
  90-待整理/                  # resumable imports
  .paper-archive/
    taxonomy.json            # editable domains and manual assignments
    state/                   # local SQLite, thumbnails, preferences, job results
```

Paper contents and queries are sent to the AI provider you choose when you invoke an AI feature. Personal drafts and annotations are not automatically added to cross-paper prompts. AI responses can still be wrong: quote verification establishes that a quote exists on the given page, not that every interpretation is correct.

API keys are stored in the operating system's encrypted key store through Electron when available. If secure storage is unavailable, a newly entered key is used only for the current run. The key is never returned by the HTTP settings endpoint. For CLI/development usage, supply `PAPER_API_KEY` or `OPENAI_API_KEY` in your own environment. No account, login session, key, paper library or personal note is included in this repository.

The desktop starts its own loopback backend on an ephemeral port, protected by a per-launch capability. No public listener is created. The browser development server is loopback-only, with host, origin and mutation-token checks.

Existing local-reader collections, annotations and conversations are copied using SQLite backup on the first desktop launch when the earlier reader's state is found in the selected vault. Originals are left intact. Back up the entire vault and the desktop application data when moving to another machine; API keys should be configured again there.

## Domains and automation

Add a domain, describe its scope, then assign papers through their detail view. New automatic classifications consult the current `.paper-archive/taxonomy.json`. Human assignments take precedence. Reassigning an existing paper is virtual, preserving its physical path and Obsidian links. Renaming a domain keeps its stable ID and folder.

The portable [arxiv-translate skill](skills/arxiv-translate/SKILL.md) contains no personal paths or credentials. It can be installed in your own skills directory; set `PAPER_ARCHIVE_HOME` to this checkout and `PAPER_VAULT_ROOT` to your library for external automation. The app does not require a global skill installation.

```sh
python scripts/archive.py --vault /path/to/your/library domains
python scripts/archive.py --vault /path/to/your/library import 2406.02469
python scripts/archive.py --vault /path/to/your/library validate
```

The packaged backend also accepts `paper-backend --cli --vault <path> …`. CLI API calls need your environment key; they cannot silently extract the desktop's encrypted key.

## Development and builds

```sh
python scripts/test.py
python scripts/build_backend.py
npm run dist:linux
```

Linux builds produce an AppImage and a tar archive; the latter works without FUSE. macOS and Windows build targets are configured but have not been validated on those systems. Build on the target OS. Initial binaries are unsigned.

A synthetic demo can be generated without downloading papers:

```sh
python scripts/demo.py --output /tmp/paper-archive-demo
PAPER_VAULT_ROOT=/tmp/paper-archive-demo npm start
```

The optional browser development server is `python server.py`; environment variables `PAPER_VAULT_ROOT`, `PAPER_READER_STATE`, `PAPER_READER_PORT` and `PAPER_PYTHON` override local paths/runtime. API and Codex diagnostics remain local. Never commit a real vault, state directory, `.env`, login directory or diagnostic log.

See [architecture and validation](docs/DEVELOPMENT.md) for limits, interfaces and checks. Contributions are welcome through issues and pull requests.

## License

[AGPL-3.0-only](LICENSE). PDF extraction uses PyMuPDF under AGPL; third-party packages retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md). This project is independent of OpenAI and arXiv.
