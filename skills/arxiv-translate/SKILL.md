---
name: arxiv-translate
description: Import an arXiv paper into a user-selected Paper Archive vault, translate its LaTeX into Chinese, compile and verify bilingual PDFs, create research notes, and classify against the user's editable domain registry. Use when given an arXiv URL or ID for translation or collection.
---

# arXiv → Paper Archive

Use the user's own local Codex login or configured API provider. Do not embed an account, token, private URL, username, or personal directory in this skill.

## Resolve the workspace

- Use `PAPER_VAULT_ROOT` or the vault explicitly selected by the user. Never guess a different person's home directory.
- Source checkout: set `PAPER_ARCHIVE_HOME` to its directory, then use `python "$PAPER_ARCHIVE_HOME/scripts/archive.py" --vault "$PAPER_VAULT_ROOT" …`.
- Packaged desktop: invoke the bundled `paper-backend --cli --vault <vault> …` executable from the application's resources directory.
- Read `.paper-archive/taxonomy.json` in that vault before classifying. It contains user-defined domain names, descriptions, stable IDs, folder mappings, archived flags and manual paper assignments. See [classification](references/classification.md).
- Provider/model preferences live in `.paper-archive/state/preferences.json`. API keys come from `PAPER_API_KEY` or `OPENAI_API_KEY`; the desktop stores its key separately with OS encryption where available. Never print or copy a credential file. CLI usage cannot silently retrieve a desktop key; use the user's environment or local Codex.

## Run the complete workflow

1. Normalize the arXiv URL/ID and look for an existing record by the version-independent arXiv ID. Reuse complete packages. Different explicitly requested versions require a deliberate version update, never overwrite silently.
2. Run the automation command `import <arxiv-id>`. The implementation downloads original PDF and source, translates prose while checking commands/math/references, compiles with XeLaTeX without shell escape, reads all original pages in bounded batches, creates four research notes, and classifies with the current registry.
3. Follow the job to completion. A partial download or a PDF file merely existing does not mean the workflow succeeded. No TeX sources, missing compiler packages, failed structural checks or failed compilation must remain a visible incomplete task.
4. If repair is needed, inspect the retained source and compile diagnostic. Preserve existing original PDF, manual `Note.md`, `idea.md`, `insight.md`, `导读.md`, reading states and annotations. Do not convert a partial translation into a claimed full translation.
5. Visually inspect the resulting Chinese PDF: title, first body page, figures/tables/equations, a dense middle page and references. Check omitted content and layout failures in addition to compilation. If unavailable, disclose that visual review remains outstanding.
6. Run `validate` and report this paper's result. The validator may also report unrelated incomplete packages; distinguish them.
7. See [reading notes](references/reading-notes.md) for the content standard. Separate original evidence from hypotheses and avoid claiming exhaustive novelty verification.

The app executes a deterministic pipeline with the selected provider; it does not require this skill to be installed globally. This bundle supports external Codex automation and manual repair using the same taxonomy and file conventions.
