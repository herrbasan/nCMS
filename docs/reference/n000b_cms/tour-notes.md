# CMS Tour & `nui-blocks` Markdown Mapping

> **Status:** Working notes (2026-09-08) from a visual walkthrough of the n000b CMS.
> **Source:** live admin at `http://localhost:3200/admin/`, code at `D:\Work\_GIT\# n000b_cms`
> (instance `html_fdar`). Companion to the migration plan (`../../cms-migration-plan.md`).
> **Related work:** this feeds the `nui-blocks` design — replacing the CMS block-tree JSON with markdown,
> ideally with free recursion (blocks in blocks), while preserving the same authoring **UX**.

---

## 0. The one-line thesis

The CMS is a **build-time tool**: content is authored as a block tree (JSON), stored flat, and statically
rendered to HTML. We want markdown to become the **authoring format** for that tree — with the *same*
composition power (sections → groups → columns → blocks → media references) and, ideally, **unbounded
recursion**. The **UX of the current editor is the spec**: whatever markdown we design must let you do
everything the block editor does, at least as comfortably.

---

## 1. What the CMS is (from the tour)

- **Build-time, not runtime.** Admin edits JSON → public site is statically rendered → deployed artifact is
  HTML + assets. "Security by absence."
- **Collection abstraction.** Sidebar top two items = content collections, custom-made per data type
  (`works` → *Pages Work*, `audio_player` → *Audio Playlists*). The `Database` section = the **raw,
  schema-unaware** view of any collection (id + title + dates). **One data type ⇒ one optional custom view;
  no custom view ⇒ raw fallback.**
- **Fixed admin tooling** (not data): `Files` (media buckets), `DB Users`, `Database`, `Server Info`, `Live Log`.
- **Docs are one JSON per line** in `html_fdar/database/data/collections/<collectionId>.json` (verified:
  `DvSm43mylqudDQg9.json` = `works`, 141 entries).

---

## 2. The block tree / data model (ground truth)

```
page          → { sections: [section], name, customer, year, date, c_date, m_date, _id }
section       → { name, type: 'fixed'?, label, class?, groups: [group] }
group         → block | columns
block         → { type, label, class?, data }              // data depends on type
columns       → { type:'columns', label, class?, columns: [[block...],[block...]] }
```

**Block types (all observed in the editor):**

| type | shape | role |
|------|-------|------|
| `vars` | array of field defs `{type:'input'\|'tags', id, label, data, numeric?, db?}` | **data** — metadata form grid; `db` wires tags to a collection |
| `media` | array of media records | **content** — gallery; blocks reference pool media by `_id` |
| `richtext` | HTML string | **content** — prose (inline toolbar) |
| `text` | string | **content** — auto-resize textarea |
| `input` | string | **data** — single-line **variable** (a field, not prose) |
| `files` | array of file records | **content** — generic files (like media) |

**Two classes of leaf block** — this is a real distinction for the markdown model:
- **Content** (renders into the page): `text`, `richtext`, `media`, `files`.
- **Data/variable** (a field / single value): `input`, `vars`.

**`label` + `class`** exist on **every** container (section, group, block, columns), at any depth.

**Media is a reference, not an embed.** The block stores `{bucket, filename, ext, mime, _id, media_post{...sizes}}`;
the pool holds the bytes + generated variants (`big/medium/thumb` avif/webp/jpg + `thumb_cms`; ffmpeg `mp4_snap_*`
for video). Variants are **generated server-side** — the document never carries the actual media. **=> markdown
only needs to reference media by id/path; variant expansion happens at render.**

**`columns` structure** (the layout primitive, from `westenergie-work.json`):
```json
"columns": { "type":"columns", "label":"FDAR 3 Media Columns",
             "columns": [ [media], [media], [media] ] }
```
Explicit array-of-column-arrays. Column N = the N-th array. Blocks inside a column get `parent_name: 'C1'/'C2'`
→ shown as `C1-1`, `C2-1`, etc. in the editor.

---

## 3. The UX (the spec — as important as the features)

These are the concrete editor behaviors a markdown equivalent must reproduce.

### 3.1 Fixed header = the entity's designed shape
- Every entity starts with a **fixed `Header` section** (seeded by `editor_page_default`): `Variables` (Project /
  Customer / Agency / Year / Location + Categories tags), a `Cover` media block, and `Involvement` (numeric
  per-discipline). This is the entity's **metadata shape, defined in code** — every entity has it.

### 3.2 New entry flow
- "Add Entry" → blank editor **pre-seeded** with the fixed Header. You fill metadata, then add content **below**.

### 3.3 Composing content — the `+` strips
- **Add section**: a `+` add-strip below the Header (and between sections) inserts a new empty `Section`.
- **Add block**: a `+` inside a section opens the **Insert Block** palette.
- **Add block inside a column**: the same palette, but **scoped** to leaf blocks (see §3.6).

### 3.4 Insert Block palette (context-aware)
Section-level palette observed: `Media`, `Text`, `Input`, `Richtext`, `Two Columns`, `Three Columns`,
`FDAR Headline`, `FDAR Note`, `FDAR 2 Media Columns`, `FDAR 3 Media Columns`.
- **Primitives** (map straight to markdown blocks): `Media`, `Text`, `Input`, `Richtext`, `Two/Three Columns`.
- **Composite named presets** (multi-block, domain-specific): `FDAR Headline`, `FDAR Note`,
  `FDAR 2/3 Media Columns` (e.g. the 3-media-columns = a `columns` block pre-filled with 3 `media` blocks).

### 3.5 Media UX — three paths, all converge on a block reference
| path | behavior |
|------|----------|
| **Upload** (`btn_upload`) | file → server upload → **auto-creates a media entity** (limbo/ticket) → postprocessing (variants/snaps) → block references it. Refresh is via **SSE** (`nu_sse.js`), and the status strip shows `Uploading … Upload finished`. |
| **Browse + Add Selected** (`btn_browse`) | opens a **media browser** dialog over the pool (sort/search, virtualized list, multi-select, `Add Selected`) → appends selected media to the block. |
| **Drag-out-to-remove** | drag a thumbnail out of the strip → removed from the block (removal event, not a ✕). |

### 3.6 Columnal recursion is **bounded** (the key constraint)
- **Section level** palette: offers `columns` templates and composites.
- **Column level** palette: only **leaf blocks** (Media/Text/Input/Richtext + simple presets). **No columns-inside-a-column.**
- So today's editor recursion is: `section → group → block | columns → [leaf blocks]`. **Three bounded levels.**
- **=> "blocks in blocks in blocks" is a request to go *beyond* the current editor**, not mirror it. This is the
  central open decision (§6).

### 3.7 Per-container metadata
- **Name**: click the block/section label → edit it (maps to `label`). Confirmed: Two Columns → "Hello DeepSeek".
- **Class**: the `…` dots on the container's right → add a class (maps to `class`). Confirmed: `customClass`.
- So every container carries `label` + `class`, recursively.

### 3.8 Save semantics
- **Footer:** `Discard | Revert | Save Entry` — explicit save, no autosave of structure. Unsaved structure is
  volatile (a stray re-render drops it — observed when a test click re-rendered and lost an unsaved section).

---

## 4. Screenshots index (`screenshots/`, relative to this file)

| # | file | screen |
|---|------|--------|
| 01 | `01-pages-work-overview.png` | Pages Work overview (works list, sidebar, sort/search) |
| 02 | `02-raw-database.png` | raw DB view of a collection (id + title + dates) |
| 03 | `03-files-buckets.png` | Files/media bucket (ffmpeg `mp4_snap_*` thumbnails) |
| 04 | `04-work-editor.png` | work editor (Edit Entry modal, Header fixed section) |
| 05 | `05-new-entry-blank.png` | Add Entry → blank, pre-seeded Header |
| 06 | `06-upload-created-media.png` | Upload → media entity auto-created in Cover |
| 07 | `07-media-browser.png` | Media browser ("Add Media") over the pool |
| 08 | `08-cover-two-media.png` | Cover holding two media items (upload + browse) |
| 09 | `09-after-drag-remove.png` | after drag-out-to-remove (2 → 1 item) |
| 10 | `10-new-section-added.png` | `+` added a new empty Section below Header |
| 11 | `11-insert-block-dialog.png` | Insert Block palette at section level |
| 12 | `12-two-columns-inserted.png` | Two Columns template inserted (2 empty column slots) |
| 13 | `13-naming-and-class-ux.png` | renamed to "Hello DeepSeek" + class `customClass` |
| 14 | `14-insert-block-in-column.png` | Insert Block inside a column (leaf blocks only) |
| 15 | `15-two-columns-filled.png` | filled columns (Media / Text / Richtext) |
| 16 | `16-input-block-added.png` | added `input` block (the variable type) |

> The screenshots were captured with a **trusted** Playwright mouse/click/drag (CDP-level → `isTrusted:true`,
> which the legacy admin's gesture handler accepts). `page.click/dblclick/mouse({ force:true })` was the trick
> that both satisfied `isTrusted` **and** bypassed hit-testing overlays. The §9 hazard ("legacy admin hostile
> to synthetic events") is largely solved by this approach — verified for clicks, double-clicks, and drags.

---

## 5. Proposed markdown ↔ blocks mapping

### 5.1 The grammar (fence-based container syntax, `:::`)

```
# Page                             → section (top-level heading); label = heading text

::: columns-2 .customClass         → columns group (2 cols), class "customClass"
  ::: block media
  ![alt](image-id-or-path)         → media block referencing pool media
  :::

  ::: block text
  This is prose.                   → text block (data)
  :::

  ::: block input
  variable:value                   → input block (a variable)
  :::
:::
```

**Key points:**
- Sections anchor on top-level headings (free sectioning) or an explicit `::: section` marker.
- `columns-N` = container with N columns; each `::: block …` inside = a sub-block; **each column break must be
  explicit** (`columns: [[],[],[]]` is explicit arrays — markdown should be too, e.g. a `---` or a marker).
- `label` ← container name / heading; `class` ← `.class` after the type.
- `media` references by `_id`/path; **variants expand at render**, the doc stays lean.
- `input` is a **data/variable** block, distinct from `text` (content). Mark `variable` in the syntax.

### 5.2 The tension (recursion vs. invisibility)
- **HTML comments** (`<!-- nui: ... -->`): invisible in *every* renderer, but **poor for recursion/authoring**.
- **Fenced containers** (`:::`): clean recursion + authoring, but a generic markdown renderer shows the fences.
- **Decision:** since markdown becomes the **single source** for the CMS/site (not a layering on prose),
  **drop the "invisible everywhere" goal** and use fences. The renderer handles them; you don't care about
  GitHub's opinion.

### 5.3 The recursion decision (THE fork)
| Option | meaning | cost |
|--------|---------|------|
| **A. Mirror current editor** | columns → leaf blocks only (bounded, 3 levels) | format-mapping only; matches editor exactly |
| **B. Truly recursive** | columns-in-columns, blocks-in-blocks unbounded | **schema + editor UI + renderer** must all grow to handle arbitrary depth |

This is the difference between "a parser task (days)" and "an architecture change (weeks)." Not yet decided.

---

## 6. Open decisions for the next session

1. **Canonical tree kept, markdown = serialization layer?** Recommend YES: `markdownToBlocks(md)` +
   `blocksToMarkdown(tree)` (bidirectional), tree stays the in-memory/editor/renderer model. Avoids forking.
2. **Bounded (5.3-A) vs truly recursive (5.3-B)** — determines scope.
3. **`label`/`class` syntax** — where they live (fence attributes vs heading text).
4. **Media referencing** — by `_id` (pool) vs by path; variant resolution strategy.
5. **Arena sessions / blog** — the plan's Open Question #5: do published arena sessions use the same block model,
   and if so, markdown is the natural authoring format (converges with `nui-markdown`/`nui-blocks`).

## 7. Test fixture
`docs/cms-migration/docs/reference/n000b_cms/fixtures/westenergie-work.json` — the real `works` doc
(`_id: NQgIroSLru3XfQF6`), pretty-printed, showing header + a `columns` block (`FDAR 3 Media Columns`).
Use this to validate the markdown↔blocks parser against a real (non-trivial) shape.

## 8. The synthetic-click technique (for future exploration)
- `page.click/dblclick(sel, { force:true })` → trusted CDP mouse event + bypass overlay hit-test.
- `page.mouse.down()/move()/up()` → trusted drag (works for drag-out-to-remove).
- `page.keyboard.press('Escape')` did **not** close NUI modals here; click the modal's `.close` instead.
- A stray re-render drops **unsaved** structure — re-open via "Add Entry" if an edit disappears.
