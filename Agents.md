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
`npm install`, no build step. **`NCMS_DATA_ROOT`** overrides the data root, which is what lets a test
take an isolated instance on a spare port instead of writing the live one.

⚠️ **`node --check <file>.js` does NOT validate the admin modules.** They are ES modules, and the check
silently passed a file that genuinely did not parse — a missing `)` survived it and was caught only by the
browser. Check them as ESM instead: `Copy-Item admin/js/app.js $env:TEMP/app-check.mjs; node --check
$env:TEMP/app-check.mjs`. The server-side files are CommonJS and `node --check` is fine for those.

| Path | What |
|---|---|
| `server.js` | routing, static serving, JSON API — glue only |
| `lib/store.js` | storage. Collections are declared by `data/meta/data.jsonl`; each is a folder under `data/` whose `data.jsonl` *is* the nDB database |
| `lib/http-error.js` | the error type carrying the wire contract |
| `lib/feed.js` | the event feed — an SSE hub with a per-client backlog, modelled on the old CMS's `put_log`/`pingFillLog`. Every mutation publishes, and **the response is the message**. Broadcasts carry a monotonic `seq`; a client applies from both channels without double-applying, and a `seq` jump means it must reload rather than replay a hole. Addressed messages (`hello`, `send`) take no `seq` — spending one would put a hole in every other client's stream |
| `lib/log.js` | the **request log** — every request, successes and failures, in a capped ring buffer read with a cursor. Deliberately *not* the feed: the feed carries changes and keeps reads off it, while a log wants the opposite. `server.js` supplies what is quiet (the three internal routes, the static roots, and the asset bytes — the original's `sendImage` exclusion, generalised). Nothing writes it to disk yet |
| `lib/legacy-ndb.js` | the nDB port of the **old CMS's** database seam (`collection(db,name)` → `getDocs`/`getDoc`/`add`/`update`/`delete`), so `Server/index.js`'s ~1620 lines port unedited. Verified by `tools/test-legacy-ndb.js`. Include it as the reference for how the old CMS's data behaves — a rebuild must be faithful to it, not to a guess |
| `admin/` | the SPA — NUI shell (`nui-app` + `nui-sidebar`), `nui-link-list` as the scope axis, `nui-list` as the pane, `nui-code-editor` for raw document editing. `admin/js/events.js` is the feed client (one `EventSource`, one ping loop, one watermark); `#feature=log` is the request-log screen, the one view that polls — with a cursor, because nothing waits on it; `#feature=maintenance` is the pool report. Nothing else polls |
| `tools/import-n000b.js` | one-shot migration of the old CMS's block tree into MD-Blocks entries — a client of the HTTP API, not a second writer. `--out <dir>` writes previews instead of importing, so the output can be checked with `modules/md-blocks/tools/validate.js` |
| `tools/probe-ndb.js` | checks the nDB behaviour the design decisions rest on (inert `schemas`, bucket scoping, `close()` and the folder lock, no cross-database read). A drift detector, not a test suite — it is expected to flip when the pin moves |
| `tools/test-pool.js` | the pool's integrity report and its sweep, on its own root. The assertions that matter are the destructive ones' prerequisites: a **tombstoned** asset's bytes must survive the sweep, and a **reservation still awaiting its bytes** must not be reported as missing them |
| `tools/test-model.js` | end-to-end proof of the proposed data model in its own `model-test` collection: definition in `meta.json`, one bilingual entry with shared/per-language facts and whole MD-Blocks documents, save + reopen + raw-edit, and refusals that leave data unchanged. Needs the server running |
| `tools/test-legacy-ndb.js` | the old CMS's database seam, shape by shape, against a throwaway root (`data/legacy-test`). Each assertion names the `index.js:NNN` call site it encodes, so a failure means the port diverged from the old CMS |
| `tools/test-feed.js` | the feed hub on its own: broadcast, the 50-entry backlog and its cap, addressable send, dead-client tolerance, and the two design claims — applying both channels yields each message once, and a capped backlog is detectable |
| `tools/test-feed-integration.js` | the wiring: a real server on a spare port, a real SSE stream, real mutations. Proves a mutation by one client reaches another's stream, that `scope` names what a message is about, and that reads and refusals stay off the feed. Needs **no** running server — it starts its own over `NCMS_DATA_ROOT` |
| `tools/test-log.js` | the request log on its own: the cap, the cursor, and the gap. Asserts the two ways a log goes *quietly* incomplete — entries dropped by the cap that a reader never saw, and a cursor that never advances because a query returned nothing |
| `tools/seed-demo.js` | fills a throwaway root with two collections, four entries and two buckets, for looking at the admin in a browser |
| `tools/test-media.js` | one real upload-to-processed-media path: uploads a real image, waits for the whole variant menu, checks every variant is servable, that a bucket move keeps the reference, and that reprocessing does not discard working variants. Needs the server running **and nMedia reachable** |
| `tools/test-media-failure.js` | fault injection for the failure path, which a healthy image job never exercises: makes nMedia unreachable then reachable again, proving a failure is recorded with its reason, a failed retry is recorded rather than thrown away, and the retry then succeeds. **Run with the server stopped** — it is a second writer on the same nDB files |
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

**Reach for the library before writing markup.** The admin is built from components, and hand-rolled divs
where one exists is the recurring mistake here — a log rendered as `div`+`span` columns has no table
semantics, no responsive card mode, and needs ~40 lines of CSS the component would have supplied. In use:
`nui-table` (any tabular view — the log and the pool report), `nui-card` (a report group), `nui-badge`
(a count or a status; **variant only when the count is actually a fault**, or the colour trains the reader
to ignore it), `nui-progress` (the upload bar — self-contained and reactive to `value`), `nui-button`,
`nui-button-container align="end"`, `nui-icon`, `nui-file-icon`, `nui-list` (the scopes), `nui-banner`
(via `notify`, failures only), `nui-notification-log` (the header bell — see below), `nui-tooltip`,
`nui-dialog` (via `nui.components.dialog`). Ours is only the
*frame*: a flex wrapper, the page head, and the scroll container a table cannot provide for itself.

⚠️ **`nui-table` decorates its rows once, at upgrade — there is no mutation observer.** A table whose rows
arrive later (a log tail) gets no `data-label`, and its responsive card mode silently loses every column
label. Set `data-label` on those cells yourself; a table assembled complete before it is inserted needs
nothing.

**Telling the user something is a two-channel decision, not a banner.** The notification store splits the
transient signal from the record: `nui.components.banner.show()` **logs by default**, so every failure we
surface also lands in the header bell and stays recoverable after the banner has closed itself. `log: false`
is for an echo whose effect the screen already shows — the pool sweep's result is visible in the report it
just refreshed, and logging it would turn the store into a transcript of the reader's own clicks and drain
the badge of meaning. So: `notify(msg, 'alert')` for anything the reader may need again, `{log:false}` for a
confirmation they are already looking at.

A notification names a thing, so it carries the thing's address. Media entries pass
`action: 'goto-bucket:<bucket>'`; `nui.registerAction('goto-bucket', …)` closes the panel and sets the hash —
the action fires on a click inside the popover, so nothing else would dismiss it, and leaving it open over
the view you just navigated to hides what you went to look at. The panel closes *before* the navigation
because the hash change does not touch the popover.

**`postproc` has one shape, not two.** `server.js` publishes the asset's own fields from both sites that
emit it — the reprocess route and the job driver's `asset-settled`. It used to be `{id, bucket, asset}` from
the driver, which made `postproc` the one message type whose shape depended on *how* it was produced; a
client reading the route's shape announced `"undefined is ready"`. **One type, one shape** — the message
vocabulary is a contract, and a second shape is a second contract nobody agreed to.

API, with the envelope `{status:true,data}` / `{status:false,error,message,detail}`:

| Method | Path |
|---|---|
| `GET` | `/api/events` — the SSE feed. Not an envelope response: the stream *is* the response and it stays open |
| `POST` | `/api/ping` — `{session}` → that client's drained backlog. The catch-up half; `session` comes from the `hello` frame |
| `GET` | `/api/log` — `?since=&limit=` → request-log entries after a cursor. Returns the current `seq` even when nothing matched, and `gap: true` when the cap dropped entries the cursor never saw |
| `GET` · `POST` | `/api/pool` — `GET` is the integrity report, `POST` the sweep. **Read then act**, never one call: the old CMS deletes inside its `files_check`, and a maintenance screen is the one place you open to look before you act |
| `GET` | `/api/nmedia` |
| `GET` · `POST` | `/api/buckets` |
| `PATCH` · `DELETE` | `/api/buckets/:id` |
| `GET` · `POST` | `/api/media` (list takes `?bucket=`; **POST reserves**: JSON `{filename, size, mime, bucket}` → a record with no bytes and a `ticket`) |
| `PUT` | `/api/media/:id/file` — the bytes, raw body + `X-Ticket`. Streams to the pool, clears the ticket, and hands straight to processing |
| `GET` · `PATCH` · `DELETE` | `/api/media/:id` |
| `POST` | `/api/media/:id/reprocess` · `/api/media/:id/restore` |
| `GET` | `/api/media/:id/file/:name` (`:name` is a variant name or `original`) |

Media is the **shared pool**: bytes on the filesystem under `data/media/pool/<assetId>/`, and the index —
asset records and buckets — in two nDB databases under `data/media/`. The authoring reference is
**`media/<assetId>/<filename>`** and resolves by **asset id**, which is what makes a bucket a *label*: moving
an asset between buckets edits that label only, and renaming or re-filing never invalidates a reference.
`lib/media.js` owns uploads, the variant menu, the nMedia client and the job driver; nMedia itself is never
started or restarted from here. See plan §6 and the brief's D7 for why the bytes sit outside nDB.

**The pool's integrity report answers four questions, and they are not four kinds of error** (`GET
/api/pool`). Telling them apart is the whole value: *unreferenced* bytes — nothing claims them, live or
deleted — are the only thing the sweep may remove; *restorable* bytes belong to a **tombstone** and are kept,
because removing them would destroy exactly what the tombstone exists to preserve; *missing bytes* is a
record whose original is gone (usually an abandoned reservation, which just needs deleting — an in-flight
upload is never listed); and a record *filed under a deleted bucket* is the **expected** aftermath of
deleting one, since `deleteBucket` tombstones and its assets keep their label so a restore brings the
organisation back. Reporting that last case as a fault would flag the design's own intended state. The
integrity read changes nothing; the sweep is a separate button.

**An upload is three acts, and the order is the point** (plan §A): *reserve* → *send* → *process*. The record
is created first, so the row appears before its bytes do and the row can show whose upload is in flight; the
bytes travel in their own request, which is the only way progress is reportable at all (`fetch` cannot report
upload progress, so the bytes step uses `XMLHttpRequest` — the one place the older API is simply better); and
processing follows the bytes on the server, as it does in the old CMS, so nothing an author does waits on
nMedia. The `ticket` is server-issued and is a **capability**: it is required to send bytes, it is never
broadcast (the reservation is published without it), it makes deleting a record that is still receiving its
upload refuse with `409 locked`, and it **expires** — `NCMS_TICKET_TTL_MS`, default 30 min — because without
an expiry an abandoned reservation would be permanently undeletable, locked by a capability nobody holds. The
progress itself is a fixed region under the sidebar axis (`#uploads`, sticky), driven by the request's own
progress event rather than the feed: the feed carries changes to *records*, and a byte counter is not one.

**Static responses are revalidated, not cached blind.** `server.js` sends an `ETag` and
`cache-control: no-cache` for the admin and NUI roots. The file on disk *is* the deployment here — there is no
build step — so a stale copy is not merely out of date, it is a changed API against an old client, which is
exactly how a working change looks broken. `no-cache` means "revalidate before use"; the `ETag` makes that a
cheap 304.

| Method | Path |
|---|---|
| `GET` · `POST` | `/api/collections` |
| `GET` · `PATCH` · `DELETE` | `/api/collections/:key` |
| `GET` · `PUT` | `/api/collections/:key/definition` |
| `GET` · `POST` | `/api/collections/:key/entries` |
| `GET` · `PUT` · `DELETE` | `/api/collections/:key/entries/:id` |

A collection's **definition** — languages, body policy, display field, per-field kind — lives in that
collection's own `meta.json` under a `cms` key, beside nDB's own keys, which are preserved untouched
(brief D1). nDB's `schemas` key in the same file is a different contract and is inert. `PUT` applies the
**D3a rule**: a declaration may only appear or change for a field that holds no values yet — a value is never
inspected to decide what it is — otherwise the change is refused in whole with `409 definition_conflict` and a
`detail.conflicts` list of entry ids, fields and codes. Nothing else in this file writes that key.

- **When a definition is present, it is the authority**: `cms.languages` supersedes the registry's
  `translatability`, and a collection created with a definition gets **no** registry language list. The admin
  reads the definition for those collections and the registry for legacy ones, and holds no second copy. A
  collection with no definition behaves exactly as before.
- **Entry saves are checked against the declared shape** (`400 invalid_entry`, `detail.problems`): a
  per-language value and a document variant may only be keyed by declared languages, a `docs[language]` value
  must be a **string** (`not_a_document`), and the body policy (`required | optional | none`) is enforced. A
  shared value is unchecked — it may be arbitrary JSON — and a missing translation is always allowed.
- **A `body` policy change is checked against existing entries** before it applies: `none` is refused while
  documents exist (`body_not_allowed`), `required` while any entry has none (`body_required`).
- **A defined collection's list label comes from its declared `display` field**, never from a guess. When an
  entry has no value for it, the summary carries `displayMissing` (the field name) with `title: null`, and the
  row shows `no <field>` with the id still visible; the label never silently falls back to the entry's name.
  Legacy collections keep the old heuristic. nDB returns object keys sorted, so stored objects must be compared
  by value rather than by string.

A collection is a declaration in `data/meta/data.jsonl` plus a folder of its own. The declaration
is load-bearing: `Database.open()` **creates** a database it cannot find, so membership is checked
before opening. `key` is the identity (the folder and the API path) and is immutable — `name` and
`translatability` are what `PATCH` edits.

An **entry** is `{name, slug, docs: {en, de?}}` plus `c_date`/`m_date`. Bilingual is **one entry with N
language variants**, never paired entries: the identity is shared and language-local data lives in each
variant's own frontmatter, so the slug is one and the title is per language. `translatability` is the
collection's policy about which variants may exist — declared but not yet enforced anywhere (plan §5).

Deletion is nDB's tombstone **plus** its document trash (`_trash/docs/data.jsonl`): nothing is
destroyed until the trash is emptied. `nDB`'s `trash_ttl` / `trash_purge_interval` options are the
hook for making that a policy rather than a manual act. Deleting a **collection** is the same
tombstone applied to its declaration — the folder and every document in it stay exactly where they
are. That is by design, for restore semantics, not a filesystem constraint. Upstream state, and the
order a later purge must follow (finish work → `close()` → drop the handle → remove files), are in the
plan §5.

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
