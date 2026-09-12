# n000b CMS — System Spec (self-contained tour)

> **Purpose:** A model that reads this should understand exactly how the n000b CMS works *without*
> running the live tour. It is the distilled, LLM-readable version of the interactive walkthrough.
> **Scope:** the `html_fdar` instance at `D:\Work\_GIT\# n000b_cms\html_fdar`, live admin at
> `http://localhost:3200/admin/`. Screenshots referenced throughout live in
> `reference/n000b_cms/screenshots/` (paths below are relative to `docs/`).
> Parent plan: [cms-migration-plan.md](cms-migration-plan.md); raw walkthrough notes in
> [reference/n000b_cms/tour-notes.md](reference/n000b_cms/tour-notes.md).

---

## 1. What the CMS is (mental model)

A **build-time content tool**. You author content in the admin as a **block tree** (JSON), it is stored in
flat files, and the public site is **statically rendered** to HTML. There is no server runtime on the public
side — "security by absence."

Three layers, always separate:
1. **Admin SPA** (`http://localhost:3200/admin/`) — author/edit content in a visual block editor.
2. **Data store** — flat JSON files, one document per line, in `html_fdar/database/data/collections/`.
3. **Static renderer** — turns the stored JSON into the deployed HTML+assets site.

### Collection abstraction (important)
The admin is built around **collections**. The sidebar's top two items are content collections, **custom-made
per data type**:
- `Pages Work` → the `works` collection (each doc = a project/page of work).
- `Audio Playlists` → the `audio_player` collection.

The **`Database`** section is the **raw, schema-unaware** view of any collection (id + title + dates only).
So: **one data type ⇒ optional custom view; if none exists, fall back to the raw DB view.** Screens: custom
view `01-pages-work-overview.png`, raw view `02-raw-database.png`.

The rest of the sidebar is **fixed admin tooling**, not content data: `Files` (media buckets),
`DB Users`, `Database`, `Server Info`, `Live Log`.

---

## 2. The data model (block tree — ground truth)

```
page          → { sections:[section], name, customer, year, date, c_date, m_date, _id }
section       → { name, type:'fixed'?, label, class?, groups:[group] }
group         → block | columns
block         → { type, label, class?, data }              // data depends on type
columns       → { type:'columns', label, class?, columns:[[block...],[block...]] }
```

### Block types (all present in the editor)
| type | `data` shape | role | editor affordance |
|------|--------------|------|-------------------|
| `vars` | array of field defs `{type:'input'\|'tags', id, label, data, numeric?, db?}` | **data/metadata** | form grid; `db` wires tags to a collection |
| `media` | array of media records | **content** | gallery; references pool media by `_id` |
| `richtext` | HTML string | **content** | inline rich-text toolbar |
| `text` | string | **content** | auto-resize textarea |
| `input` | string | **data/variable** | single-line field (~ a variable) |
| `files` | array of file records | **content** | generic file list |

**Two classes of leaf block — keep this distinction in any serialization:**
- **Content** (renders into the page): `text`, `richtext`, `media`, `files`.
- **Data/variable** (a field / single value, often displayed separately): `input`, `vars`.

### `label` + `class` on every container
Every `section`, `group`, `block`, `columns` carries a **`label`** (editable name) and a **`class`**
(addable CSS class), recursively. Screenshot `13-naming-and-class-ux.png` (name → "Hello DeepSeek",
class → `customClass`).

### Columns = the layout primitive (explicit arrays)
```json
"columns": { "type":"columns", "label":"FDAR 3 Media Columns",
             "columns": [ [media], [media], [media] ] }
```
- **Explicit array-of-column-arrays**, not auto-balanced. Column N = the N-th array.
- Blocks inside a column get `parent_name: 'C1'/'C2'` → the editor labels them `C1-1`, `C2-1`, etc.
- Real example: `reference/n000b_cms/fixtures/westenergie-work.json` (the `works` doc `_id:NQgIroSLru3XfQF6`, "Westenergie Web APP").

---

## 3. Media pipeline (references, not embeds)

**A content block never stores the actual media bytes.** It stores a **reference** into the media *pool*:
```json
{ "bucket":"OHCYUOGZpiCB2BjB", "filename":"x.png", "ext":"png", "mime":"image/png",
  "_id":"<mediaId>", "media_post":{ big/medium/thumb avif|webp|jpg + thumb_cms, each {width,height,size} } }
```
The pool holds the bytes + **server-side generated variants** (sharp for images: `big/medium/thumb` avif/webp/jpg +
`thumb_cms`; ffmpeg frames for video: `mp4_snap_0000N.png`). See `03-files-buckets.png` (the bucket view showing
`westenergie_webapp.mp4_snap_00002.png … 00009.png`).

**Design consequence:** the document stays lean — only the reference. **Variant expansion happens at render.**
A markdown media block should likewise reference by `_id`/path and let render resolve variants.

---

## 4. Admin screens & routes

Routes are hash-based: `#page=<view>&id=<subid>`.

| route | view | screenshot |
|-------|------|-----------|
| `#page=pages_work` | custom `works` list (thumbnail + title + client + created/modified) | `01` |
| `#page=dbs&id=<collectionId>` | raw DB list of a collection (id + title + dates) | `02` |
| `#page=files&id=<bucketId>` | media bucket (thumbnail + filename + size + dates) | `03` |
| `#page=users` | user list | — |
| add-entry / edit | **Edit Entry** modal browser (block editor) | `04`–`16` |

> **Note:** the raw `collectionId` is the *file id*, e.g. `DvSm43mylqudDQg9` = `works`. Passing a bare
> collection *name* such as `id=works` triggers `{status:false, message:"Collection does not exist"}` while
> still showing a default list. Navigate to the real collection file id.

Sidebar (top→bottom): `Pages Work`, `Audio Playlists`, `Files` (sub: Audio / Herrbasan Music / Misc / Works /
Trash), `DB Users`, `Database` (sub: audio_player / works / works_categories / Trash), `Server Info`,
`Live Log`. Bottom status strip: `Uploading … 0 / 0 MB`.

ListView controls: `Sort by: Creation Date` dropdown + `Search` box; footer `Delete | <count> | Add Entry`.

---

## 5. The editor UX (the spec for authoring)

Open a doc → **Edit Entry** modal = the block editor. It models every entity as:

```
Header (type:'fixed')   ← the entity's designed metadata shape, seeded from editor_page_default
  1 Variables           (vars block: Project/Customer/Agency/Year/Location + Categories tags)
  2 Cover               (media block, one cover reference)
  3 Involvement         (vars block: numeric per-discipline)
Section …               ← free-form content sections you add below
  └─ group: block | columns
```

### Flows
1. **New entry** — `Add Entry` → blank editor **pre-seeded** with the fixed Header (`05-new-entry-blank.png`).
2. **Add section** — the `+` add-strip below the Header (and between sections) inserts an empty `Section`
   (`10-new-section-added.png`).
3. **Add block** — the `+` inside a section opens the **Insert Block** palette (`11-insert-block-dialog.png`):
   `Media / Text / Input / Richtext / Two Columns / Three Columns / FDAR Headline / FDAR Note /
   FDAR 2 Media Columns / FDAR 3 Media Columns`.
   - **Primitives** = Media, Text, Input, Richtext, Two/Three Columns.
   - **Composite presets** (multi-block, domain-branded) = `FDAR *` (e.g. FDAR 3 Media Columns = a `columns`
     block pre-filled with 3 `media` blocks).
4. **Add block inside a column** — same palette but **scoped to leaf blocks only** (`14-insert-block-in-column.png`).
   **No nested columns** (see §6).
5. **Fill columns** — each column is an empty slot with its own `+`; a filled Two Columns shows
   `C1-1 Media`, `C2-1 Text`, `C2-2 Richtext` (`15-two-columns-filled.png`).
6. **Per-container name/class** — click a label to edit the name (=> `label`); the `…` dots on the container's
   right → add a class (=> `class`), recursively.
7. **Save** — footer `Discard | Revert | Save Entry` (explicit; **no autosave of structure**).

### Media editor (3 paths, all deposit a reference into the block's `data[]`)
| path | action | screenshot |
|------|--------|-----------|
| **Upload** | `btn_upload` icon → file → server creates the media entity (auto) → block references it | `06` |
| **Browse + Add Selected** | `btn_browse` icon → media browser dialog (sort/search/virtualized list, multi-select, `Add Selected`) → appends selected pool media | `07`, `08` |
| **Drag-out-to-remove** | drag a thumbnail out of the thumbnail strip → removed from the block | `09` |

The media upload refresh is driven by **server-sent events** (`nu_sse.js`), and the sidebar status strip shows
`Uploading … Upload finished`.

---

## 6. Recursion bound — the key constraint (and the decision point)

Today the block recursion is **bounded**:
- **Section-level palette** → columns containers and composites allowed.
- **Column-level palette** → only **leaf blocks** (`Media/Text/Input/Richtext` + simple presets). **No columns
  inside a column.**

So the current tree depth is ~3 levels: `section → group → block | columns → [leaf blocks]`.

> The plan to "block-in-blocks-in-blocks" (unbounded recursion) is therefore a request to go **beyond** the
> current editor, not to mirror it. Bounded = format-mapping only; unbounded = editor **and** renderer must
> grow to handle arbitrary depth. This is the central open decision.

---

## 7. Data storage & backend

- `html_fdar/database/data/collections/<collectionId>.json` — one JSON object **per line** (a whole doc on one
  line). Verified: `DvSm43mylqudDQg9.json` = `works` (141 docs), `trash.json` = trash.
- Media pool + caches: `html_fdar/database/storage/cache/`; generated variants live beside the reference.
- Backend: Express (`Server/index.js`), storage backend switch via `DATABASE` env (`mongo`/`nedb`; plan intends
  `ndb`), media via sharp (images) + ffmpeg (video snaps). Endpoint contract `/col/*` must stay stable.

### Key source files
| what | path |
|------|------|
| block editor shell | `admin/nui/nui_cms_page_editor.js` |
| block factories | `admin/nui/cms_blocks/cms_block_{media,richtext,text,input,vars,files}.js` |
| page setup + templates | `admin/js/lib/pages_work.js` (templates, `editor_page_default`, save logic) |
| router / admin main | `admin/js/main.js` (routes, `main.go`, `main.nav`) |
| media list / browser | `admin/js/lib/admin_filelist.js` |
| SSE live update | `admin/js/lib/nu_sse.js` |
| live admin | `http://localhost:3200/admin/` |
| live site | `http://localhost:3200/` |

---

## 8. Driving the legacy admin programmatically (essential for an agent)

The legacy admin rejects `isTrusted:false` synthetic events, and lists/dialogs are custom-gesture-driven. But
**trusted CDP-level Playwright events pass**, and `{force:true}` bypasses the modal overlay hit-test.

- **Click / double-click:** `page.click(sel, {force:true})` / `page.dblclick('#work_<id>', {force:true})`.
- **Drag:** `page.mouse.down()` → `page.mouse.move()` (several steps) → `page.mouse.up()` — works for
  drag-out-to-remove.
- **Escape does NOT close NUI modals here.** Click the modal's `.close` (or a `.close` in the visible overlay).
- **Overlays:** several `.nui-overlay` elements; hidden ones are `display:none`, the visible one has a nonzero
  bounding rect (it is `position:fixed`, so `offsetParent` is null — test `getBoundingClientRect().height>0`).
- **Key selectors:** `button.btn_upload`, `button.btn_browse`, `.add` / `.top-add` (add-strips), `.close`,
  `.file-item.list-item.superlist-item` (media rows), `button:has-text("Add Entry")`, `button:has-text("Add Selected")`.
- **Pitfall:** a stray synthetic interaction can trigger a re-render that **drops unsaved structure**. If an
  added section disappears, re-open via "Add Entry". Prefer driving the user's own navigation for anything
  destructive; observe via screenshots otherwise.

### A safe per-step recipe
1. Open `http://localhost:3200/admin/` (or `#page=pages_work`).
2. To open a doc: read the list, pick the `#work_<id>` element, `dblclick` it (force).
3. Read state via `page.evaluate` over the visible `.nui-overlay` (by `height>0`), not the a11y tree alone.
4. Screenshot to a file, then read it back (view-image) — Playwright screenshot to disk works.

---

## 9. Quick reference for the markdown↔blocks mapping (direction)

```
# Page                             → section (label = heading text)
::: columns-2 .customClass         → columns group, 2 cols, class "customClass"
  ::: block media                  → media block (reference media by id/path)
  :::
  ::: block text / input           → content vs. variable block
  :::
:::
```
- Fenced `:::` containers enable recursion; `label` from name/heading, `class` from `.class` after the type.
- Media by reference; variants at render.
- **Bounded vs. truly-recursive** is open (§6).
