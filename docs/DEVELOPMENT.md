# Architecture and validation

The Electron main process owns the desktop window, directory chooser, encrypted key storage and backend lifecycle. The isolated renderer receives narrow, sender-checked IPC methods. Remote Blog pages use a separate sandboxed WebContentsView without preload or Node access. A Python backend owns SQLite, file access, arXiv ingestion and AI transports. All assets needed for the reader are served locally.

- `library.py`: file indexing, PDF evidence and reading-state patches.
- `collections_store.py`: many-to-many collections with reversible archive/restore.
- `waiting_list.py`: independent durable reading queue, one-time migration from active favorites, stable pin/order state and explicit reread support. Completing a paper atomically updates reading status and removes its queue entry.
- `taxonomy.py`: user-owned domains and human assignment overrides, atomic JSON writes.
- `jobs.py`: durable jobs, cancellation, resumable failure states and Codex transport.
- `providers.py`: Responses / Chat Completions transports, structured results, incomplete/refusal detection, sanitized errors and no credential forwarding across redirects.
- `conversation.py`: per-paper full-text context, selected text and page-verified citations.
- `global_chat.py`: scoped retrieval, cross-paper comparison, history and per-paper coverage.
- `codex_rpc.py`: JSON-lines app-server transport, initialize handshake, correlated RPC replies and asynchronous server requests.
- `harness.py`: native persistent Codex threads, model catalog/defaults, turn state, resumability, streaming snapshots, explicit approvals and user replies. No shortened JSON answer schema.
- `paper_tools.py`: scope-checked catalog pagination, full PDF page-range reads and actual page images exposed as Codex dynamic tools.
- `public/harness-chat.js`: shared conversation UI, model/effort selectors, streamed Markdown, activity, stop, history and approval controls.
- `agent_import.py`: durable import-job bridge to the same native Codex session, independent import model/effort and explicit skill attachment. Retries resume the native thread.
- `agent_import_tools.py`: deterministic downloads, immutable source checks, compiler diagnostics, page/image tools with coverage records, and final archive validation. No nested AI calls.
- `domain_scan.py`: serialized native Codex scans of a captured library/domain snapshot, durable per-pair decisions, exact PDF quote verification and atomic membership updates. Primary assignments and manual exclusions are preserved. Retries reuse prior decisions and the native session when the snapshot is unchanged.
- `importer.py`: API fallback, constrained downloads and safe extraction, resumable translation with structural invariants, restricted XeLaTeX compilation, full-text note generation and registry-based classification.
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

The 0.3 suite passes 45 tests, including explicit skill attachment, independent import defaults, same-thread import retries, immutable sources, mathematical damage rejection, complete PDF coverage and current translated page images. A streaming regression case covers native command items whose initial output is null. Compilation and finalization are separate checks; an interrupted agent cannot mark an unfinished package complete.

The 0.3.1 suite passes 51 tests. Batch cases cover mixed link formats and version deduplication, complete rejection before submitting invalid input, idempotent repeated submissions, visibility of all 50 pending tasks, immediate handling of already archived papers, and a blocked import followed by failure while search and the next import still complete. A dedicated single-worker executor keeps translation serialized without occupying the search/conversation pool. `POST /api/imports` accepts `{query: "links or IDs"}` and returns `{jobs, count}`; each paper retains its ordinary durable job and native conversation.

The 0.4 suite passes 61 tests. Domain-scan cases cover complete pair coverage, fabricated or wrong-page quote rejection, overlapping memberships, unchanged primary/manual assignments, immutable paper files, uncertain suggestions, durable manual exclusions, changed domain/source rejection, same-session retry, automatic scheduling and exclusion of human notes from scan tools. A live scan classified all 184 pairs across a 92-paper snapshot and two domains with verified positive page evidence. These checks establish scope and evidence provenance; semantic relevance and confidence remain model judgments.

The 0.5 suite passes 70 tests. Queue cases verify one-time migration without re-adding removed items, preservation of completed reading, independent collection/queue removal, completion without losing notes or highlights, explicit reread, persistent pin/order, temporarily missing indexed papers and primary-domain removal without losing other memberships. Manual UI checks cover right-click and ⋯ menus, collection/domain submenus, direct removal, pinning, reader completion and persistence after reload. Menus support keyboard navigation and close on Escape or outside interaction; PDF text retains its normal context menu.

## Known boundaries

- Native Codex can browse all papers in the selected scope; its context window and decisions still limit actual coverage. Each text-tool call reads at most 20 pages, with further ranges available. No six-paper or total-text cap is imposed on a Codex conversation.
- API mode retains bounded retrieval (at most six PDFs) and quote matching. Native Codex links navigate to pages and do not imply automatic quote verification.
- Dynamic tools and additional context use experimental app-server fields. Protocol compatibility was tested with CLI 0.162.1; older versions may require an upgrade. Model lists are obtained dynamically.
- The app owns a stdio app-server, not the Codex desktop window. Native thread IDs and model context are shared through Codex's persisted history. The app stores its own rendered transcript; turns added by another client are not imported into that transcript.
- Shell/file-change approvals and Codex question prompts are handled in-app. Unsupported server interactions (including MCP elicitation forms) are explicitly rejected and reported, rather than silently approved.
- Native translation uses Codex to edit the whole TeX tree and repair compilation; the bundled skill calls for source/terminology review and actual PDF images. Finalization requires all original pages read through the PDF tool and title/middle/final translated page images from the current compiled PDF, plus the required artifacts. These checks do not prove perfect semantic fidelity or typography. Uncommon templates and missing TeX packages may still need user attention. Sources without usable text or LaTeX are not automatically OCR-translated.
- API fallback validates command/reference structure and the multiset of mathematical expressions; Chinese prose reordering alone must not fail validation.
- Native imports permit writes in the selected vault. The agent is instructed to work only on the selected paper; deterministic tools enforce its arXiv scope, preserve original source hashes and use the registry for final destination. Keep manual notes and review decisions separate from Agent artifacts.
- Import model and effort default independently to `gpt-6.1-sol` / `medium`. Unavailable models fail explicitly rather than silently switching. A custom skill must be a readable absolute `SKILL.md` path; its content is injected through the protocol skill input.
- Virtual domain changes do not rewrite Obsidian index notes. External skill-assisted curation may maintain those notes separately.
- API cancellation discards the eventual answer locally; an already sent upstream HTTP request can continue until its timeout and may still incur provider charges.
- A Codex executable must be discoverable in PATH/common CLI directories or selected in Settings. The app uses the user's existing login and does not distribute or copy it.
- SQLite and the taxonomy belong to a single local vault. Concurrent independent application instances pointed at the same vault are not a supported sync strategy.
- Linux is the initially tested desktop platform. Cross-platform configuration is not a substitute for platform testing or signing.

## Original-site Blog reader (0.9)

`desktop/article-view.cjs` owns a remote view per open Blog tab, with a separate nonpersistent session and no desktop-token injection. Its commands accept an indexed article ID, never an arbitrary file path or JavaScript. The authenticated, desktop-only web-context endpoint provides the original public URL and fixed snapshot destination. Public request checks include all DNS answers; local files, internal hosts, permissions, downloads and popups are denied. A remote page cannot call the app IPC or read its backend capability. The primary app CSP is unchanged.

`desktop/article-overlay.cjs` runs in an isolated world. It aligns normalized source text to DOM blocks, inserts reviewed Chinese HTML beside original elements, and toggles presentation without rebuilding the source page. Figures and controls stay mounted; dynamic content is observed, and unmatched text stays original with a coverage count. No new model call is required to switch presentation. `public/article-web.js` bounds the native view to the active reader, hides it behind app dialogs/menus or inactive tabs, and connects selections, highlights, search, position and sidebar controls. The original MHTML is saved before translation injection; manual refresh temporarily removes the overlay and restores it afterwards. Offline snapshots are explicitly labelled static.

Run `electron scripts/test_article_view.cjs` on a machine with a display (or under Xvfb in CI) for renderer regression checks: original chart handlers, slider changes, three language modes, dynamic paragraphs, conservative matching, search, teardown, and private URL/DNS rejection. These run in an offscreen window against synthetic data, without the user's library. The Python suite also checks snapshot placement and excludes local snapshot paths from the normal article document.
