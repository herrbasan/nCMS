# nCMS — Plan

> **Status:** v2 (2026-09-25) — **rewrite.** v1 organised the effort as a *component audit* followed by
> "admin SPA migration, page by page": it started at the library and arrived at the CMS. This version
> starts at the CMS and arrives at the library. v1's **verified facts** (nDB's API shape, the media
> variant menu, the invariants, the hazards) are carried forward; v1's **framing** is superseded.
>
> **Why it was rewritten.** The v1 approach failed on first contact: a build against it was rejected as
> "this works nothing like the old CMS". The reason is now identifiable. v1 was assembled from reading
> behaviour and probing structure, and the interaction model — the thing that makes the old CMS *feel*
> like itself — was never written down. It was inferred from components instead of observed from
> screens. That is the failure mode already documented in
> [reference/n000b_cms/ux-grammar.md](reference/n000b_cms/ux-grammar.md) §0: probing returns a confident
> answer about the wrong thing.
>
> **Method of this version.** A top-down walkthrough of the old CMS with David — screens one at a time,
> his explanation of *why* each arrangement exists, and deliberately **without reading the old
> implementation**. Recorded in [CMS_TopDown_View.md](CMS_TopDown_View.md), which is the companion
> document and the source of §2 and §3 below.
>
> **Old-system facts are not restated here.** Everything about the *old* CMS lives in
> [reference/n000b_cms/](reference/n000b_cms/) (`n000b_cms_spec.md` behaviour, `tour-notes.md`
> walkthrough, `ux-grammar.md` form, `screenshots/` visual). This plan is about the new one.
>
> **Architecture (confirmed 2026-09-12):** storage **nDB** (napi, in-process) · media **nMedia** (running
> Badkid endpoint `:3500`) · logging **nLogger** (submodule) · frontend/admin **nui_wc2** · backend
> **own zero-dependency `node:http` server** (no Express). Auth is **nPort**'s job, later.
> **Authoring format:** **MD-Blocks** ([modules/md-blocks](../modules/md-blocks/md-blocks-spec.md)).
>
> **Exit plan:** once these docs are stable, this folder becomes a **standalone project/repo** — the
> rebuild's home.

---

## 1. What is being built

An **admin for authoring structured documents** into a flat store, plus a **batch renderer** that turns
that store into a static site.

- **Build-time tool, not a runtime dependency.** No query surface, no auth surface, no injection surface
  on the public side — "security by absence". Preserve this exactly.
- **One API, two clients.** The admin SPA and LLM clients (the Chat app) are equal consumers of one HTTP
  contract, designed LLM-first. There are no admin-only backdoors.
- **First target:** raum.com's publishing backbone. Heritage reference: davidrenelt.de — the old CMS's
  shipped output, hash-SPA over pre-rendered fragments, visually rich and instant. Its speed is the UX
  benchmark; its data model and media pipeline are proven.
- **Output pattern:** SSR at build time **with** a SPA shell — every URL is complete HTML plus raw MD,
  navigation fetches only the fragment it needs. SSR is the *contract*; the shell is the *experience*.

---

## 2. The interaction model — the organising idea

> **A scope axis on the left. The *whole* of that scope in a single virtualized list on the right.
> Narrowing replaces navigating.**

This is not a detail of one screen. It is the CMS's entire interaction surface, and everything below is
either an instance of it or the one documented exception.

**Why it works, and what it deletes.** `nui-list` is virtualized, so rendering cost is a function of the
viewport rather than the list length. Because of that, a subsection is delivered to the client **entire**
and **pagination is deleted outright** — no page state, no cursors, no "load more", no page-bounds
arithmetic on filter change. Sort, filter and search then operate on data already in the client, so they
are instant and composable. Rows ship light (metadata + snippet), media lazy-loads through the list's own
throttle, and even 50 000 rows of text is kilobytes.

**Bound and escape hatch.** If a single category ever grows past what one list can hold sensibly
(~300 000 items by David's estimate), the answer is **not** paging — it is to split the category into
logical chunks. Scale is absorbed by the *shape of the sections*. For a CMS this is not a real
constraint: transmission and update, not storage or client memory, would bind first.

**A new screen is not a new design.** It is a new choice of scope axis. That is the whole point, and it is
why the rebuild is tractable: the interaction is implemented once and the screens are compositions.

---

## 3. Screen inventory

Every admin screen, as an instance of §2. (Old-CMS specifics: [CMS_TopDown_View.md](CMS_TopDown_View.md),
[reference/n000b_cms/](reference/n000b_cms/).)

| Screen | Scope axis (left) | The list (right) | Item | Actions on the axis |
|---|---|---|---|---|
| **Entries** — a content type | collection switch in the header | every entry in the collection | thumbnail, name, language, snippet | — |
| **Files** | bucket list | every file in the bucket | thumbnail, filename, size | create / delete bucket |
| **Database** (raw) | table list | every document in the table | id, title, created/modified | create / edit / delete table |
| **Trash** | — | everything unlinked | as its source list | restore / purge |
| **Server Info**, **Live Log** | — | fixed tooling, not content | — | — |

**The exception: the document editor.** Not a list. One screen that is not an instance of §2, and the
only place real complexity lives.

**And a finding from the live admin (2026-09-25): one document, two editors.**

- The **visual block editor** — reached from a content type's own view (which is why the custom view is
  the *specialized* entry point).
- A **raw JSON editor** over the whole document — observed from the raw `Database` route: an `Edit Entry`
  modal containing a code editor with the document's JSON, and its own Cancel/Save.

The old system's "one data type ⇒ optional specialized view, raw fallback" therefore applies to **editing**
as well as listing: the raw editor is the universal fallback that works for any document, and a custom
editor is an addition on top. This is the strongest structural result of the walkthrough and it should be
the shape of the new admin:

- **Raw editing is the floor, not a debugging tool.** Any document can always be opened and edited as
  text. It is what makes a new content type usable the moment its table exists.
- **The visual editor is an enhancement** layered over the same document, never the only way in.

> **Uncertainty, recorded deliberately:** I observed both editors on the same document but did **not**
> establish the rule that selects between them (it appeared to depend on the route the document was opened
> from, or on admin state). Do not encode a rule from this note — verify it against the live admin first.

---

## 4. What `nui_wc2` already provides

The old interaction model maps onto existing library components. **The work is composition, not
invention.**

| Old CMS | `nui_wc2` | Notes |
|---|---|---|
| left scope axis, multi-level | `nui-link-list` (core) | collapsible groups, active state, `mode="tree\|fold"`, **trailing row actions** |
| main pane, virtualized | `nui-list` (**addon**) | search + sort + filter + lazy media **built in** |
| raw document editing | `nui-code-editor` (addon) | live highlighting, line numbers — the JSON-editor path |
| prose editing | `nui-rich-text` (addon) | settled: **better than Trumbowyg, no port** |
| document rendering | `nui-markdown` (core) | MD-Blocks rendering, frontmatter, streaming |
| app shell | `nui-app` / `nui-app-header` / `nui-sidebar` / `nui-content` | sidebar = the scope axis container |
| modals, prompts | `nui-dialog` (core) | `dialog.page/confirm/prompt/alert` |
| row menus | `nui-context-menu` (addon) | |
| reordering | `nui-sortable` (core) | handles the editor's drag affordance |
| media pool | `nui-lightbox`, `nui-media-player` (addons) | |
| tags | `nui-tag-input` (core) | DB-backed suggestions via data binding |
| upload | `nui-dropzone` (core) | |
| tabular | `nui-table` (core) | structure only |
| notifications | `nui-banner` (core) | edge-anchored, singleton per placement |
| progress | `nui-progress` (core) | job progress |

**The row action — resolved 2026-09-25.** The old sidebar puts a gear on the `Database` row (a row that
owns children) to open the *set* editor, while its children carry the leading chevron. The axis therefore
has to carry an action that is a **control, not navigation**, on a row that is otherwise a container.

This was first recorded here as a **missing concept**. That was wrong, and the correction is the most
useful thing the first build step produced:

- `nui-link-list` already rendered such a control **declaratively** — the Playground demonstrates it.
- Its data-driven builder already had a `headerAction` key for it: group-headers only, hardcoded to the
  `settings` icon and `aria-label="Settings"`, **undocumented, and used nowhere in the library**.

So the gap was an **unfinished feature, not a missing one** — and neither the component doc, the registry,
notation nor the demo revealed that. Only reading the implementation did. **Treat §4's mapping as a starting
point to verify, not a specification.**

Generalized and shipped in `nui_wc2` `ae947d6`: `rowAction` works on any item at any depth, accepts a
data-action string or `{action, icon, label}`, keeps `headerAction` as an alias, and escapes attribute
values. It renders as a *sibling* of the link / group toggle, so clicking it never activates or expands the
row. Verified live: it fires `nui-action` with the right name and param while `a.active` stays null and
`aria-expanded` stays `"false"`.

**Other absences worth knowing** (from the library registry, 2026-09-22 — absence from the registry is not
proof of absence from the library): no split-pane primitive (the sidebar overlays rather than splitting),
no generic tree (only the filesystem-oriented `nui-file-tree`), no breadcrumb, no stacking toast (banner
is singleton), no date input, no standalone search field (it lives in `nui-select` and `nui-list`), no
form-level validation container. None of these block the pattern; they shape §11.

---

## 5. Storage and data model

- **nDB** (herrbasan/nDB, napi in-process) is the store. It was designed around this pattern.
- **Mostly schemaless entries.** A few fields every dataset needs; the rest is open JSON. Schema is
  defined **per table and optional** — a *view contract*, not a storage constraint, so it can change
  without migrating rows.
- **Buckets are labels, not directories.** One media pool; membership is a field on the item. Creating or
  deleting a bucket moves no bytes — it is an edit to membership metadata. The "filesystem" appearance is a
  view. nDB expresses this with file buckets plus its own bucket trash (`_trash/files/`).
- **Collections are separate document stores, not labels in one pool.** *Corrected 2026-09-25 while building
  build-order step 2:* an earlier draft of this section lumped collections in with buckets. They are not the
  same mechanism. The old CMS kept one file per collection, and the implementation keeps one nDB database
  folder per collection (`data/<key>/data.jsonl`), with `data/meta/data.jsonl` declaring which exist. That
  declaration is load-bearing: `Database.open()` **creates** a database it cannot find, so membership must
  be checked before opening or a typo'd key would silently bring a collection into existence.
- **Deletion is two-stage, and the stages mean different things.** Unlink → **trash** (item fully present,
  restorable) → purge (the **only** irreversible act). "Delete" in the first sense must never be what
  reclaims storage, or the distinction and its safety net collapse. **nDB provides this natively:** `delete()`
  tombstones the record and archives the full document to `_trash/docs/data.jsonl`, `restore(id)` brings it
  back, and `trash_ttl` / `trash_purge_interval` are the hook for making the purge a policy.
- **Considered, not committed:** auto-tiering trashed data to cold storage. If built, purge becomes a
  *policy* rather than a user action, and **restore must work from cold** — otherwise trash is a lie.
- **nDB API caveat (verified in v1):** only *loosely* modelled on neDB. **No cursor chaining** — no lazy
  pipelines. `find(f).sort(s).skip(n).limit(m).exec()` collapses to one-shot `query(ast)` /
  `queryWith(ast, {sortBy, sortDir, limit, offset})`, plus index-backed fast paths `find(field, value)`,
  `findWhere(field, predicate)`, `findRange(field, min, max)`. Combinators (`$and`, `$or`, `$gte`…) live
  inside the AST. The storage-adapter seam is **5 Promise-returning methods per collection**:
  `getDocs(options)`, `getDoc(options)`, `add(data)`, `update(options, data)`, `delete(id)`.
- **Data movement:** one-shot neDB JSONL → nDB import, `_id` preserved.

## 6. Media

- **A document never stores media bytes — it stores a reference** (`_id` + metadata). Variant expansion
  happens at render. This is what keeps entries lean and the list payload small.
- **The variant menu is an invariant:** `big/medium/thumb` in avif/webp/jpg + `thumb_cms`, plus ffmpeg
  frames for video (`mp4_snap_*.png`), served from the cache layout. *Who computes it* is nMedia's job.
- **nMedia computes; the CMS orchestrates.** Upload → job → variants; the backend owns job state, cache
  writes and pool bookkeeping. **nMedia never touches the pool directly.**
- **Never start or restart nMedia from CMS code.** If `/health` fails, surface it in the admin.
- Upload is asynchronous by contract: it returns a **job** immediately; progress comes from SSE and
  polling. No request blocks on nMedia.

## 7. API — the primary editing surface

Not admin plumbing: the **main authoring pathway** (LLM via the Chat app) with the admin SPA as an equal
consumer. Plain JSON, predictable errors, no UI-coupled state.

- **Resources, not verbs.** `collections`, `entries`, `media`, plus `jobs` for async work. The old
  `/col/*` + `/storage/*` surface is the reference for *coverage*, not shape.
- **MD-Blocks in, MD-Blocks out.** An entry body is its MD-Blocks source. The API never deals in the old
  block-tree JSON.
- **Validate on write.** Every write passes the MD-Blocks validator; invalid documents are rejected with
  line/column errors the LLM client can self-correct from.
- **Identity stamped server-side.** Media ids and `kind` follow the editor contract — ids are stamped,
  never derived.
- **`user_id` on every mutating request** (header), for attribution and logging only; the slot for
  nPort's future token is reserved now.
- **Uniform envelope.** Success `{status:true, data:…}`; failure `{status:false, error:"machine_code",
  message:"human readable", detail:…}`. Error codes are a stable contract.
- **Async media work is a job**, never a blocking request.

| Resource | Endpoints | Notes |
|---|---|---|
| Collections | `GET/POST /cols` · `PATCH/DELETE /cols/:id` | incl. trash semantics — see open questions |
| Entries | `GET /cols/:col/entries` (sort/limit/offset/filter) · `GET /entries/:id` · `POST /cols/:col/entries` · `PUT/DELETE /entries/:id` | body `{name, frontmatter?, doc}`; **list responses are metadata + snippet, never full documents** — this is what makes §2's "whole list to the client" cheap |
| Media | `GET/POST /buckets` · `GET /buckets/:id/media` · `GET /media/:id` · `POST /media` (multipart) · `POST /media/:id/reprocess` · `DELETE /media/:id` | upload creates the pool entity and starts a job |
| Jobs | `GET /jobs` · `GET /jobs/:id` | orchestration state, owned by the backend |
| Events | `GET /events` (SSE) | upload progress, job changes |

## 8. Backend and output

- **Own zero-dependency `node:http` server.** It carries glue only: routing, request parsing (incl.
  multipart), static serving, SSE, and orchestration of nDB + nMedia. No data-engine or media-engine code
  of its own. Logging via nLogger.
- **No user management.** No user store, no login, no sessions — nPort provides auth later.
- **SSR at build time with a SPA shell** (§1): rendered per-URL HTML + raw MD alongside + a lean JSON
  index shipped with the build for client-side search and quick navigation. Progressive enhancement — no
  content is JS-only.
- The public artifact is HTML + assets + raw MD + lean JSON + pre-generated media variants. It runs on any
  dumb HTTP host; performance is filesystem speed; longevity is decades.

## 9. Invariants (must not break)

1. **MD-Blocks is the document format.** The old block-tree JSON maps onto it; the renderer consumes it.
2. **The media variant menu migrates to nMedia** — same output contract, different producer.
3. **The build-time/static-output architecture holds.** No public runtime, no query surface.
4. **Backend is zero-dependency `node:http`** — no framework, no Express.
5. **One API, two clients.** No admin-only capability.
6. **Auth is external** (nPort). nCMS has no users.
7. **The interaction model of §2 is the admin.** A new screen is a new scope axis, not a new interaction.
8. **Raw editing is always available** for any document (§3) — the visual editor is an enhancement.

## 10. Library boundary

> **Only universally useful components go into `nui_wc2`. Domain-specific modules live CMS-side, built
> with the library.**

- The `nui-link-list` trailing row action (§4) is **generic** — library work.
- The block editor *shell* is **CMS-side**: its schema is the CMS's data model. Promote only if a second
  consumer appears.
- **nui_wc2 is not a framework, and the model must know it.** Its DOM-first patterns deliberately run
  against training-data habits. **Any session writing admin code reads `modules/nui_wc2/LLM-CHEATSHEET.md`
  plus the per-component docs first.** Do not improvise against the library.
- **Build in `nui_wc2` with real fixtures**, keep the demos as living documentation, and expect one
  revision pass at first integration — that is the design working, not failure.

## 11. Build order

Top-down: the pattern first, then the screens, then the editor.

1. **`nui-link-list` trailing row action** — **done 2026-09-25** (`nui_wc2` `ae947d6`). It was an
   unfinished feature rather than a missing one; §4 records the correction. It earned its keep as the
   calibration exercise: it exposed that the library's **docs and demos understate what the library can
   do**, so §4 must be verified against the implementation before it is trusted.
2. **The shell, and one screen end to end** — **done 2026-09-25** (`98fcf91`). `node server.js`, zero
   dependencies: `node:http` + nDB in-process. The axis is `nui-link-list`, the pane is `nui-list`, and the
   **raw/JSON editor** (`nui-code-editor` in a `nui-dialog`) was the first editing path, as planned — it
   makes every content type editable at once. Verified create → edit → save → delete against real MD-Blocks
   data, with the write landing as an append-only record and the delete as a tombstone plus a copy in nDB's
   own trash.
   *What it proved:* the pattern composes. A screen needed no new interaction design — only a choice of scope
   axis and a row renderer. *What it cost:* one runtime bug (teardown called `cleanUp()` before `remove()`,
   and disconnection calls it again) that the screen never showed — found in the console log, not the UI.
3. **Remaining screens** — the other scope axes (files/buckets, tables, trash) and their create/edit/delete
   axis actions. Each is a composition, not a design.
4. **The media surface** — upload, job progress via SSE, reprocess, failure surfacing.
5. **The block editor** — the outlier (§3), and the only screen that is genuinely new design. It has
   already diverged from the old reference; ux-grammar.md and the composed-editor screen
   (`screenshots/17-editor-composed-columns.png`) are the starting references, and the pending
   old-system screens (tour-notes §4, numbers 12/13/15/16) should be recovered before it starts.
6. **Renderer output** — reproduce, then exceed, the current raum.com build.

## 12. Hazards

- **The legacy admin is hostile to synthetic events.** v1 recorded that its gesture handling rejects
  `isTrusted:false`; the tour notes later found trusted Playwright clicks/drags (`{force:true}`) mostly
  solve it. **The honest position, re-confirmed 2026-09-25:** single click *selects*, double-click *opens
  the editor*, and a plain `element.click()` on a virtualized row **times out waiting for stability** —
  `.click()` is not equivalent to a user click even where it succeeds. Treat the old admin as a
  **read-mostly reference**: navigate and observe; do not compose in it.
- **Probe vs look** (ux-grammar §0). Structure is recoverable by measurement; **the design lives in the
  appearance, and measurement will confidently return a wrong answer about appearance.** Look first.
- **The `#` in `D:\Work\_GIT\# n000b_cms`** breaks some tooling.
- **The library registry is not a completeness checklist** — it is generated from Playground pages and
  omits registered elements (`nui-page`, `nui-sidebar`, `nui-content`, `nui-textarea`, and more).

## 13. Open questions

1. **Which editor opens, and when?** §3 records two editors over one document without the rule that
   selects between them. Verify against the live admin before designing.
2. **`nui-link-list` row action** — *resolved 2026-09-25*: generic, any item at any depth, with
   `headerAction` kept as an alias. Recorded as a decision rather than left as a question.
3. **Trash semantics** for entries and media — one trash, or per-collection?
4. **Concurrency** — `m_date` optimistic locking on write (reject stale), or last-write-wins? An LLM
   client racing the admin UI is a real scenario.
5. **Render trigger** — does saving enqueue a re-render, or is rendering an explicit job/CLI step?
6. **Query language for entry lists** — reuse nDB's AST over the wire, or a simpler filter grammar?
7. **Does the scope axis ever nest more than two levels** in the new admin? The old sidebar's `Database`
   group is the only multi-level case; the library supports more, and §2's model does not require it.
