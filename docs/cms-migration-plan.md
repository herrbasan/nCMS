# n000b CMS → nui_wc2 Migration Plan

> **Status:** Draft v1 (2026-08-07) — reconnaissance complete, no code written yet.
> **Architecture revision 2026-09-12:** four pillars confirmed — storage **nDB** (napi, in-process),
> media postprocessing **nMedia** (Badkid HTTP endpoint `:3500`), logging **nLogger** (submodule),
> frontend/admin **nui_wc2** (https://github.com/herrbasan/nui_wc2). Express demoted to thin glue
> (auth, `/col/*`, SSE, orchestration). See invariants #2 and #4.
> **Exit plan:** once these docs are cleaned up, `docs/cms-migration/` moves out of nui_wc2 and becomes
> a **new standalone project/repo** — the CMS rebuild's home.
> **Scope:** Cross-project. Repos: `nui_wc2` (D:\Work\_GIT\nui_wc2), `n000b_cms` (D:\Work\_Aktive Projekte\# n000b_cms), rendered sites (html_fdar, html_raum), `nDB` (herrbasan/nDB), `nMedia` (herrbasan/nMedia).
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

### Why this architecture matters (do not regress)

The CMS is a **build-time tool, not a runtime dependency**:

- Admin edits JSON in nedb flat files
- Public site is statically rendered against that data
- Deployed artifact = HTML + assets + JSON + pre-generated media variants (avif/webp/jpg in big/medium/thumb + `thumb_cms`, served from `/database/storage/cache/`)
- No server runtime, no query surface, no auth surface, no injection surface on the public side
- **"Security by absence"** — you can't exploit what isn't there
- Runs on any dumb HTTP hoster; performance = filesystem speed; longevity = decades

This is zero-dependency philosophy applied to infrastructure. The migration must preserve it exactly.

---

## 2. Invariants (must not break)

1. **Block JSON schema stays stable** — or a one-shot migration script. The schema IS the product.
2. **Media pool + cache generation migrates to nMedia** (herrbasan/nMedia, HTTP service on Badkid,
   `http://192.168.0.100:3500`). The Express backend no longer shells out to sharp/ffmpeg itself — it hands
   raw uploads to nMedia (`POST /v1/upload` → `POST /v1/process` → poll `GET /v1/jobs/{id}` → fetch asset)
   and writes the resulting variants into the media pool / cache layout. Same output contract as today:
   `big/medium/thumb` avif/webp/jpg + `thumb_cms`, ffmpeg video snaps (`mp4_snap_*.png`), served from
   `/database/storage/cache/`. The variant *menu* is an invariant; *who computes it* is nMedia's job.
   ⚠️ nMedia never touches the pool directly — the CMS backend remains the orchestrator (upload, job
   polling, cache writes, pool bookkeeping). Never start/restart nMedia from CMS code; if `/health` fails,
   surface the error to the admin UI.
3. **Renderer consumes the same schema** — html_fdar/html_raum keep working throughout.
4. **Backend shrinks to a thin glue layer.** Express keeps only what has no better home: auth/session,
   the `/col/*` endpoint contract (admin SPA and tooling keep working against it), SSE upload events, and
   orchestration of nDB + nMedia. Storage migrates **neDB → nDB** (herrbasan/nDB, **napi in-process** —
   decided 2026-09-12); media postprocessing migrates **sharp/ffmpeg in-process → nMedia** (**the running
   Badkid endpoint**, decided 2026-09-12 — see invariant #2). With nDB and nMedia handled, Express carries
   no data-engine or media-engine code of its own. Logging comes from **nLogger** (herrbasan/nLogger,
   zero-dep submodule) — the CMS's console logging migrates to it. The frontend/admin SPA is built on
   **nui_wc2** (https://github.com/herrbasan/nui_wc2).
   ⚠️ nDB's API is only **loosely modeled on neDB** — do NOT assume a drop-in replacement. Key structural difference: **no cursor chaining** (deliberate, performance — no lazy pipeline objects). neDB's `find(f).sort(s).skip(n).limit(m).exec()` collapses into flat one-shot calls: `query(ast)` / `queryWith(ast, {sortBy, sortDir, limit, offset})`, plus direct fast paths `find(field, value)`, `findWhere(field, predicate)`, `findRange(field, min, max)` (index-backed). Logical combinators live inside the AST (`$and`, `$or`, `$gte`...). First implementation task: write `Server/js/ndb.js` against the **existing adapter seam** (verified 2026-08-07): `index.js` switches backends via `DATABASE` env var (`mongo`/`nedb` — mongo.js still present, proving the mechanism). The adapter surface is just 5 Promise-returning methods per collection: `getDocs(options)`, `getDoc(options)`, `add(data)`, `update(options, data)`, `delete(id)`. Only non-trivial mapping: `getDocs` — the `find(query, projection).sort(sort)` chain folds into `queryWith(ast, {sortBy, sortDir, ...})`. neDB ceremony disappears (no autoload, no compaction.done waits, no callback wrapping). Add `DATABASE == 'ndb'` to the switch. Estimated ~30-60 lines. Verify against real query patterns in `index.js` route handlers (any `$in`/`$regex`/projection usage). nDB is battle-tested as the memory-system backend (incl. the 2026-07 bucket GC saga, fixed). The `/col/*` endpoint contract must not change — admin SPA and any tooling keep working against it. Data migration: one-shot neDB JSONL → nDB import script (verify `_id` preservation).
5. **Only the admin SPA is rebuilt** — and it can be rebuilt incrementally, block type by block type, without breaking production.

---

## 3. The Data Model (ground truth)

A page is one JSON document: `{ sections: [...] }`

```
section:  { name, type: 'fixed'?, label, class?, groups: [...] }
group:    block | columns
block:    { type, label, class?, data }            // data shape depends on type
columns:  { type: 'columns', label, class?, columns: [[block...], [block...]] }
```

**Block types (existing):**

| type | data shape | notes |
|------|-----------|-------|
| `vars` | array of field defs `{type: 'input'\|'tags', id, label, data, numeric?, db?}` | form grid; `db` wires tags to a collection |
| `media` | array of media records `{bucket, filename, ext, mime, _id, media_post{...variants}}` | gallery; blocks REFERENCE pool media by `_id` |
| `richtext` | HTML string | Trumbowyg output in legacy |
| `text` | string | plain auto-resize textarea |
| `input` | string | single-line |
| `files` | array of file records | like media but generic files |

**Templates:** two meanings —
- **Block palette** (`templates` array): plain data presets shown in Insert Block dialog. Includes pre-composed composites (e.g. "FDAR 2 Media Columns" = columns block pre-filled with media blocks). Selected template is `structuredClone`d and spliced into the tree.
- **Page template** (`editor_page_default`): initial document for new pages. The `type: 'fixed'` header section (vars + cover + involvement) is defined here.

**Sentinels:** `'!lorem'` in data expands to generated placeholder content at render time.

**Column addressing:** blocks inside columns get `parent_name: 'C1'/'C2'/...` for header labels (e.g. `C1 / 2`).

---

## 4. Interaction Inventory (from live recon 2026-08-07)

- **Overview:** sortable thumbnail list (old nui-list), dblclick → Edit Entry modal page
- **Editor chrome:** drag handle, block number, editable label (click → prompt), editable class, ✕ delete, ⊕ add-strips between every element (top-add + footer), context menu on headers (Get Data / Re-Render)
- **Insert Block dialog:** modal page + selectable list of palette templates, Cancel/Add
- **Media block:** main preview (image or video w/ player), pagination dots, thumbnail strip = sortable with **drag-out-to-remove**, overlay buttons: upload (creates limbo media w/ ticket) + browse (media browser)
- **Media browser dialog:** modal page + virtualized nui-list (rich rows: thumb, filename, size, dates), sort header + search, single/multi selection, ADD SELECTED appends to block gallery
- **Richtext block:** inline Trumbowyg toolbar (paragraph, B/I, link, align, lists)
- **Vars block:** 2-column form grid; tags field = chips + dropdown wired to a DB collection
- **Save semantics:** explicit DISCARD / REVERT / SAVE ENTRY footer. On save: `structuredClone`, strip media `ticket`s (limbo cleanup), POST `/col/add` or `/col/edit`
- **Rendering check:** editor changes visible immediately at `/#page=project&id=<id>` — same JSON, static renderer, media via pre-baked cache variants

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

0. ~~Deployment modes for the pillars~~ — **DECIDED 2026-09-12:**
   - **nDB: napi, in-process.** The CMS backend embeds the Rust core via napi. `ndb serve` (resident
     HTTP daemon) stays unused — CMS data is modest (141 works docs + collections); no sharing, no
     multi-GB heap, so the daemon adds ops burden for nothing.
   - **nMedia: the running endpoint.** `http://192.168.0.100:3500` on Badkid — permanent resident,
     always up because other architecture apps already depend on it. LAN dependency is accepted by
     design; napi embedding is off the table.
1. **Renderer evolution for blog/arena/music** — readable typography, code blocks?, RSS/sitemap generation (static). Renderer-side work, not editor-side. Needs its own spec when we get there.
2. ~~Backend modernization~~ — **DECIDED:** neDB → nDB **and** sharp/ffmpeg in-process → nMedia
   (revision 2026-09-12). Endpoint contract stable. One-shot data import with `_id` preservation +
   verification pass. Media variant *output* stays identical; computation moves to nMedia.
3. **Auth/session model** — current admin uses session cookies; unchanged for now, but the security-deferred cluster (#1040) applies if the CMS ever goes multi-user or public-facing.
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
