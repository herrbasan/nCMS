# CMS Migration — working documents

> **Status:** Phase 2 in progress (2026-09-08). The authoring format was decided 2026-09-10
> (**MD-Blocks**) and lives in its own repo; the migration plan proceeds against it.
>
> **Canonical (2026-09-12):** this folder. The former canonical at `X:\documentation\CMS Migration\`
> (MCP storage) was deleted. Intent: this effort becomes a **new standalone project/repo** eventually.
>
> **Architecture (decided 2026-09-12):** storage **nDB** (napi, in-process) · media postprocessing
> **nMedia** (running Badkid endpoint `:3500`) · logging **nLogger** (submodule) ·
> frontend/admin **nui_wc2** (https://github.com/herrbasan/nui_wc2).

Two-phase effort:

1. **Understand & plan** — how the n000b CMS works and how it migrates onto nui_wc2.
2. **Authoring format** — define the markdown format that replaces the CMS's JSON block tree
   (sections → blocks | columns) while preserving the editor's composition power.

> **Note:** this file is the LLM briefing (`Agents.md`) for the CMS migration effort — named per the
> repo convention that every project root carries an `Agents.md`. When the folder is extracted into
> its own project, this becomes that project's root briefing.

## Layout

- [docs/cms-migration-plan.md](docs/cms-migration-plan.md) — migration vision, invariants, plan.
- [docs/cms-spec.md](docs/cms-spec.md) — self-contained spec of the existing n000b CMS (distilled from the live tour).
- [docs/reference/n000b_cms/](docs/reference/n000b_cms/) — the legacy-CMS tour: `tour-notes.md`
  (walkthrough notes — the current editor's UX is the format's spec), `screenshots/` (admin tour
  screenshots referenced by `cms-spec.md`), `fixtures/` (real CMS content export,
  `westenergie-work.json`).

## MD-Blocks — moved to its own repo

The format was adopted 2026-09-10 as **MD-Blocks** and spun out the same day:
**https://github.com/herrbasan/md-blocks** — spec, decision record, demo documents, and the full
design history (proposals A–D, ranking, authoring test-runs) in its `_Archive/`. It is purely the
format — no CMS coupling. The renderer (`nui-blocks`) and the editor addon are nui-side consumers,
developed in this repo. (A consumer-side mapping doc `md-blocks-mapping.md` was deleted 2026-09-12;
the mapping knowledge lives in the spec and the renderer implementation.)
