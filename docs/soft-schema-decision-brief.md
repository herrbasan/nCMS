# Decision brief — nDB-native collection definitions, bilingual shape, media ownership

> **Purpose.** Input for a **second opinion** (and for ourselves). It states what is *verified with
> evidence*, what we *propose*, and where we *suspect our own blind spot* — so a reviewer can attack the
> reasoning rather than re-derive it. Written 2026-09-26.
>
> **Status:** working document. Nothing here is decided except where it says so.
> Companion: [cms-migration-plan.md](cms-migration-plan.md) (§5 data model, §13 open questions).
>
> **Independently reviewed 2026-09-26** by a second model, read-only against this repo; the corrections are
> folded in. Issues filed from that pass and from verifying it: nDB **#4** (bucket GC counts failed deletes as
> success and swallows I/O errors), **#5** (the public wrapper omits the native `close()`), **#6** (`insert()`
> aborts the process on a non-object document).

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

## 1a. Three states, kept apart

Every claim below is one of these, and they are not interchangeable:

| state | what it means |
|---|---|
| **today** | shipped in nCMS and verified against the pinned nDB |
| **pending nDB** | fixed and verified in nDB's local checkout (`63264cb`), **not deployed and not in the pin nCMS uses (`987c7b1`)**. nCMS must not rely on it, and the pin must not move without approval. |
| **proposal** | a choice in this brief — not agreed, not built |
| **unimplemented** | on nDB's roadmap, implemented nowhere |

### Upstream items and where they stand

| item | state |
|---|---|
| #4 — bucket GC counted failed deletes as success, swallowed I/O errors | **pending nDB** — GC now counts successful moves only |
| #5 — public wrapper omitted the native `close()`; `open(path, options)` discarded a second handle | **pending nDB** — wrapper exposes `close()`; no discarded handle |
| #6 — `insert()` aborted the process on a non-object document | **pending nDB** — invalid shapes are catchable errors |
| deletion could destroy before its restorable copy was written; cleanup failures unreported | **pending nDB** — the tombstone is written first, and deletion refuses to proceed if it cannot be |
| original error API and throwing behaviour | **unchanged; no consumer migration needed** |
| #7 — an update can trash referenced media *before* its journal write succeeds, so a failed write leaves the old document pointing at unavailable media | **open upstream, deliberately deferred** — nDB's own task; **do not start it from here** |
| `meta.json` `schemas` validation (§2.3) | **unimplemented** |
| the `link` / nURI type (§2.5) | **unimplemented** |
| native cross-database link resolution | **unimplemented, and not a prerequisite** |

**Nothing upstream implements schema validation, localization, or native cross-database link resolution, and
none of them is a prerequisite for any decision here.** Display fields, allowed languages, shared/localized
facts and body policy remain **CMS-owned semantics**; type validation is a separate, later concern.

**Proposal status:** **D5, D6 and D7 are proposals**, not decisions — the media-storage choice and the
entry/definition design are both still open. D1–D4 and D8–D10 are the shape those proposals assume.

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
| native lifecycle | the **binding** implements and exports an idempotent `close()` (`napi/src/lib.rs`); the **public wrapper** (`napi/index.js`) omits it — nDB #5, **pending nDB** (§1a) |
| native `close()` effect | folder rename fails `EPERM` while open and **succeeds after `db._native.close()`** — the lock is releasable today |
| wrapper `Database.open(path, options)` | builds a native instance, then replaces `_native` with a second `open()` — the first is left to GC (latent leak, noted in nDB #5, **pending nDB**) |
| GC and refcounts | **database-local**: `gc_buckets()` marks from `self.docs` and sweeps `self.base_dir/_files`; counters live in `self.file_refs` |

Two consequences worth stating plainly:

- **A cross-database file reference cannot work natively.** It resolves to a *filesystem path built from the
  calling database's folder*, so nDB cannot reach another database's files through its own handle. What that
  rules out is **native cross-database resolution** — **not** a shared pool, which a dedicated media database
  can still back (D7).
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

**Proposed: (a) for the definition, (b) for existence only.** The registry must keep existence, because
`open()` creates what it cannot find — a typo'd key would otherwise bring a collection into being. But
*definition* belongs in the collection's own folder, where nDB intends it.

*Known cost:* two files then describe one collection, so precedence must be stated — the registry is
existence, `meta.json` is definition, and neither may contradict the other.

**The definition lives in that file under a CMS key, not under nDB's `schemas`.** nDB's `schemas` block
describes **storage types** (`string`, `array`, `link`); what D4 declares is **CMS interpretation** — which
field is displayed, which languages are allowed, which values are localized. Different contracts, one file:
writing CMS semantics into `schemas` would be a name collision, not a convergence. So **two contracts, one
file, namespaced:**

| contract | declares | owner |
|---|---|---|
| `schemas` | storage type per field | **nDB** (§2.3, when it lands) |
| a CMS key (e.g. `cms`) | display field, language set, per-field localization | **nCMS**, always |

`ndb config get/set` already reads and writes arbitrary dot-notation keys in that file, so a namespaced
extension needs nothing from nDB — and the core ignoring the whole file means it cannot be surprised by one.

### D2 — Who enforces the definition?

**Two owners; this does not converge.** nCMS enforces *interpretation* now and will still enforce it when nDB
implements type validation — nDB validating that `title` is a string says nothing about whether `title` is
*displayed* or *localized*. So:

- **nDB's contract** is enforced by nDB when §2.3 lands. Nothing of ours to remove.
- **nCMS's contract** is enforced by nCMS, permanently. There is no layer below to inherit it.

Keeping them apart is also what makes D1 safe: if nDB's §2.3 arrives with a different vocabulary, only the
`schemas` key is affected. D2 must not be read as "nDB will do our validation later" — an unimplemented
roadmap shape is not a compatibility guarantee, and these are not the same contract.

### D3 — Who *writes* it?

nDB's own plan says definitions are admin/CLI, "not accidentally mutated by the Node web application during
runtime". Our set-editor currently edits `translatability` over HTTP as a side effect of Save.

- (a) CMS writes via the API, as today.
- **(b) CMS reads freely; writes only through an explicit "apply definition" act** — with the diff shown
  before it lands.
- (c) Read-only in the admin; all edits via `ndb config set`.

**Proposed: (b).** It keeps the admin useful and keeps definition changes deliberate, which is nDB's intent.
The preview must show the **effects on existing entries**, not merely the JSON diff (D3a) — a definition
change that cannot be expressed as a view is not a display edit.

### D3a — What does "soft" mean when a definition *changes*?

Adding an ordinary field is free (D4). Changing an *interpretation* is not, and these cannot all be equally
harmless:

- **shared → localized**: one value must become N. If the languages must differ, there is nothing to derive
  them from — a human or a model has to decide. The edit cannot be pure.
- **localized → shared**: N values must become one, and if the translations disagree there is **no correct
  automatic answer**; silently picking one destroys the rest.
- **removing an allowed language**: does its content become illegal, hidden, or preserved-as-legacy?
- **retiring a declared field**: the declaration goes, **the data does not.** Removal is a *separate,
  explicit* operation, and compaction only reclaims the log history that removal leaves behind. Deleting a
  declaration must never imply deleting data.

**Implemented and verified — one rule, judged only from what is declared:**

> **A declaration may only appear or change for a field that holds no values yet.** Otherwise the change is
> refused *in whole*, with a machine-readable account of what conflicts. Explicit conversion is a separate
> feature and **not built now** — but its input is the refusal payload, so the deferral is not a dead end.

**A value is never inspected to decide what it *is*.** A shared field may legitimately hold `{en: 5, de: 7}`
meaning something else entirely, and no amount of looking can tell that from a language map. So there is no
readability test — the only judgement available is the declaration itself. The consequence is deliberate and
worth stating plainly: **conversion is required for anything already written**, including a single-language
value that would merely need wrapping.

| change | verdict |
|---|---|
| add or re-add a declared field, for a field with no values | **applies**; reports coverage |
| add or re-add a declared field, for a field that already holds values — declared or free JSON | **refused**, `declaration_over_values`: its kind was never declared, so it cannot be judged |
| change the display field | **applies** — values are untouched, only the projection moves. Reports which entries would show blank |
| add a language | **applies** — every existing value reads the same. Reports how many entries have no variant in it |
| remove a language | **refused** if *any* entry has content in it — a document variant, or a value under a declared per-language field — `language_in_use` |
| retire a declared field | **applies**, and touches no data: the field becomes undeclared free JSON |
| `shared ↔ per-language` on a field holding values | **refused**, `declaration_over_values`. No cardinality exception |
| coverage gaps | never a conflict; reported, never refused |

Three invariants, and they are what make "soft" safe:

1. **No definition change writes to, rewrites or coerces an entry value.** Not even to normalise. The only
   writer of entry data is a write to that entry.
2. **A refusal is atomic** — nothing applies, the definition is unchanged.
3. **A refusal is specific**: entry ids, field, languages, and a stable conflict code. A refusal that says only
   "conflict" is a bug in this feature, not an acceptable outcome.

The refusal reuses the existing envelope — `{status:false, error:"definition_conflict", message, detail}` with
`detail.conflicts: [{entry, field, code}]`. That is deliberate: error codes are a stable contract, the Chat app
can act on them, and **the later conversion feature consumes exactly this payload** instead of needing new
machinery.

*It follows from D4's own principle:* what is declared is what the system acts on; changing a declaration is an act, not an edit.

### D4 — What does the definition declare?

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

### D5 — Shared facts vs language

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

The rule D5 implies is **one authority per value, and the document stays whole:**

```
{ _id, c_date, m_date, name, slug,
  facts: { customer, agency, year, date, categories: [...], cover: <ref>, involvement: {...} },
  docs: { en: "<whole MD-Blocks source>", de: "<whole MD-Blocks source>" } }
```

The rules that make it coherent:

1. **Entry-level structured data owns every declared fact**, `title` included — a language map when localized
   (`title: {en: "Hello nCMS", de: "Hallo nCMS"}`), a single value when shared.
2. **A declared fact may not also have a competing authoritative value in a document's frontmatter.** One
   value, one home. A document's frontmatter carries only what is *not* declared.
3. **Each language's document stays whole MD-Blocks source.** The format's unit is a document; splitting it
   into an object buys nothing rule 1 does not already buy.
4. **Export assembles standalone per-language Markdown** on demand, merging the entry's facts back into the
   frontmatter. The stored document is not the published artifact.
5. **Raw JSON editing covers the whole entry; Markdown editing covers one document.** This answers blind spot
   1: invariant #8 holds because the *entry* is the raw-editable unit, and no Markdown edit becomes an edit of
   escaped JSON.

*What this costs:* the 142 imported documents carry their facts in frontmatter, so the importer must hoist them
onto the entry, and `titleOf`'s frontmatter-parse fallback disappears. Both are the point.

### D7 — Media: where the pool lives

The old CMS's pool is independent of its buckets: bytes in one shared root, `storage/files/` plus
`storage/cache/<variant>/<mediaId>.<ext>`, with `bucket` only a label on the media record.

**What the probe rules out is narrower than "nDB cannot back a pool".** Native cross-database *resolution*
does not exist — a database cannot reach another database's bucket through its own handle. That is not the same
as a shared pool being impossible. Two coherent options:

- **(a) A CMS-side filesystem pool**, as the old CMS had: the CMS owns bytes and layout, nDB holds only
  references. Simple, and the variant cache keeps predictable paths a renderer can serve directly.
- **(b) One dedicated media database**: it holds asset records (stable id, variant name → blob ref) *and* the
  blobs in its own `_files/`; the CMS resolves an asset through that database's handle. No native
  cross-database resolver is required.

**Constraint 1 — nDB's refcounting and GC are *database-local*** (verified in source): `gc_buckets()` marks
from `self.docs` and sweeps `self.base_dir/_files`; the counters live in `self.file_refs`. So **asset records
must live in the media database and must hold the physical `bucket:hash.ext` refs themselves** — a reference
from a content collection would not protect a blob. Get that right and (b) gets dedup and blob-level orphan
detection; get it wrong and the pool is swept.

**Constraint 2 — nDB does not provide the media lifecycle.** Two responsibilities stay separate:

- nDB tracks **asset record → physical blob**, within the media database.
- nCMS governs **content entry → asset**, across collections.

nDB cannot tell whether an asset is safe to delete from references in *other* databases, so **trash, restore
and purge policy remain the CMS's** — in both options. (b) buys dedup and blob-level orphan detection, not the
lifecycle.

**Constraint 3 — an update can trash referenced media before its journal write succeeds.** That is nDB **#7**:
upstream, open, and **deliberately deferred — do not start it from here**. If the journal write fails, the old
document can survive with an unavailable media reference. It predates all of the above and matters specifically
for reliable media-record *replacement*. Treat it as a dependency of (b), not as a defect in this design.

**Favourite, stated:** **(b)**, because dedup and blob-level orphan detection are pool bookkeeping the CMS
should not hand-roll. It is close: (a) carries no dependency on nDB's GC or on its write ordering, and wins if
the variant cache's predictable paths matter to serving. **Still a proposal — not agreed.**

*Weak evidence, flagged:* zero media files are shared between two collections in the whole archive (561 in
`works`, 79 in `audio_player`; the overlap is `works` with its own trash). That describes the archive, **not
what a general-purpose CMS should permit**.

- **D7a:** does `bucket` survive as a label on the media record, or is it dropped?
- **D7b:** does the **renderer** resolve variants at build time, or does the CMS pre-resolve? Still the real
  question — and (b) makes resolution *more* explicitly the CMS's job, not less.

### D8 — Zero variants, or no body at all

`writing` holds **one** live entry (`Hello nCMS`, bilingual) and no bodyless entries at all — the apparent
residue in its file (`Validation Test`, `Round-trip probe`, `Boilerplate round-trip`, empty shells) is already
**tombstoned**. Reading the raw lines as documents miscounts it, because nDB applies deltas and tombstones
rather than treating each line as a record; only `iter()`, `deletedIds()` or the API give the real state.
Two different questions are in play, and only the first is a model question:

- **capability** — does this collection support or require a document body? A category is *complete* without
  prose, and a renderer could build a page from structured fields alone. This is a **validation policy on the
  collection**: it changes the editor and what a write may omit. It is not a storage shape.
- **readiness** — is this entry ready to publish? A state, not a type, and orthogonal to the above.

**Proposed:** a declared body policy (`required | optional | none`) and **no second storage model** — a
bodyless entry is still an entry. Whether readiness needs a field at all is left open; it may be a renderer
concern.

The case is designed from the vocabulary collection (D9), not from residue — there is no residue left in
`writing`.

*This settles the brief's own blind spot 7:* a body policy is a capability, not a type.

### D9 — The vocabulary case

`works_categories`: 9 entries of `{name, lang: {de, en}}` with **`sections: []`** — no body, ever. Referenced
from documents by `_id` (`vars_tags.db` names the collection). Also the only multilingual collection in the
archive, and its one varying field is class 2.

It needs **no new mechanism** under D8: the collection declares `body: none`, its entries are records, and its
`name` is a localized fact like any other. The importer skipped it — an importer gap, not a model gap.

### D10 — What is still wanted from nDB (**only what remains**)

The wrapper/`close()`, GC-reporting, process-abort and deletion-ordering items are **fixed in nDB's local
checkout and not adopted here** (§1a). They are not asks. What remains unimplemented:

1. **`meta.json` `schemas` validation** (§2.3, nDB's own roadmap). **Not a prerequisite** for this design — it
   validates storage types, which D1 keeps in a separate namespaced key from the CMS's semantics.
2. **The `link` / nURI type** (§2.5) — media references are exactly its case. Also not a prerequisite; nCMS
   resolves references either way.
3. **Native cross-database link resolution** — would let D7(b) resolve without the CMS opening the media
   database. **Explicitly not a prerequisite**, and the cheapest of the three to live without.
4. Buckets declared upfront and dynamic creation restricted (§2.4.2's own intent) — only if D7 lands on a
   shape that needs it.

*(Two items left this list by being fixed rather than wanted: the wrapper's missing `close()`, and `insert()`
returning an error instead of aborting the process. See §1a for their state.)*

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

*(Two earlier entries are settled and now live in the decisions that answer them: raw editing vs. facts →
D6 rule 5, and the document/record cut → D8.)*

1. **D5 rests on one bilingual entry.** `title` differs, `date` and `tags` are identical — n=1. The split is
   justified by principle rather than by the sample: translations *can* differ structurally, while a shared
   value should have one authority. Keep the caveat; do not lean on the measurement.
2. **D3 versus the set-editor already shipped.** It writes definitions over HTTP today. If D3(b) holds, part of
   that UI has to become a reviewed, previewed change rather than a Save.
3. **The definition's own drift.** A declaration in `meta.json` is a *second* copy of a shape that also exists
   in code (the admin's row renderer, the importer's mapping, the definition-change rule itself). Languages are
   now single-authority for defined collections, so the remaining risk is the *field* vocabulary being
   described in more than one place.
4. **Partly settled, partly open: values that live in two places.** The *language set* is settled — for a
   defined collection `cms.languages` is the authority and the registry holds no copy. What remains is D6 rule
   2: the 142 imported documents carry their facts in document frontmatter, which is a second authority beside
   `facts`, and the rule needs a migration and a rule for when the two disagree. That is D3a's case arriving
   before any definition exists to change.
5. **D7's favourite is a judgement, not a measurement.** (b) is preferred for refcounted GC and dedup, but the
   variant cache's predictable paths are a real serving advantage for (a). If serving paths matter more than
   orphan cleanup, the choice flips.
6. **The corpus is one archive.** Every measurement in §2 and every structural claim in §4a comes from a single
   old CMS instance. That narrow base is why the all-use-cases lens keeps catching scope errors.
7. **nDB's CLI is the remaining unverified surface.** `ndb init` / `ndb config` / `ndb status` were read, not
   run. If `meta.json` handling differs in practice, D1's choice of file is affected.

---

## 6. Worked example — one definition, one bilingual entry (**proposal**)

The real Westenergie entry, reshaped by D1/D4/D5/D6. The identifiers, asset ids, filenames and columns block
are the actual ones. Two things are illustrative: the **body is trimmed to its first section**, and the
**German side is invented** — the corpus is en-only, so a `de` title, a `de` heading and `de` audio are
supplied to show the shape.

### The collection definition — `data/works/meta.json`

```json
{
  "version": 1,
  "created": 1789200346,
  "buckets": ["media"],

  "schemas": { "entry": { "fields": { "cover": { "type": "link" } } } },

  "cms": {
    "languages": ["en", "de"],
    "body": "optional",
    "display": "name",
    "fields": {
      "customer": { "kind": "shared" },
      "year":     { "kind": "shared" },
      "cover":    { "kind": "shared" },
      "title":    { "kind": "per-language" },
      "audio":    { "kind": "per-language" }
    }
  }
}
```

`version`, `created` and `buckets` are nDB's own keys as `ndb init` writes them. `schemas` is nDB's key for
storage types and is **currently inert** (D1/D2) — shown only to make the namespacing visible. `cms` is ours and
is read by nothing else.

### The entry

```json
{
  "_id": "bs82iSsY4ItiGafr",
  "c_date": 1789200346161,
  "m_date": 1789200346161,
  "name": "Westenergie Web APP",
  "slug": "westenergie-web-app",

  "facts": {
    "customer": "Westenergie",
    "year": 2021,
    "cover": "media/znLiGMaZF3pvwS8t/westenergie_webapp.mp4_snap_00007.png",
    "title": {
      "en": "Westenergie Web APP",
      "de": "Westenergie Web-App"
    },
    "audio": {
      "en": "media/aa11bb22ccddeeff/westenergie-en.mp3",
      "de": "media/ff11ee22ddccbbaa/westenergie-de.mp3"
    }
  },

  "docs": {
    "en": "<!-- mb:main -->\n\n<!-- mb:block label=\"Headline\" -->\n# Screenshots\n<!-- mb:/block -->\n\n<!-- mb:columns label=\"3 Media Columns\" -->\n<!-- mb:col -->\n![Screenshot 01](media/IsFI4SLnOrI8npka/westenergie_webapp.mp4_snap_00001.png)\n<!-- mb:col -->\n![Screenshot 08](media/DLWtawgF6PCBlBfs/westenergie_webapp.mp4_snap_00008.png)\n<!-- mb:col -->\n![Screenshot 09](media/smxH2cuKzlur008C/westenergie_webapp.mp4_snap_00009.png)\n<!-- mb:/columns -->\n",
    "de": "<!-- mb:main -->\n\n<!-- mb:block label=\"Headline\" -->\n# Ansichten\n<!-- mb:/block -->\n\n<!-- mb:columns label=\"3 Media Columns\" -->\n<!-- mb:col -->\n![Screenshot 01](media/IsFI4SLnOrI8npka/westenergie_webapp.mp4_snap_00001.png)\n<!-- mb:col -->\n![Screenshot 08](media/DLWtawgF6PCBlBfs/westenergie_webapp.mp4_snap_00008.png)\n<!-- mb:col -->\n![Screenshot 09](media/smxH2cuKzlur008C/westenergie_webapp.mp4_snap_00009.png)\n<!-- mb:/columns -->\n"
  }
}
```

Four things this shape asserts, each following from a decision above:

- **Identity is top-level and shared**: `_id`, `name`, `slug`, dates (B2). `name` is the language-neutral label;
  `title` is the localized heading. Both exist because the corpus already distinguishes them.
- **The stored document carries no `title`.** It has no frontmatter at all. `title` is a declared fact, so
  frontmatter carrying it would be a second authority (D6 rule 2). Export merges the facts back in — see below.
- **One reference form, in facts and in documents alike**: `media/<asset id>/<filename>`. MD-Blocks
  destinations are *paths*, so a document cannot use a bare id; using the path form everywhere means one
  resolver instead of two. This is a proposal, and it is what D7's resolution story has to serve.
- **A fact and a body reference are separate uses, not competing authorities.** `facts.cover` is the entry's
  cover — list thumbnail, OG image — and a media block in the body is a rendered image in the article. The same
  asset appearing in both is ordinary and allowed. D6 rule 2 constrains the **values of a declared fact**; it
  says nothing about references to an asset. Placing a fact is the renderer's job, and an author may
  independently reference the same asset in the body.

### How the editor obtains each value

| editor shows | source |
|---|---|
| one value vs. one value per language | the definition's `fields[].kind` — it determines the **localization layout**, not a widget type |
| a declared field with no specialised editor | raw JSON — declaring a field never promises a purpose-built editor for it |
| which languages are selectable | `cms.languages` |
| a shared value | `entry.facts[field]` |
| a per-language value | `entry.facts[field][lang]`; an absent language shows as a marked gap with an affordance to create it, not as blank |
| the list label | `entry.name`, because `display: "name"` — `titleOf`'s three-way guess is gone |
| the body being edited | `entry.docs[lang]`, as Markdown, for **one language at a time** |
| the whole entry, raw | the entry object as JSON — the universal floor, per invariant #8 |

### How the renderer obtains each value

| renderer needs | source |
|---|---|
| the language set, the body policy | the definition's `cms` key |
| a shared value | `entry.facts[field]` — read directly, nothing parsed |
| a per-language value | `entry.facts[field][lang]` — no variant scanning, no frontmatter parsing |
| the article body | `entry.docs[lang]`, through the MD-Blocks renderer |
| media in facts *and* in the body | the same resolver: it takes `media/<id>/<filename>`, extracts the id, and returns URLs from the variant menu |
| a page for `de` | for **document-backed** pages, only if `docs.de` exists — a missing variant is "no URL", no fallback (B2). Bodyless collections have no `docs` at all, and whether they produce a page is the renderer's own business (D8) |
| a standalone MD-Blocks export | **assembles** one: the facts for that language are merged into the document's frontmatter. The stored document is not the published artifact (D6 rule 4) |

The payoff in one line: **the renderer needs the definition and one entry, and reads every value by path. No
heuristic anywhere.** That is what `titleOf` was standing in for.

### Added: structural enforcement on entry writes

With a definition present, entry saves are checked against the declared **shape** — which languages a
per-language value and a document variant may be keyed by, and the body policy (`required | optional | none`).
A shared field's value is unchecked, because it may be arbitrary JSON. Missing translations stay allowed:
a variant that does not exist is "no URL" (B2), not an error. Refusals are `400 invalid_entry` with
`detail.problems`, naming the field and the code.

### Added: two behaviours worth knowing

- **nDB returns object keys sorted.** A shared object written as `{en: …, de: …}` reads back as
  `{de: …, en: …}`. Semantically identical, but any comparison of stored objects must be by value, and the raw
  editor will show keys in a different order than they were typed.
- **A defined collection's label comes from the declared display field**, taking the first declared language
  that holds a value for a per-language field. A legacy collection keeps the old heuristic unchanged.
