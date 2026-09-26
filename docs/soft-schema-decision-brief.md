# Decision brief — nDB-native collection definitions, bilingual shape, media ownership

> **Purpose.** Input for a **second opinion** (and for ourselves). It states what is *verified with
> evidence*, what we *propose*, and where we *suspect our own blind spot* — so a reviewer can attack the
> reasoning rather than re-derive it. Written 2026-09-26.
>
> **Status:** working document. Nothing here is decided except where it says so.
> Companion: [cms-migration-plan.md](cms-migration-plan.md) (§5 data model, §13 open questions).

---

## 1. Context in ten lines

- **nCMS** is the new admin for authoring structured documents into a flat store, plus a batch renderer to a
  static site. Zero-dependency `node:http` server (`:3300`), **nDB in-process** for storage, NUI for the
  admin SPA, **MD-Blocks** as the document format. First target: raum.com's publishing backbone.
- An **entry** is `{_id, c_date, m_date, name, slug, docs: {<lang>: <MD-Blocks source>}}`.
- A **collection** is declared in `data/meta/data.jsonl` (`{key, name, translatability}`) and each is its own
  nDB database at `data/<key>/data.jsonl`.
- `Database.open()` **creates** a database it cannot find — so membership is checked before opening, and the
  registry is load-bearing.
- **Bilingual** is decided as *one entry with N language variants*, never paired entries; a missing variant
  means the URL does not exist (no fallback). `translatability` declares which variants may exist.
- **What is actually enforced by code today: nothing.** `translatability` is stored and editable and read by
  no one; nothing validates that a written `docs` key is one the collection allows.
- 142 real documents from the old CMS are imported into `works-n000b`; `writing` holds the 2 variants that
  exist.
- The media **variant menu** (`big/medium/thumb` × avif/webp/jpg + `thumb_cms`, ffmpeg snaps for video) is an
  invariant of the output contract; **nMedia** computes it, the CMS orchestrates.
- nDB is **ours** (herrbasan/nDB) and in use by other applications — so changes are allowed but **must not
  break existing consumers**.
- Old-system facts live in `docs/reference/n000b_cms/`; this brief references them rather than restating.

---

## 2. Verified facts (with evidence)

**nDB's per-database metadata file** — `data/<key>/meta.json`:

| fact | evidence |
|---|---|
| It exists and is written by `ndb init` as `{version, created, buckets}` — **no `schemas` block** | `src/bin/ndb.rs` ~line 169 |
| `ndb config <get\|set> <key> [value]` reads/writes it (dot notation); `ndb status` calls a database **invalid** without it | `documentation/cli.md` |
| **The core neither reads nor writes it — schema validation is not implemented** | `README.md`, `AGENTS.md`, `documentation/architecture.md` |
| The intended shape is documented: `schemas: {<type>: {fields: {<field>: {type: string\|array\|link}}}}` | `docs/database_evolution_plan.md` §2.3 |
| §2.3 *Opt-in Schema Validation* and §2.5 *the `link`/nURI type* are **unchecked** items — "the `schemas` block is entirely ignored. Zero runtime validation currently occurs in Rust" | same file |
| nDB's own plan puts definitions in **admin/CLI** territory, not the web app at runtime | same file §2.4.2 |

**nDB's buckets — they are *directories inside a database*, not a pool:**

| fact | evidence |
|---|---|
| `_files/<bucket>/<hash8>.<ext>`, a sibling of `data.jsonl`; created implicitly on first write. **Rust** reaches it as `db.bucket("name")`; **Node** has no such method — it is flat: `db.storeFile(bucket, name, data, mime)` | `documentation/file-buckets.md`, `src/bucket.rs` (`FileBucket::dir`), `documentation/nodejs-api.md`; both shapes measured (§2 probe) |
| Dedup (SHA-256) is **per bucket**; trash is `_trash/files/<bucket>/` | same |
| A bucket named `_files` maps to the `_files` root itself | `src/bucket.rs` |
| There is **no cross-database file access** — `FileBucket::new(name, base_dir)` is bound to one database folder | same |
| `meta.json`'s `buckets` block is for **policies** (`onDocumentDelete`, `ttl_seconds`), not access control — and is ignored | `database_evolution_plan.md` §2.3/§2.4.1 |
**Measured against the pinned build** (`modules/nDB`, 2026-09-26, in a throwaway folder — not inferred
from docs). This closes blind spot 5; every row below is behaviour, not a claim:**Reproduce all six with `node tools/probe-ndb.js`** — it asserts them and fails loudly if nDB drifts, which
is also the signal that a schema nCMS enforces itself now belongs to nDB.
| probe | result |
|---|---|
| insert a document violating the declared `meta.json` schema (`title` as a number, `avatar` not an nURI, plus an undeclared field) | **no error, no warning — written and read back intact.** The `schemas` block is inert. |
| `storeFile('avatars', 'face.png', …)` | landed at `<db>/_files/avatars/7ad5509f.png` — **a directory inside that one database** |
| store identical bytes again | same hash → same file (dedup confirmed) |
| a *second* database calling `getFile('avatars', <the first's hash>, 'png')` | **threw**: `I/O error at …\beta\_files\avatars\7ad5509f.png: The system cannot find the path specified` — and it did **not** create beta's `_files/` |
| `Database.open()` on a folder with no `meta.json` | works, and does not create one |
| lifecycle methods on `Database` | `compact`, `flush`, `restore`, `releaseFile`, `gcBuckets` … and **no `close`, `destroy` or `dispose`** |

Two consequences worth stating plainly:

- **The bucket model is settled by measurement, not reading.** A cross-database file reference resolves to a
  *filesystem path built from the calling database's folder*, so it cannot work: nDB has no way to reach
  another database's files at all. D7 is therefore not a matter of preference for native resolution — there
  is none to be had (see D10.4).
- **The Node API is flat where the Rust API is a bridge.** There is no `db.bucket(name)` in Node (it threw
  `TypeError`); the methods are `storeFile(bucket, name, data, mimeType)`, `getFile(bucket, hash, ext)`,
  `listFiles(bucket)`, `deleteFile`, `releaseFile`, `restoreFile`, `gcBuckets`. Documented as deliberate
  (`nodejs-api.md`), but it means Rust-vs-Node shapes must not be conflated when reading nDB's docs.
- **Field retirement has native primitives.** `remove(id, 'dot.path')` removes a field or array element as a
  delta patch, and `compact()` rewrites the store keeping only active documents. So the compaction D5's
  neighbours need is an iteration of `remove` + one `compact`, not a bespoke migration harness.
**The old CMS's bucket model is structurally different:**

| fact | evidence |
|---|---|
| Buckets were a **separate global registry**: Misc, Works, Audio, Herrbasan Music | `data/admin/buckets_db.json` |
| A **document** named its bucket in a `media_bucket` field, and every media record carried `{bucket, filename, …}` inline | `audio_player` docs; `works` docs |
| `works` referenced exactly **one** bucket across all 575 media references — but by convention, not by binding | scan of `DvSm43mylqudDQg9.json` |
| `audio_player` already **spans two**: one document names "Herrbasan Music", the other names none | `RcGiBpJZRSRrSr0i.json` |

**The old CMS's table definition was not in the data:**

| fact | evidence |
|---|---|
| A stored table definition is only `{name, c_date, m_date, _id}` — no fields, no languages | `data/admin/dbs_db.json` |
| The per-table shape the editor rendered (fixed Header + variables, and the language set) was **code**: `editor_page_default` | frozen spec §5/§7; confirmed by David 2026-09-26 |
| The record carried facts the tree didn't: `name`, `customer`, `year`, `date` at top level, outside `sections` | `DvSm43mylqudDQg9.json` |
| Multilingual storage appears **exactly once** in the archive: 11 `works_categories` records with `lang: {de, en}` beside a shared `name`; content tables have **zero** language maps, and no block's `data` is ever a map | full-archive scan |

**Measured from the 142 migrated documents** (the vocabulary a schema would declare):

| measurement | value |
|---|---|
| fixed header field ids | 6, identical in all 142 |
| discipline vocabulary | 7 labels; **6 documents are missing one** — the field set already varies |
| `class` values with no MD-Blocks equivalent | 104 (dropped, counted) |
| `parent_name` values | 258 (dropped, counted) |
| `richtext` markup | only `h1`/`h2`/`p`/`br`; no attributes, no entities |

**Our own code already contains a hand-rolled schema** — `lib/store.js`:

```js
function titleOf(doc) {                       // which field is the label? guess:
  if (doc.name)  return doc.name;             //   1. a top-level name
  if (doc.title) return doc.title;            //   2. a top-level title
  if (doc.docs)  /* parse `title:` … */       //   3. frontmatter of the first variant
}
```

Also verified: **our collection folders have no `meta.json`** (`data/meta`, `works`, `works-n000b`,
`writing` contain only `data.jsonl` and sometimes `_trash`). By the nDB CLI's own definition they are
invalid databases.

---

## 3. The decisions

### D1 — Where does a collection's definition live?

- **(a) `data/<key>/meta.json`** — nDB's own file, nDB's documented shape.
- (b) Everything stays in `data/meta/data.jsonl` (the registry that lists collections).
- (c) A CMS-side file of our own.

**Proposed: (a) for the definition, (b) for existence only.** The registry has to keep existence, because
`open()` creates what it cannot find — a typo'd key would otherwise bring a collection into being. But
*definition* (schema, buckets, languages) belongs in the collection's own folder, which is where nDB intends
it.

*Known cost:* two files then describe one collection, so precedence must be stated — the registry is
existence, `meta.json` is definition, and neither may contradict the other.

### D2 — Who enforces the definition?

nDB can't yet. So: **nCMS reads and enforces it itself, in nDB's file and nDB's shape.** When §2.3 lands,
enforcement moves down a layer and **the file does not change** — the migration is "delete our validator",
not "convert our data".

*This is the whole point of the shape choice:* declaring a schema in `meta.json` and assuming nDB enforced it
would enforce nothing and return false confidence. Declaring it there and enforcing it ourselves costs one
validator and buys convergence.

### D3 — Who *writes* it?

nDB's own plan says definitions are admin/CLI, "not accidentally mutated by the Node web application during
runtime". Our set-editor currently edits `translatability` over HTTP as a side effect of Save.

- (a) CMS writes via the API, as today.
- **(b) CMS reads freely; writes only through an explicit "apply definition" act** — with the diff shown
  before it lands.
- (c) Read-only in the admin; all edits via `ndb config set`.

**Proposed: (b).** It keeps the admin useful and keeps definition changes deliberate, which is nDB's intent.

### D4 — What does the definition declare? (**reframed 2026-09-26: declare decisions, not fields**)

nCMS is meant for **all use-cases**, not the old site and raum.com. Those are *evidence*, not specification.
So the question is not "what is the field vocabulary" — that is per-use-case, and writing it down makes the
declaration a second copy of the data. The question is narrower:

> **Declare only what the system must make a decision about. Everything else is free JSON.**

That yields three declarations, all small:

1. **which field is the display field** — deletes `titleOf()`'s three-way guess;
2. **the language set** — absorbing `translatability`;
3. **per field, the kind** (shared | per-language) — **only for fields that vary**, and the kind is
   **declared, never inferred from the field's meaning**.

Point 3 is the correction that generality forces. "Images are shared, audio is per-language" is true of
raum.com and false in general: a screenshot of a German UI is a per-language *image*. If the kind were
hardcoded by role, the model would break on the second use-case. The role tells you nothing; the collection
says.

**What this buys over the original proposal.** Adding an ordinary field requires **no** declaration edit at
all — stronger than "entries are not touched", because the declaration isn't touched either. And
**compaction shrinks in proportion to what is declared**: three-ish fields per collection, not a field
vocabulary. A retired declared field is still hygiene rather than correctness, because undeclared means free
JSON, which the raw editor still shows.

**Rejected as the tail:** a full typed field schema. Type validation is nDB's §2.3 eventually; doing it here
first would mean nCMS maintaining a validator that nDB is about to own — the third-copy problem of §5.

*Open:* does the declaration govern only entry-level fields, or document frontmatter too? Position: document
frontmatter **is** language (D5 class 3), so it is not declared.

### D5 — Shared facts vs language (**refined 2026-09-26 by David's raum.com answer**)

raum.com shares **images** between both language versions, but the **audio** (the TTS-rendered article) is
**per language**. That names a third class, and the model is not shared-vs-local but **three kinds of
value**:

1. **shared value** — one value for the entry: `customer`, `agency`, `year`, `date`, taxonomy refs, images
   and the cover, `involvement`.
2. **per-language value** — **one slot, a value per language**: `audio` (`{en: <ref>, de: <ref>}`), and
   `title`, which is *already* in this class in the existing data (`Hallo nCMS` / `Hello nCMS`).
3. **language content** — the body, a complete MD-Blocks document per language.

Class 2 is the old CMS's `lang: {de, en}` map — the shape we could only ever observe on one category label,
because no multilingual content table existed. It was right, and right at this granularity: a **slot** with
per-language values, not a duplicated record.

**Proposed:** class 1 lives once on the entry; class 2 is a language map **on the entry**
(`audio: {en, de}`), not buried in a variant's body — it is a fact about the entry, and the builder must find
it without parsing prose; class 3 stays a whole document per language.

Why not map prose too (the old model taken all the way): prose is not a value. A translated document
legitimately differs in length, section count and media, and MD-Blocks is a document format — a language
dimension at every node would infect the format to buy structural parity we could not honestly promise.
Duplicating *facts*, by contrast, is pure drift risk with no compensating value.

*Cost, and it is the expensive one:* it changes the entry shape (D6), and it is cheapest **now** — only two
variants exist and only one is genuinely bilingual.

### D6 — The entry shape

Today: `{name, slug, docs: {en: <whole document incl. its own facts>}}` — so facts are duplicated per variant.

Proposed: facts on the entry, variants as `{frontmatter, body}`:

```
{ _id, c_date, m_date, name, slug,
  facts: { customer, agency, year, date, categories: [...], cover: <ref>, involvement: {...} },
  docs: { en: { frontmatter: { title, … }, body: "<!-- mb:main -->…" },
          de: { frontmatter: { title, … }, body: "…" } } }
```

*Open:* facts flat on the entry vs inside a `facts` object; and whether a variant keeps any frontmatter at all
(`title` says yes — it is the one field that is both, and the data already resolves it: the entry's `name` is
the shared label, the variant's `title` is the local one).

### D7 — Media: where the pool lives (**resolved by measurement 2026-09-26**)

This was framed as "which database owns the bucket". **It is not that question.** The old CMS's pool is
independent of its buckets entirely:

```
database/storage/files/                             ← originals
database/storage/cache/<variant>/<mediaId>.<ext>    ← one DIRECTORY per variant
    big_avif/0BrlLZrU5UyY5FvZ.avif
    big_jpg/…   big_webp/…   medium_avif/…   thumb_avif/…   thumb_cms/…
```

Keyed by media `_id`, one directory per variant, in **one shared root**. The `bucket` is a *field on the
media record* — a label for the admin's Files screen; moving a media item between buckets moves no bytes.
That is exactly what "buckets are labels, not directories" meant, and it is not nDB-shaped.

nDB buckets offer none of what the pool needs: no variant concept, one blob per content hash under a
hash-derived name, a root bound to a single database, and no cross-database read at all (measured — the
resolver builds a path inside the *calling* database and fails with ENOENT). The pool needs a stable id per
asset, many predictable variants, and one root outside every collection.

**Proposed: the pool is CMS-side, as it was** — a filesystem pool the CMS owns, with nDB holding only
references, and nDB's file buckets unused for content media. What `bucket` then means is open (D7a below).

*Supporting measurement:* across the whole archive, **zero** media files appear in two different collections
(561 in `works`, 79 in `audio_player`; the only overlap is `works` with its own trash). The old domain
buckets permitted sharing; the content never needed it — which is why keeping the pool outside nDB costs
nothing today.

- **D7a (open, small):** does `bucket` survive as a label on the media record, or is it dropped?
- **D7b (open, a build-contract question, not storage):** does the **renderer** resolve variants at build
  time from the pool, or does the CMS pre-resolve them?

### D8 — What is an entry with **zero** variants?

`writing` currently holds five live entries with no `docs` at all (four are step-2 test residue:
`Validation Test`, `Validation Test 2`, `Round-trip probe`, `Boilerplate round-trip`) plus a duplicate
entry. Under the no-fallback rule they have no URL — invisible but present.

Options: legal draft (shown in the list, marked), or invalid (rejected on write).
**Proposed: legal draft, but visible.** Invisible-and-present is a silent failure. See D9 — the answer
splits by collection kind.

### D9 — Document collections and record collections (**found via the "all use-cases" lens**)

`works_categories` in the old CMS is not a document collection at all: 9 entries of
`{name, lang: {de, en}}` with **`sections: []`** — no body, ever. It is a **vocabulary**, referenced from
documents by `_id` (`vars_tags.db` names the collection). It is also the *only* multilingual collection in
the archive, and its one varying field is class 2.

So the ambition bites here, and the current model does not cover it: every entry shape we have assumes a
document, and the importer skipped this collection entirely.

**Proposed:** the collection declaration says whether its entries are **documents** (a body per language) or
**records** (facts only). Both use the same three value kinds — a record's `name` is class 2, exactly like a
document's `title`. One declaration, no second mechanism, and the raw editor already covers the rest.

*Consequence for D8:* a record collection is the legitimate version of "no variant". Zero body is normal
there and abnormal in a document collection — the distinction D8 was missing.

### D10 — What we want from nDB (all additive, non-breaking)

1. **Implement `meta.json` `schemas` validation** (§2.3, already planned) — the platform's own roadmap.
2. **Implement the `link`/nURI type** (§2.5) — media references are exactly the case it exists for.
3. **`close()`** — measured: the `Database` prototype has no `close`, `destroy` or `dispose`. A handle
   therefore stays open for the process's life and Windows refuses to rename or delete an open file
   (`EPERM`). This already forced a design choice in nCMS (deleting a collection tombstones its declaration
   instead of moving its folder) and it will block any purge or GC feature.
4. **Resolve a link against a *named* database**, not only the caller's own — this is what would make D7(a)
   native instead of CMS-side.
5. Buckets declared upfront and dynamic creation restricted (§2.4.2's own intent) — only if D7 lands on a
   shape that needs it.

---

## 4. Not being decided here

The URL contract and redirect map; the media variant menu's migration to nMedia; the renderer's output;
the block editor's design. All live in the plan (§11, §13).

---

## 4a. The 80% boundary — what we deliberately do not model

The ambition is **all use-cases**; the method is **the 80% done excellently**, because attempting everything
collides with excellence and performance. So the tail is named rather than stumbled into. **None of these get
model features. All of them are served by the raw-editing floor and plain JSON.**

- locales beyond a language code (regions, dialects) — declare more codes; no new mechanism;
- per-field permissions, visibility, or workflow/approval states;
- typed validation of every field (nDB §2.3's job, eventually);
- real relations/joins between collections — the old CMS's tags are a *soft* reference by `_id`;
- unbounded recursion in the document format (the old editor was deliberately bounded to three levels);
- versioning or history of documents;
- anything the renderer needs that the store should not know about.

The contract that makes the 80% safe: **if it is not declared, it still works — as JSON, editable by hand.**
That is why the raw editor is the universal floor rather than a debugging tool.

---

## 5. Where we suspect our own blind spot — attack these

1. **D5 vs invariant #8 — "raw editing is always available for any document."** If facts move out of the
   variant, then raw-editing a single variant no longer shows the whole document. The universal floor may
   need to be raw editing of the **entry**, not of a variant. We have not worked this through.
2. **D5 rests on one bilingual entry.** `title` differs, `date` and `tags` are identical — n=1. The
   shared/local split is a reasonable inference, not a measurement.
3. ~~D7 may be the wrong frame entirely.~~ **Resolved 2026-09-26** — it was the wrong frame. The pool is not
   an nDB concern at all (D7), so "which database owns the bucket" was a question about nothing. What
   remains is D7b, a build-contract question rather than a storage one.
4. **D3 vs the set-editor we already shipped.** It writes definitions over HTTP today. If D3(b) holds, part
   of that UI has to become a reviewed, previewed change rather than a Save.
5. ~~We have verified nDB's *docs* but not run its behaviour.~~ **Closed 2026-09-26** — the probe in §2
   measured the schema being ignored, the bucket scoping, the failed cross-database read and the absent
   `close()`. The remaining unverified surface is the CLI (`ndb init` / `ndb config` / `ndb status`), which
   we read but have not run.
6. **The schema's own drift.** A schema in `meta.json` is a *second* copy of a shape that also exists in code
   (`titleOf`, the admin's row renderer, the importer's mapping). If the schema is not the only source, it
   becomes a third thing to keep in sync — the failure mode `titleOf` already demonstrates.
7. **D9's cut may be wrong.** It rests on one collection in one archive. Is "document vs record" a real
   distinction, or is a record just a document whose body happens to be empty? If the latter, D9 is a flag
   that should not exist — and "zero variants" has one meaning, not two.
