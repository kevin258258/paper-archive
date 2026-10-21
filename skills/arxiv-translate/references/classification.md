# User-owned classification

Read `<vault>/.paper-archive/taxonomy.json` on every import. Do not cache a fixed domain list in a skill or prompt.

- `domains[].id` is stable; `name` and `description` are editable. `folder` is the stable physical folder below `10-领域`.
- Exclude archived domains from new automatic classifications. Never invent a domain to make a result fit.
- Choose by the full paper's research question, mechanism and empirical evidence. Prefer the user's description over a broad title keyword match.
- Choose `unfiled` if evidence is insufficient. The user can create a domain in the UI and assign the paper later.
- `assignments[paper_id]` is an explicit human choice and outranks automatic classification. A paper ID is the first 20 hex characters of SHA-256 of the arXiv ID without its version suffix.
- A paper has one primary domain and may also appear in several related domains. `matches[domain_id][paper_id]` stores evidence-backed automatic memberships from a whole-library scan; `memberships[paper_id]` stores additional human choices. These do not relocate a paper or replace its primary domain.
- `exclusions[domain_id]` records papers explicitly removed by the user. Re-scanning must preserve these exclusions. Do not edit the registry directly to override a human decision.
- Creating or changing a domain through the app schedules a scan of the existing library by default. Every paper in the scan snapshot must have a decision; positives require a verified literal PDF quote and physical page. Confidence of at least 0.8 adds a related membership; uncertain positives stay reviewable suggestions. This is classification coverage, not a claim of reading every PDF page.
- UI reassignment is virtual: it preserves physical paths, Obsidian links and paper files. Renaming a domain does not rename its folder. New imports use the current registry folder mapping.
- Store classification ID and evidence-based reason in metadata. Do not change manual notes, reading status or an existing seed status.

Each complete package contains `metadata.json`, `00-论文卡片.md`, original and Chinese PDFs, `tex_source/`, `tex_cn/`, and the four Agent notes. New packages live in `10-领域/<domain.folder>/<arxiv-id>/`; interrupted work stays in `90-待整理/` and is reused on retry.
