# n000b CMS → nui_wc2 Migration Plan

> **Status:** Draft v1 (2026-08-07) — reconnaissance complete, no code written yet.
> **Architecture revision 2026-09-12:** four pillars confirmed — storage **nDB** (napi, in-process),
> media postprocessing **nMedia** (Badkid HTTP endpoint `:3500`), logging **nLogger** (submodule),
> frontend/admin **nui_wc2** (https://github.com/herrbasan/nui_wc2). Backend revision (2026-09-12):
> **own zero-dependency `node:http` server** — no Express. No user management: auth is provided by
> **nPort** later; the API works with a supplied `user_id` (attribution/logging only).
> **Authoring format (2026-09-12):** content entries are authored in **MD-Blocks**
> (modules/md-blocks, https://github.com/herrbasan/md-blocks) — the block tree JSON of the old CMS is
> replaced by MD-Blocks as the document format; the renderer (`nui-blocks`) and the block-editor
> component are nui-side consumers. See invariants #2, #4, #6, #8.
> **Exit plan:** once these docs are cleaned up, `docs/cms-migration/` moves out of nui_wc2 and becomes
> a **new standalone project/repo** — the CMS rebuild's home.
> **Scope:** Cross-project. Repos: `nui_wc2` (modules/nui_wc2), `n000b_cms` (D:\Work\_GIT\# n000b_cms, frozen reference), rendered sites (html_fdar, html_raum), `nDB` (modules/nDB), `nMedia` (herrbasan/nMedia), `md-blocks` (modules/md-blocks).
>
> **Provenance:** This folder (`docs/cms-migration/`) is the **canonical** location (decided 2026-09-12;
> the former canonical `X:\documentation\CMS Migration\` in MCP storage was deleted). Intent: this effort
> becomes a **new standalone project/repo** eventually — until then, the plan lives here, adjacent to the
> library it feeds, holding the CMS tour screenshots/notes that inform the `nui-blocks` layout work.

---

## 1. Vision

Migrate the hand-built n000b CMS onto the nui_wc2 library, reviving it as the **publishing backbone for the user's public presence**:

- **Blog** — the prepared arc (Ghost → Language → Mistakes, AI liability series)
- **Published arena sessions** — curated landmark sessions (6 landmark / 8 fence / 37 evidence from the 2026-08 curation)
- **Music** — media blocks already handle audio/video natively

All three content types fit the existing block model without new block types: header vars + richtext + media. The tags collection (DB-backed taxonomy) just gains new entries.

### Target site: raum.com (2026-09-12)

The first deployment target is **https://raum.com/** — the existing static build (~164 flat HTML pages,
zero-dep `node tools/build.mjs`, `/de/` mirror, `llms.txt` per build; static build is permanent, decided
2026-09-07). nCMS becomes raum.com's **publishing backbone**: the renderer's output replaces the current
hand-maintained build input. Over time the site grows sections for **music** and **programming** on the
same backbone. Migration implication: the renderer must be able to reproduce (then exceed) the current
raum.com output — treat today's site as the visual/content baseline, not a constraint.

### Heritage: davidrenelt.de (the old CMS's shipped site)

**https://davidrenelt.de/#page=home** — the old CMS's public output, still live. Visually rich yet
incredibly fast — hash-SPA (`#page=` routes) over pre-rendered fragments, media from the
`/database/storage/cache/` variant pool. Its speed is the **UX benchmark**: the rebuild must not feel
slower. What it proves (and what carries over): the data model + media pipeline already sustained a
visually rich site with instant navigation — the SPA shell over SSR output (§1) is the same idea with
crawlable URLs added. What it lacked: per-URL SEO/GEO (hash routes), raw-MD availability, lean JSON
index — exactly what the new output pattern adds.

### Output pattern: SSR at build time — with a SPA shell (2026-09-12)

The CMS's output is a **server-side rendered static site**: the full site — every page, index, feed — is
generated from the data (entries + media pool) by the renderer, ahead of deployment. The admin/API edit
data; **rendering is a batch step over that data; the deployed artifact is the render output.** This is
the same pattern as the old system (spec §1), now named: SSR-at-build-time. Rationale: **SEO and GEO**
(AEO surfaces) need crawlable, complete HTML per URL.

**But SSR-first does not mean page-reload navigation.** The rendered site keeps its JS/CSS in a SPA
pattern — loaded once, then **only the needed HTML is fetched** on navigation (the nui_wc2 router's
HTML-fragment model). This is the hybrid:

- **Each article = simple static HTML representation of its MD-Blocks doc** — semantic, complete,
  crawlable, no JS required to read.
- **Raw MD is offered alongside** — every article exposes its MD-Blocks source (URL/content-negotiated;
  also feeds `llms.txt`/GEO consumers). Source of truth stays machine-readable.
- **Lean JSON data structures ship with the build** — search and quick navigation run client-side
  against a compact index (entry metadata, snippets, taxonomy), not against full documents.
- **The SPA layer is progressive enhancement** — no-JS visitors (and crawlers) get the full SSR pages;
  JS visitors get single-load navigation. No content is JS-only.

This resolves the SPA-vs-SSR tension explicitly: SSR is the *contract* (every URL is complete HTML +
raw MD + lean JSON); the SPA shell is the *experience* on top. nui_wc2 being SPA-built-around makes the
shell natural — the router already fetches HTML fragments, which is exactly the "load only the HTML we
need" pattern.

### Why this architecture matters (do not regress)

The CMS is a **build-time tool, not a runtime dependency**:

- Admin edits content in the flat-file store (nDB in the new system)
- Public site is statically rendered against that data
- Deployed artifact = HTML + assets + **raw MD per article + lean JSON index** + pre-generated media variants (avif/webp/jpg in big/medium/thumb + `thumb_cms`, served from `/database/storage/cache/`)
- No server runtime, no query surface, no auth surface, no injection surface on the public side
- **"Security by absence"** — you can't exploit what isn't there
- **No JS-only content** — the SPA shell (§1) is progressive enhancement; every URL is complete HTML without it
- Runs on any dumb HTTP hoster; performance = filesystem speed; longevity = decades

This is zero-dependency philosophy applied to infrastructure. The migration must preserve it exactly.

---

## 2. Invariants (must not break)

1. **The document format is MD-Blocks** (decided 2026-09-10; supersedes "block JSON schema stays
   stable") — spec: [modules/md-blocks/md-blocks-spec.md](../modules/md-blocks/md-blocks-spec.md).
   The old CMS's block-tree JSON (spec §2) is converted once; existing content migrates via a one-shot
   converter validated against `reference/n000b_cms/fixtures/westenergie-work.json`.
2. **Media pool + cache generation migrates to nMedia** (herrbasan/nMedia, HTTP service on Badkid,
   `http://192.168.0.100:3500`). The backend no longer shells out to sharp/ffmpeg itself — it hands
   raw uploads to nMedia (`POST /v1/upload` → `POST /v1/process` → poll `GET /v1/jobs/{id}` → fetch asset)
   and writes the resulting variants into the media pool / cache layout. Same output contract as today:
   `big/medium/thumb` avif/webp/jpg + `thumb_cms`, ffmpeg video snaps (`mp4_snap_*.png`), served from
   `/database/storage/cache/`. The variant *menu* is an invariant; *who computes it* is nMedia's job.
   ⚠️ nMedia never touches the pool directly — the CMS backend remains the orchestrator (upload, job
   polling, cache writes, pool bookkeeping). Never start/restart nMedia from CMS code; if `/health` fails,
   surface the error to the admin UI.
3. **Renderer consumes the same schema** — html_fdar/html_raum keep working throughout.
4. **Backend = own zero-dependency `node:http` server** (decided 2026-09-12 — no Express). The server
   carries only glue: routing, request parsing (incl. multipart upload), static serving, SSE for upload/postprocess
   events, and orchestration of nDB + nMedia. Storage is **nDB** (herrbasan/nDB, **napi in-process**);
   media postprocessing is **nMedia** (**the running Badkid endpoint** — see invariant #2). With nDB and nMedia
   handled, the server carries no data-engine or media-engine code of its own. Logging comes from **nLogger**
   (herrbasan/nLogger, zero-dep submodule). The frontend/admin SPA is built on **nui_wc2**.
   **No user management.** No user store, no login, no sessions — auth is provided by **nPort** later;
   until then the API accepts a plain `user_id` used for attribution and logging only.
   The old `/col/*` + `/storage/*` surface is **reference, not contract** (spec §7) — the new API is designed
   freely for its two clients (invariant #6).
   ⚠️ nDB's API is only **loosely modeled on neDB** — do NOT assume a drop-in replacement. Key structural difference: **no cursor chaining** (deliberate, performance — no lazy pipeline objects). neDB's `find(f).sort(s).skip(n).limit(m).exec()` collapses into flat one-shot calls: `query(ast)` / `queryWith(ast, {sortBy, sortDir, limit, offset})`, plus direct fast paths `find(field, value)`, `findWhere(field, predicate)`, `findRange(field, min, max)` (index-backed). Logical combinators live inside the AST (`$and`, `$or`, `$gte`...). Reference seam (verified 2026-08-07 in the old server): the storage adapter surface is just 5 Promise-returning methods per collection: `getDocs(options)`, `getDoc(options)`, `add(data)`, `update(options, data)`, `delete(id)`. Only non-trivial mapping: `getDocs` — the `find(query, projection).sort(sort)` chain folds into `queryWith(ast, {sortBy, sortDir, ...})`. Verify against real query patterns in the old `Server/index.js` route handlers (any `$in`/`$regex`/projection usage). nDB is battle-tested as the memory-system backend (incl. the 2026-07 bucket GC saga, fixed). Data migration: one-shot neDB JSONL → nDB import script (verify `_id` preservation).
5. **Only the admin SPA is rebuilt** — and it can be rebuilt incrementally, block type by block type, without breaking production.
6. **One API, two clients.** The HTTP API is the *single* editing surface; the admin SPA (nui_wc2) and
   LLM clients (the Chat app as direct API client) are equal consumers of the same contract. No admin-only
   backdoors — everything the block editor can do is available programmatically (entry CRUD, media maintenance,
   reprocessing). The contract is designed LLM-first: plain JSON, predictable errors, no UI-coupled state.
7. **Auth is external.** nPort provides auth later; nCMS itself has no users, sessions, or login. A `user_id`
   is supplied with requests and used for attribution/logging only.
8. **MD-Blocks is the document format.** Content entries are stored and authored as MD-Blocks
   (modules/md-blocks — spec: [modules/md-blocks/md-blocks-spec.md](../modules/md-blocks/md-blocks-spec.md)).
   The old CMS's block-tree JSON (spec §2) maps onto it; the block editor edits MD-Blocks documents, the
   renderer consumes them. Invariant #1 ("block JSON schema stays stable") is thereby **superseded**:
   the migration includes a one-shot converter from block-tree JSON → MD-Blocks for existing content
   (validated against `reference/n000b_cms/fixtures/westenergie-work.json`).

---

## 3. Data model & interaction reference

The old CMS's block tree, block types, templates, and editor interaction inventory are **specified in the
frozen spec** — [reference/n000b_cms/n000b_cms_spec.md](reference/n000b_cms/n000b_cms_spec.md) §2 (data
model), §5 (editor UX), §7 (storage & backend). They are not restated here. What carries forward:

- The **authoring/composition power** (sections → groups → columns → blocks, media references by
  `_id`, per-container label/class) must survive the MD-Blocks mapping — the MD-Blocks spec is the
  authority for the new serialization.
- The **collection abstraction** (one data type ⇒ optional specialized view, raw DB fallback) carries
  over as an admin-UI pattern.

### Admin tooling (goals 2026-09-12)

- **Raw database maintenance** — a schema-unaware document editor over any collection: list, open, edit
  the full document (MD-Blocks source or JSON), delete. This is the fallback view and the power tool;
  it goes beyond the old read-mostly `Database` view (spec §1).
- **Centralized upload/postprocessing management** — a dedicated surface for media jobs: upload queue,
  nMedia job progress (SSE), failure surfacing, manual reprocess/re-convert triggers (the old
  `/storage/createsizes` and `/storage/convert` equivalents). Replaces the old status strip + Live Log
  as the primary observability point for the media pipeline.

---

## 4. API Contract (the primary editing surface)

> The API is not admin plumbing — it is the **main authoring pathway** (LLM via the Chat app) with the
> admin SPA as an equal consumer. Designed LLM-first: plain JSON, predictable errors, no UI-coupled state.

### Principles

- **Resources, not verbs.** Flat REST over three resources: `collections`, `entries`, `media` (+ `jobs`
  for async work). The old `/col/*` + `/storage/*` surface is the reference for *coverage*, not shape.
- **MD-Blocks in, MD-Blocks out.** An entry's document body is its MD-Blocks source (string). The API never
  deals in the old block-tree JSON. Frontmatter is carried as-is (format stores, application profiles).
- **Validate on write.** Every entry create/update passes the MD-Blocks validator (spec §7) before persist;
  invalid docs are rejected with line/column errors — the LLM client can self-correct from the message.
- **Identity stamped server-side.** Media `kind` and ids follow the editor contract (spec §6.2/6.3): ids are
  stamped, never derived; the server is the trust boundary for reference integrity (spec §8).
- **`user_id` on every mutating request** (header). Attribution/logging only — no permission checks until
  nPort auth exists (invariant #7). The header slot for the future nPort token is reserved now.
- **Uniform envelope.** Success `{status:true, data:…}`; failure `{status:false, error:"machine_code",
  message:"human readable", detail:…}`. Machine-readable `error` codes are a stable contract for LLM clients.
- **Async media work is a job.** Uploads/postprocessing return a `job` resource immediately; progress via
  `GET /jobs/:id` polling and/or the SSE stream. Never block a request on nMedia.

### Surface (sketch — names settle at implementation)

| Resource | Endpoints | Notes |
|----------|-----------|-------|
| Collections | `GET /cols` · `POST /cols` · `PATCH /cols/:id` · `DELETE /cols/:id` | incl. trash semantics (see open questions) |
| Entries | `GET /cols/:col/entries` (sort/limit/offset/filter) · `GET /entries/:id` · `POST /cols/:col/entries` · `PUT /entries/:id` · `DELETE /entries/:id` | body: `{name, frontmatter?, doc}` where `doc` = MD-Blocks source; list views return metadata + snippet, not full docs |
| Media | `GET /buckets` · `POST /buckets` · `GET /buckets/:id/media` · `GET /media/:id` · `POST /media` (multipart) · `POST /media/:id/reprocess` · `DELETE /media/:id` | upload creates the pool entity (limbo/ticket like the old system) and kicks an nMedia job |
| Jobs | `GET /jobs` · `GET /jobs/:id` | nMedia orchestration state, owned by the CMS backend (invariant #2) |
| Events | `GET /events` (SSE) | upload progress, job state changes — feeds both the admin status UI and any client |

### Open API questions

1. **Trash semantics** — old system had a trash collection + bucket. Soft-delete for entries and media?
2. **Concurrency** — `m_date`-based optimistic locking on `PUT /entries/:id` (reject stale writes), or
   last-write-wins? An LLM client racing the admin UI is a real scenario.
3. **Render trigger** — with SSR-at-build-time (§1) the render is a batch job. Does saving an entry
   enqueue a (re)render automatically, or is rendering a separate explicit job/CLI step the API can
   invoke (`POST /render` style)? The renderer itself is a separate work item (open question #1).
4. **Query language for entry lists** — reuse nDB's query AST over the wire, or a simpler filter grammar?

---

## 5. Library Boundary Rule

> **Only universally useful components go into nui_wc2. Domain-specific modules live CMS-side, built WITH the library.**

- Library candidates must be generic (any app would want them)
- The block editor shell is deliberately CMS-side for now — its schema is the CMS's data model. Promote to library only if a second consumer appears. Premature promotion = bloat.
- The CMS is wc2's **first real consumer outside the Playground** — treat it as the library's stress test. Generic gaps discovered during integration feed back into wc2.

---

## 6. Component Audit — wc2 status vs. CMS needs

### Already in wc2 (verified against LLM-CHEATSHEET.md)

| Need | wc2 component | Notes |
|------|--------------|-------|
| Overview list | `nui-list` (addon) | Custom item templates, fixed item height, virtualization + lazy media loading already work |
| Sortable thumbnails | `nui-sortable` | FLIP animations, touch/mouse/keyboard, `nui-sortable-change` event |
| Modal flows | `nui.components.dialog.page(title, html, opts)` | Promise-based `result`; 2nd param is HTML content |
| Context menus | `nui-context-menu` (addon) | |
| Richtext | `nui-rich-text` (addon) | Zero-dep, native APIs, custom toolbars, image resize/drag-drop, `nui-rich-text-change` / `nui-rich-text-image` events. **Better than Trumbowyg — settled decision, no Trumbowyg port.** |
| Tags | `nui-tag-input` (core!) | `addTag/getValues/editable`; DB-backed suggestions via data binding, not component changes |
| Async selects | `nui-select` | `searchable`, `multiple`, `loadOptions(asyncFn)` |
| File upload | `nui-dropzone` + `nui.components.dropzone.create()` | |
| Video | `nui-media-player` (addon) | |
| Media preview | `nui-lightbox` (addon) | probably useful |
| Prompts | `dialog.prompt` | for editable labels/classes |

### wc2 gaps (small, generic — library work)

| Gap | Size | Why generic |
|-----|------|-------------|
| Sortable drag-out-to-remove | ~15 lines | Any reorderable list benefits. On pointerup outside container bounds → remove item + dispatch removal event instead of reorder. Proposed attribute: `removable` |
| nui-list / nui-rich-text feature diffs | TBD | Verify against CMS usage during fixtures phase; only generic diffs land in library |

### CMS-side modules (the bulk of the work)

| Module | Composes | Notes |
|--------|----------|-------|
| Block editor shell | sortable, context-menu, dialog.prompt, dialog.page | section/group/columns renderer, template palette, full-re-render + scroll memory + destroy() cleanup pattern from legacy editor |
| Media gallery block | nui-sortable + media-player + dropzone + lightbox | main preview, thumbnail strip (drag-out-remove), upload/browse overlays, limbo ticket semantics |
| Media browser dialog | dialog.page + nui-list + CMS API | sort/search, selection, ADD SELECTED |
| vars block | nui-input + nui-select + nui-tag-input | field-def-driven form grid, `db`-wired tags |
| text/input/files blocks | nui-textarea / nui-input / dropzone | trivial |
| Save/limbo logic | fetch | structuredClone, strip tickets, POST col/add\|edit |

---

## 7. Working Mode (decided 2026-08-07)

### nui_wc2 is not a framework — mandatory fluency (2026-09-12)

nui_wc2 is a **high-performance DOM-first web-component library** whose patterns deliberately run
**against what training data biases a model toward**. The ideal division of labor: the model shouldn't
have to think about UX patterns at all — **the components do the work**. But that only holds if the
model deeply knows the library; otherwise it falls back to framework habits (framework-shaped wrappers,
styled components, scattered listeners) that fight the library and produce broken UI.

**Rule for any session writing admin-SPA code:** read `modules/nui_wc2/LLM-CHEATSHEET.md` first, plus the
per-component docs (`documentation/components/`, `documentation/addons/`) for everything touched.
Known traps are catalogued in workshop memory (nui-conventions). Do not improvise against the library.

**Build in wc2 first, with real fixtures — not inside the CMS.**

Rationale: Playground demos = living documentation; library stays single source of truth; no coupling to CMS quirks. Correction loop: feed demos **real CMS data shapes** (copy a real collection JSON + slice of media cache into Playground as fixtures). Expect one revision pass at first CMS integration — that's the design working, not failure.

Calibration exercise first (smallest real component): sortable drag-out-remove. If playground fixtures predict CMS integration accurately, proceed with confidence.

**Sequence:**

1. Sortable drag-out-remove extension (calibration)
2. ~~Tags input~~ — EXISTS (nui-tag-input); verify DB-suggestion binding pattern only
3. nui-rich-text feature diff vs. Trumbowyg usage (paragraph, B/I, link, align, lists)
4. Media gallery block (CMS-side module, developed against fixtures)
5. Media browser dialog (composition)
6. Block editor shell (the big one)
7. Admin SPA migration, page by page

---

## 8. Visual Quality Bar

The legacy admin UI is **visually superior to current wc2 defaults**: density with hierarchy, monochrome restraint + ONE accent color, overlay economy, typography doing work. Current wc2 styling is LLM-averaged (generous padding, friendly radii, diluted accent usage).

**The CMS rebuild must not inherit wc2 defaults blindly.** The old admin UI (localhost:3200/admin + `admin/css/main.css`) is the visual reference. A deliberate design pass on `NUI/css/nui-theme.css` propagates everywhere (theme variables centralize everything). The CMS rebuild should establish the visual standard wc2 was missing.

---

## 9. Known Hazards

- **Legacy admin is hostile to synthetic events:** old nui routes pointer events through custom gesture handling that rejects `isTrusted:false` events. `element.click()` / `dispatchEvent` don't work. Lists are virtualized (DOM ≠ visible window). SPA with in-memory modal stacks — a wrong synthetic click can collapse the entire editor state. **Rule: in the legacy admin, the user drives, agents observe via screenshots only.**
- **Playwright module-script caching quirk** seen in other projects (works in real Chrome).
- **The `#` in the CMS path** (`D:\Work\_Aktive Projekte\# n000b_cms`) breaks some tooling (grep_search on that path returned empty; Select-String works).
- Legacy editor bug noted: `main.itemEditClose is not a function` when cancel flows hit the wrong dialog layer (stacked modals share button labels — Cancel/DISCARD ambiguity).

---

## 10. Open Questions

> **Method note (2026-09-12):** this project is too large to hold in one head. Counter-strategy:
> (a) the plan stays the single index — every work item is either *planned here* or *doesn't exist*;
> (b) sessions work **one section/component at a time** (models focus narrowly — so scope each session
> explicitly to one component and its two adjacent contracts); (c) the "Unowned boundaries" list below is
> the standing audit of cross-component contracts — reviewed before each phase starts, because that is
> where unplanned work hides. A clean LLM second-opinion pass (2026-09-12) seeded it.

### Unowned boundaries (cross-component contracts that no pillar owns)

**Tier 1 — sinks the project if unplanned:**

| # | Boundary | Why it falls between the cracks |
|---|----------|--------------------------------|
| B1 | **URL contract + redirect map** — old→new URL inventory (164 pages, DE/EN scheme, canonical) locked *before* templates are written | Join key between migration and SSR; belongs to neither |
| B2 | **Bilingual content model** — paired DE/EN docs vs one doc; missing-translation fallback; `hreflang`/switcher semantics | Language is a join dimension that only exists at the content-model layer |
| B3 | **Migration as reconciliation** — dry-run/diff harness, block-JSON→MD-Blocks conversion, media-URL→pool-id rewrite, orphan handling, id-preservation assertions — run *before* the one-shot | Work between "141 docs exist" and "valid MD-Blocks with stable ids" is unowned |
| B4 | **nDB durability** — file location, backup cadence, corruption/unopenable-db recovery story | In-process napi *feels* solved; nothing supervises the file |
| B5 | **Media readiness contract** — what editor/SSR show while variants are processing; does publish block on job completion? | "Requested but not rendered" state lives in the nMedia↔consumer gap; broken images ship here |
| B6 | **Build reproducibility & partial rebuild** — is the build a pure function of an nDB snapshot? Full-build duration? Dependency graph for one changed entry | Backend serves live state; the build reads the same store — *which* state a build sees is unspecified |

**Tier 2 — hurts repeatedly:**

| # | Boundary | Why |
|---|----------|-----|
| B7 | **Publish→deploy bridge** — who watches for "published" and triggers rebuild/deploy? (SSE notifies *editors*, not the *site*) | Trigger sits in neither SSE's nor the build's component list |
| B8 | **Fragment API contract** — what a "fragment" is, ETag/caching rules, same-content-different-URL | The PE shell implies a fragment endpoint the REST surface never names |
| B9 | **MD-Blocks evolution** — forward migration of existing docs when block types/presets change; validator version gate | Format+validator frozen as "finished"; evolution is temporal, owned by none |
| B10 | **Concurrent-writer semantics** — optimistic locking / lost-update prevention (LLM racing the admin SPA) | Two equal consumers = two writers; already open question #4 |
| B11 | **LLM validator feedback loop** — machine-actionable repair errors; idempotency keys on writes | The SPA tolerates a red reject; the LLM needs structured correction info |
| B12 | **SSE missed-event replay** — `Last-Event-ID` backlog or refetch-on-reconnect | Reconnect gap is invisible until an editor edits stale state |
| B13 | **Search index pipeline** — bilingual tokenization (umlauts/ß/compounds), one index vs two, sync on change, size budget | "Lean JSON index" is an output, not yet a schema or pipeline |
| B14 | **Media reference integrity & GC** — ref-counting on entry delete; broken-ref detection on pool delete | Media service and content model each assume the other is consistent |
| B15 | **Non-content i18n (chrome)** — UI strings, dates, plurals: nav/footer/buttons aren't entries | Collection-based model has no home for chrome strings |
| B16 | **UX micro-behavior capture** — the old CMS's *feel* (immediate feedback, latency budgets, interruption semantics) is perishable knowledge; capture as a behavior inventory via a narrated live session before it rots. Becomes acceptance criteria for the rebuild | The spec owns *what the old CMS did*; nothing owns *how it had to feel* — vision models included, they read screens but not UX |
| B17 | **nui_wc2 deep fluency** — models MUST internalize the library's counter-bias patterns (see Working Mode §7) before writing any admin code | Not a framework — a high-performance DOM-first web-component library whose patterns deliberately run against LLM training-data biases; without explicit study, models regress to framework habits and produce broken UI |

**Tier 3 — decide early, cheap now / expensive later:** acceptance/parity harness (page-inventory diff
proving "164 reproduced"), SEO artifact parity (sitemap, robots, OG images, canonicals), asset
fingerprinting/cache-busting for the load-once shell, draft/preview vs published state in the build,
observability for the zero-dep server, content export-to-files/git (disaster portability), scheduled
publish semantics, 404/feeds/a11y/perf-budget parity.

0. ~~Deployment modes for the pillars~~ — **DECIDED 2026-09-12:**
   - **nDB: napi, in-process.** The CMS backend embeds the Rust core via napi. `ndb serve` (resident
     HTTP daemon) stays unused — CMS data is modest (141 works docs + collections); no sharing, no
     multi-GB heap, so the daemon adds ops burden for nothing.
   - **nMedia: the running endpoint.** `http://192.168.0.100:3500` on Badkid — permanent resident,
     always up because other architecture apps already depend on it. LAN dependency is accepted by
     design; napi embedding is off the table.
1. **Renderer evolution for blog/arena/music** — readable typography, code blocks?, RSS/sitemap generation (static). Renderer-side work, not editor-side. Needs its own spec when we get there.
2. ~~Backend modernization~~ — **DECIDED:** neDB → nDB **and** sharp/ffmpeg in-process → nMedia
   (revision 2026-09-12). One-shot data import with `_id` preservation + verification pass. Media variant
   *output* stays identical; computation moves to nMedia.
3. ~~Auth/session model~~ — **DECIDED (2026-09-12): none in nCMS.** Auth is external (nPort, later);
   `user_id` only (invariant #7). The security-deferred cluster (#1040) applies if the CMS ever goes
   multi-user or public-facing.
4. **Where does the new admin live?** — Same repo/folder structure, or fresh `admin2/` alongside? (Legacy stays runnable during migration either way.)
5. **Arena session publishing format** — does an arena session need a dedicated transcript block type eventually, or is richtext + media sufficient?

---

## Appendix: Key Source Files (legacy)

| What | Path |
|------|------|
| Block editor shell | `admin/nui/nui_cms_page_editor.js` (16.5KB) |
| Block factories | `admin/nui/cms_blocks/cms_block_{media,richtext,text,input,vars,files}.js` |
| Page setup + templates | `admin/js/lib/pages_work.js` (templates @~265, editor_page_default, save logic) |
| Thumbnail editor | `admin/js/thumbEdit.mjs` |
| Server | `Server/index.js`, `Server/js/{mongo,nedb,backup,tools}.js` |
| Page collections (nedb) | `html_fdar/database/data/collections/*.json` |
| Media cache | `html_fdar/database/storage/cache/` |
| Frontend renderer | `html_fdar/js/main.js` (41KB) |
| Live admin | http://localhost:3200/admin/ |
| Live site | http://localhost:3200/ |
