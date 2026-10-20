# Architecture and validation

The Electron main process owns the desktop window, directory chooser, encrypted key storage and backend lifecycle. The isolated renderer receives two narrow IPC methods. A Python backend owns SQLite, file access, arXiv ingestion and AI transports. All assets needed for the reader are served locally.

- `library.py`: file indexing, PDF evidence and reading-state patches.
- `collections_store.py`: many-to-many collections with reversible archive/restore.
- `taxonomy.py`: user-owned domains and human assignment overrides, atomic JSON writes.
- `jobs.py`: durable jobs, cancellation, resumable failure states and Codex transport.
- `providers.py`: Responses / Chat Completions transports, structured results, incomplete/refusal detection, sanitized errors and no credential forwarding across redirects.
- `conversation.py`: per-paper full-text context, selected text and page-verified citations.
- `global_chat.py`: scoped retrieval, cross-paper comparison, history and per-paper coverage.
- `importer.py`: constrained downloads and safe extraction, resumable translation with structural invariants, restricted XeLaTeX compilation, full-text note generation and registry-based classification.
- `skills/arxiv-translate/`: portable workflow instructions for external automation and manual repair.

## Verification

Run `python scripts/test.py` in the activated build environment. Tests use temporary libraries and synthetic PDFs; they do not need a personal library or AI account. The compiler integration case runs when XeLaTeX is installed and otherwise reports a skip.

Coverage includes input validation, PDF ranges, stable identities, note persistence, collections, migration behavior, conversation isolation, quote verification, custom domains, scoped cross-paper prompts, provider payloads and errors, archive traversal/symlinks, LaTeX structure validation, and a complete synthetic import through the real compiler.

Manual release checks:

1. Start the packaged app with a new empty vault and with a pre-existing vault.
2. Read a PDF, create a highlight/comment, reopen and verify persistence.
3. Create and rename a domain; assign a paper and reopen it.
4. Ask across two papers using local Codex; inspect coverage and follow page citations.
5. Test API mode with a compatible endpoint. Unit tests use mocked responses and are not a live-provider certification.
6. Check archive contents and Git tracked files for credentials, personal paths, real papers, private notes and diagnostics.

The initial local verification used 30 passing automated tests, a real XeLaTeX synthetic import, and a live Codex comparison of two PDFs. The independent desktop window was also launched successfully on a Linux Wayland session. API protocol behavior was exercised with controlled responses; compatibility with every third-party provider is not claimed.

## Known boundaries

- The global workspace retrieves at most six PDFs per question with a total text budget. It may miss relevant papers; the catalog includes truncated abstracts and first-page evidence. Partial coverage is disclosed.
- Quote matching ignores whitespace and case. It rejects unsupported page quotes but cannot establish logical correctness of the answer.
- Translation preserves command/math/reference structure and checks compilation, but uncommon templates can require manual repair. Sources without text or without LaTeX are not automatically OCR-translated.
- Virtual domain changes do not rewrite Obsidian index notes. External skill-assisted curation may maintain those notes separately.
- API cancellation discards the eventual answer locally; an already sent upstream HTTP request can continue until its timeout and may still incur provider charges.
- A Codex executable must be discoverable in PATH or common user CLI directories. The app uses the user's existing login and does not distribute or copy it.
- SQLite and the taxonomy belong to a single local vault. Concurrent independent application instances pointed at the same vault are not a supported sync strategy.
- Linux is the initially tested desktop platform. Cross-platform configuration is not a substitute for platform testing or signing.
