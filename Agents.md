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

## Running it (2026-09-25)

```
node server.js          # http://localhost:3300/   (PORT env overrides)
```

Zero dependencies: `node:http` for transport, nDB (submodule) in-process for storage. No
`npm install`, no build step.

| Path | What |
|---|---|
| `server.js` | routing, static serving, JSON API — glue only |
| `lib/store.js` | storage. Collections are declared by `data/meta/data.jsonl`; each is a folder under `data/` whose `data.jsonl` *is* the nDB database |
| `lib/http-error.js` | the error type carrying the wire contract |
| `admin/` | the SPA — NUI shell (`nui-app` + `nui-sidebar`), `nui-link-list` as the scope axis, `nui-list` as the pane, `nui-code-editor` for raw document editing |
| `tools/import-n000b.js` | one-shot migration of the old CMS's block tree into MD-Blocks entries — a client of the HTTP API, not a second writer. `--out <dir>` writes previews instead of importing, so the output can be checked with `modules/md-blocks/tools/validate.js` |
| `data/` | content, not code — gitignored |

**NUI fluency — read this before writing any admin code.** In order: `documentation/DOCUMENTATION.md`,
then every file in `documentation/guides/`, then the entry in `documentation/components.json` for each
component touched (and its `docPath`). The authoritative shell reference is the library's own
**`Playground/index.html`**:

```
nui-app
├── nui-skip-links
├── nui-app-header → <header> with the sidebar toggle (data-action="toggle-sidebar") + <h1>
├── nui-sidebar → the nui-link-list DIRECTLY (no <nav> wrapper)
├── nui-content → nui-main
└── nui-app-footer (optional)
```

**Start from `modules/nui_wc2/nui-boilerplate/`** — it is the working base structure (`index.html`,
`js/app.js`, `js/page-init.js`, `pages/`, `css/main.css`). Copy it and adapt; do not assemble a shell
from component docs.

Rules the source enforces that the docs do not state:

- **`nui-sidebar` forces `mode="fold"` on its inner link list** when no mode is set. The sidebar's list
  *is* the navigation and it is a fold list. Never set `mode="tree"` on it.
- **The sidebar delegates the list API** (`setActive`, `getActive`, `getActiveData`, `clearActive`,
  `clearSubs`). Drive the sidebar, not the inner `nui-link-list`.
- **No navigation landmark is involved.** The list renders `role="tree"` and the sidebar adds none.
  (`guides/accessibility.md` claims the list upgrades to `role="navigation"` — that role belongs to
  `nui-skip-links`; the guide is wrong here.) So the `<nav>` wrapper is optional, not redundant.
- **Navigation is routed.** `nui.setupRouter({ container: 'nui-content nui-main', navigation:
  'nui-sidebar#nav-sidebar', basePath, defaultPage })`; nav items carry `href="#page=…"`/`#feature=…`
  and the router calls `setActive` on every `nui-route-change`. Screens are `pages/*.html` fragments via
  `nui.registerPage`, or `nui.registerFeature` for JS-built views — not one boot script.
- `nui.js` is imported as a module (`import { nui } from '../../NUI/nui.js'`); the boilerplate also sets a
  CSP meta with `'unsafe-eval'` and gates the shell with `nui-app:not(.nui-ready) { display: none }`.

**Header slots carry app identity and global controls only.** Page state — the current scope, entry
counts, filters — belongs in a page header inside the content area. Putting page state in the app header
is a mistake this repo has already made once.

API, with the envelope `{status:true,data}` / `{status:false,error,message,detail}`:

| Method | Path |
|---|---|
| `GET` · `POST` | `/api/collections` |
| `GET` · `PATCH` · `DELETE` | `/api/collections/:key` |
| `GET` · `POST` | `/api/collections/:key/entries` |
| `GET` · `PUT` · `DELETE` | `/api/collections/:key/entries/:id` |

A collection is a declaration in `data/meta/data.jsonl` plus a folder of its own. The declaration
is load-bearing: `Database.open()` **creates** a database it cannot find, so membership is checked
before opening. `key` is the identity (the folder and the API path) and is immutable — `name` and
`translatability` are what `PATCH` edits.

Deletion is nDB's tombstone **plus** its document trash (`_trash/docs/data.jsonl`): nothing is
destroyed until the trash is emptied. `nDB`'s `trash_ttl` / `trash_purge_interval` options are the
hook for making that a policy rather than a manual act. Deleting a **collection** is the same
tombstone applied to its declaration — the folder and every document in it stay exactly where they
are, which is also the only reliable option: nDB's Node API has no `close()`, so the database handle
stays open for the life of the process and Windows refuses to rename an open file (`EPERM`).

## Layout

- [docs/cms-migration-plan.md](docs/cms-migration-plan.md) — migration vision, invariants, plan (the living doc).
- [docs/reference/n000b_cms/](docs/reference/n000b_cms/) — everything about the **old** system, frozen:
  `n000b_cms_spec.md` (distilled spec — old-system facts live here, never in the plan), `tour-notes.md`
  (walkthrough notes — the current editor's UX is the format's spec), `screenshots/` (admin tour
  screenshots referenced by the spec), `fixtures/` (real CMS content export, `westenergie-work.json`).

## Submodules & key documentation

Submodules live in `modules/` — each on its tracked branch (never detached HEAD), so VS Code
surfaces upstream drift. Fast-forward sync only; never `git submodule update --remote`.

- `modules/nDB` — storage engine (napi, in-process). Docs: [modules/nDB/documentation](modules/nDB/documentation)
  — start with `architecture.md` and `nodejs-api.md` (nCMS is Node); also `query-language.md`,
  `common-patterns.md`, `file-buckets.md` (media storage), `cli.md`, `rust-api.md`.
- `modules/nui_wc2` — frontend/admin component library. Docs: [modules/nui_wc2/documentation](modules/nui_wc2/documentation)
  — `components.json` (registry), `components/` and `addons/` (per-component reference),
  `guides/` (getting-started, declarative-actions, architecture-patterns, utilities).
- `modules/md-blocks` — **the authoring format of the new CMS.** Spec:
  [modules/md-blocks/md-blocks-spec.md](modules/md-blocks/md-blocks-spec.md). Content entries are
  authored in MD-Blocks; the renderer (`nui-blocks`) and the block-editor component are nui-side
  consumers developed here.

## Editing model (vision)

The CMS exposes an HTTP API to create/edit/delete entries and maintain media — deliberately
LLLM-editable. Two editing pathways:

1. **The Chat app** as a direct client of the nCMS API (LLLM-driven authoring).
2. **The admin UI** with a block-editor — a new `nui_wc2` component to be developed in this project.

## MD-Blocks — moved to its own repo

The format was adopted 2026-09-10 as **MD-Blocks** and spun out the same day:
**https://github.com/herrbasan/md-blocks** — spec, decision record, demo documents, and the full
design history (proposals A–D, ranking, authoring test-runs) in its `_Archive/`. It is purely the
format — no CMS coupling. The renderer (`nui-blocks`) and the editor addon are nui-side consumers,
developed in this repo. (A consumer-side mapping doc `md-blocks-mapping.md` was deleted 2026-09-12;
the mapping knowledge lives in the spec and the renderer implementation.)
