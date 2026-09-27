# The pool's integrity

> Built 2026-09-27. This is the old CMS's `files_check` (`Server/index.js:1305`) rebuilt for the media pool.
> Code: `lib/media.js` (`integrity`, `sweepPool`), `server.js` (`GET`/`POST /api/pool`),
> `admin/js/app.js` (`#feature=maintenance`). Test: `tools/test-pool.js` (24 assertions).

## The four questions

The report answers four things, and **they are not four kinds of error** — telling them apart is the whole
value, because each has a different answer.

| finding | what it is | what to do |
|---|---|---|
| **Unreferenced** | bytes no record claims — not live, not deleted | the **only** thing the sweep removes |
| **Restorable** | bytes a *tombstoned* record still claims | nothing — removing them destroys what the tombstone preserves |
| **Records with no bytes** | a live record whose original is gone | usually an abandoned reservation: delete the record. An in-flight upload is never listed |
| **Filed under a deleted bucket** | a live record whose bucket id is a tombstone | nothing — this is the **expected** result of deleting a bucket |
| **Filed under an unknown bucket** | a live record naming a bucket id nothing knows | a real fault; not reachable through the public API |

## Why the tombstone distinction is load-bearing

Deletion here is a **tombstone**, which is what makes a restore possible. So "no live record" does *not*
mean "unreferenced": a deleted asset's bytes are still claimed, and `nDB`'s `deletedIds()` is what says so.

A sweep that treated "no live record" as "orphaned" would reclaim exactly the bytes the tombstone exists to
preserve — a data-loss bug wearing the costume of housekeeping. `tools/test-pool.js` asserts the bytes are
still there, byte-for-byte, after a sweep, and that a restore still works.

The same distinction applies to buckets. `deleteBucket` tombstones and its assets **keep their label on
purpose**, so restoring the bucket brings the organisation back. Reporting that as a fault would flag the
design's own intended state — and would train the reader to ignore the section that also holds real
breakage.

## What differs from the original, and why

- **Read and act are separate.** The original deletes the unlinked files inside `files_check`, in what reads
  like a check. A maintenance screen is the one place you open to *look before you act*, so the report is a
  `GET` and the sweep is a `POST` (with a confirmation naming the count and the bytes).
- **Removing a directory takes its variants with it.** Variants live inside the asset's own pool folder, so
  one removal is complete. The original kept them in a separate `cache/<size>/` tree and had to call
  `clearCache(id)` — which it called with `item._id` on an object that held `id`, so it cleared `undefined`
  and shipped nothing. An asset-shaped folder makes the problem disappear.
- **Two false positives are designed out.** An asset filed nowhere (`bucket: null`) is legal, and a
  reservation still awaiting its bytes must not be reported as missing them — otherwise every in-flight
  upload would be flagged as damage, on the screen you open when something is genuinely wrong.

## Running it

```
node tools/test-pool.js          # own data root, no server needed, no nMedia needed
```

Against the live root it reported: 20 assets, 22 directories, 1 bucket — 0 unreferenced, 2 restorable,
0 records without bytes, 9 under a deleted bucket, 0 unknown.
