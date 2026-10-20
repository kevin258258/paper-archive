# Architecture and validation

The Electron main process owns the desktop window, directory chooser, encrypted key storage and backend lifecycle. The isolated renderer receives two narrow IPC methods. A Python backend owns SQLite, file access, arXiv ingestion and AI transports. All assets needed for the reader are served locally.

- `library.py`: file indexing, PDF evidence and reading-state patches.
- `collections_store.py`: many-to-many collections with reversible archive/restore.
- `taxonomy.py`: user-owned domains and human assignment overrides, atomic JSON writes.
- `jobs.py`: durable jobs, cancellation, resumable failure states and Codex transport.
- `providers.py`: Responses / Chat Completions transports, structured results, incomplete/refusal detection, sanitized errors and no credential forwarding across redirects.
- `conversation.py`: per-paper full-text context, selected text and page-verified citations.
- `global_chat.py`: scoped retrieval, cross-paper comparison, history and per-paper coverage.
- `codex_rpc.py`: JSON-lines app-server transport, initialize handshake, correlated RPC replies and asynchronous server requests.
- `harness.py`: native persistent Codex threads, model catalog/defaults, turn state, resumability, streaming snapshots, explicit approvals and user replies. No shortened JSON answer schema.
- `paper_tools.py`: scope-checked catalog pagination, full PDF page-range reads and actual page images exposed as Codex dynamic tools.
- `public/harness-chat.js`: shared conversation UI, model/effort selectors, streamed Markdown, activity, stop, history and approval controls.
- `importer.py`: constrained downloads and safe extraction, resumable translation with structural invariants, restricted XeLaTeX compilation, full-text note generation and registry-based classification.
- `skills/arxiv-translate/`: portable workflow instructions for external automation and manual repair.

## Verification

Run `python scripts/test.py` in the activated build environment. Tests use temporary libraries and synthetic PDFs; they do not need a personal library or AI account. The compiler integration case runs when XeLaTeX is installed and otherwise reports a skip.

Coverage includes input validation, PDF ranges, stable identities, note persistence, collections, migration behavior, conversation isolation, quote verification, custom domains, scoped cross-paper prompts, provider payloads and errors, archive traversal/symlinks, LaTeX structure validation, and a complete synthetic import through the real compiler. Harness cases check native thread reuse across reconnects, model/effort propagation, streamed deltas, late PDF pages and page-image output, scope enforcement, approval ownership and cancellation during startup.

Manual release checks:

1. Start the packaged app with a new empty vault and with a pre-existing vault.
2. Read a PDF, create a highlight/comment, reopen and verify persistence.
3. Create and rename a domain; assign a paper and reopen it.
4. Ask about a complete paper with local Codex; inspect PDF text/image tool calls and follow page citations. Stop and resume, including after a backend restart. Check collection scope in the global workspace.
5. Test API mode with a compatible endpoint. Unit tests use mocked responses and are not a live-provider certification.
6. Check archive contents and Git tracked files for credentials, personal paths, real papers, private notes and diagnostics.

The initial local verification used 30 passing automated tests, a real XeLaTeX synthetic import, and a live Codex comparison of two PDFs. The independent desktop window was also launched successfully on a Linux Wayland session. API protocol behavior was exercised with controlled responses; compatibility with every third-party provider is not claimed.

The 0.2 verification passed 37 automated tests and exercised a real Codex app-server: a complete 13-page PDF read, original chart images, a substantial untruncated answer, same-thread continuation after restarting the backend, collection-scoped reading, interruption, and page-link navigation. The shared UI was checked with real model/effort choices, formula rendering and preserved older records.

## Known boundaries

- Native Codex can browse all papers in the selected scope; its context window and decisions still limit actual coverage. Each text-tool call reads at most 20 pages, with further ranges available. No six-paper or total-text cap is imposed on a Codex conversation.
- API mode retains bounded retrieval (at most six PDFs) and quote matching. Native Codex links navigate to pages and do not imply automatic quote verification.
- Dynamic tools and additional context use experimental app-server fields. Protocol compatibility was tested with CLI 0.162.1; older versions may require an upgrade. Model lists are obtained dynamically.
- The app owns a stdio app-server, not the Codex desktop window. Native thread IDs and model context are shared through Codex's persisted history. The app stores its own rendered transcript; turns added by another client are not imported into that transcript.
- Shell/file-change approvals and Codex question prompts are handled in-app. Unsupported server interactions (including MCP elicitation forms) are explicitly rejected and reported, rather than silently approved.
- Translation preserves command/math/reference structure and checks compilation, but uncommon templates can require manual repair. Sources without text or without LaTeX are not automatically OCR-translated.
- Virtual domain changes do not rewrite Obsidian index notes. External skill-assisted curation may maintain those notes separately.
- API cancellation discards the eventual answer locally; an already sent upstream HTTP request can continue until its timeout and may still incur provider charges.
- A Codex executable must be discoverable in PATH/common CLI directories or selected in Settings. The app uses the user's existing login and does not distribute or copy it.
- SQLite and the taxonomy belong to a single local vault. Concurrent independent application instances pointed at the same vault are not a supported sync strategy.
- Linux is the initially tested desktop platform. Cross-platform configuration is not a substitute for platform testing or signing.
