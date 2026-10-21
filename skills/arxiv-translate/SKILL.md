---
name: arxiv-translate
description: "Translate and archive an arXiv paper with a complete local Codex session, preserving LaTeX and figures, repairing compilation, inspecting the Chinese PDF, reading the full original, creating research notes and classifying by user domains. Use for an arXiv URL/ID supplied for translation or collection."
---

# arXiv → Paper Archive

Use the user's own Codex harness and explicitly selected model/effort. Never embed or retrieve someone else's credentials, private URLs or home directories.

## Native Codex session

When `archive_prepare_import` is available, perform the work directly in this session. Do not invoke the CLI `import` command or the old fragment-translation pipeline from inside the session.

1. Call `archive_prepare_import`. It resolves the arXiv ID, reuses downloads and returns metadata, immutable original PDF/source paths, editable `tex_cn`, every TeX filename, and the current domain registry. Preserve existing work; inspect the differences before resuming a partially translated tree.
2. Establish a consistent bilingual terminology list from the paper. Translate all substantive prose, including appendices, footnotes, section titles, captions and table text. Work in the returned `tex_cn` tree with the normal file-editing tools. Figures, math-only macros, names, code, bibliography entries and unchanged figure assets may be preserved when appropriate. Never edit `tex_source` or the original PDF. Keep an audit of which prose files were translated and why any source files remain unchanged.
3. Preserve equations, citations, labels, numerical results and figure paths. Chinese sentence structure can move an unchanged variable mention relative to an unchanged equation; this is not mathematical corruption. For long files, use coherent sections with the paper's context and terminology rather than isolated line fragments. Perform the translation yourself in this Codex session, without another AI API or credential file.
4. Adapt the Chinese preamble (`ctex` with Fandol fonts is available in mainstream TeX distributions), identify the real main document, and call `archive_compile_translation` with its path relative to `tex_cn`. Read returned diagnostics and fix source/template problems, then compile again. Do not discard hard appendices, remove figures or replace substantive content just to obtain a PDF. Preserve diagnostics if a real missing dependency blocks compilation.
5. Read every original PDF page using `archive_read_import_pdf`, including relevant proofs, experimental details and other appendices. Use `archive_view_import_page` on original pages where text extraction makes figures or equations ambiguous. Research notes must be grounded in the full paper, not its abstract or a shortened digest. Read [reading notes](references/reading-notes.md) before writing the four Agent notes into the returned paper folder.
6. Call `archive_check_translation`. Inspect missing files, unchanged prose and mathematical differences against the source. Correct omissions and explain justified preamble or formatting changes in the translation review. Verify that the terminology remains consistent across files.
7. Visually inspect the actual final Chinese PDF with `archive_view_import_page`: title/first body page, a dense formula page, figures/tables, references, the middle physical page (`floor(page_count/2)`) and the last page. Look for missing Chinese glyphs, clipping/overflow, unreadable captions, lost equations and accidental untranslated prose. These checks belong to the final PDF; recompilation invalidates earlier image checks. When something is wrong, edit and compile again before repeating checks. Do not claim an unviewed page has been reviewed.
8. Read [classification](references/classification.md). Choose an active domain from the latest registry by the full paper's question and mechanism; respect manual assignments. Call `archive_finish_import` with Chinese title, domain ID, evidence-based reason, translation review and visual review. It validates the artifacts and recorded page coverage, writes metadata/card, moves a new package to its domain and refreshes the library. Complete any missing work it reports before retrying. Completion requires a successful receipt, not an agent statement or a PDF merely existing.

If a step is genuinely blocked, report the actionable cause and retain the partially completed package. Continue in the same thread on retry. Never overwrite manual notes (`Note.md`, `idea.md`, `insight.md`, `导读.md`), reading states, annotations or existing Seed decisions. Existing Agent notes should be preserved unless a clearly identified agent-owned draft needs completion; use a dated sibling for a substantive rewrite.

## External automation and API fallback

Source checkout: set `PAPER_ARCHIVE_HOME` to the checkout and `PAPER_VAULT_ROOT` to the user-selected vault, then run:

    python "$PAPER_ARCHIVE_HOME/scripts/archive.py" --vault "$PAPER_VAULT_ROOT" import <arxiv-id>

Packaged app: use its `paper-backend --cli --vault <vault> import <arxiv-id>` entry point. The command selects the configured import mode. Native Codex is the default; its model, reasoning effort and optional local SKILL.md path are separate import preferences. The API fragment pipeline remains an explicitly selected fallback.

The CLI may also run `domains` or `validate`. Do not infer that an unrelated incomplete package invalidates this paper's result. API keys belong to the user's environment or desktop key store and must never be printed or copied into this skill.
