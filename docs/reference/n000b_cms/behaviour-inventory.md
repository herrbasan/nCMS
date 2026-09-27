# n000b CMS — behavioural inventory (extracted from source)

> **Purpose.** The old CMS's *behaviour*, written down once, from its own source — so the rebuild stops
> depending on anyone's memory of how it worked. Every claim here carries a `file:line`.
>
> **Source:** `D:\Work\_GIT\# n000b_cms`, read 2026-09-27. Backend: `Server/index.js` (one file, ~1620 lines,
> Express). Frontend: `admin/js/main.js` (42 KB), `admin/js/lib/{nu_sse,nu_log,admin_filelist}.js`,
> `admin/nui/cms_blocks/`.
>
> **Status of this document:** first pass — the backend seam, the route inventory and the delivery
> guarantees are complete and verified. §5 lists what is still to extract.

---

## 1. The seam: **every request is a message**

There is no separate event system. The response path and the broadcast path are the same two functions.

**`funnel(req, res, fnc, rights)`** (`:199`) wraps **every** route and builds the message *before* the handler
runs:

```js
req.log_entry = { ip, user:'anon', action: fnc.name, message:'access', status:false, url: req.originalUrl }
```

- `action` is the **handler function's own name** — hence `fileAdd`, `uploadFile`, `listFiles`, `colList` in
  the log. No hand-maintained action list exists.
- the session is resolved (query for GET, body for POST, else the cookie) → `user` and `idx` are stamped
- `rights` (`'write'` | `'admin'`) is checked; refusal calls `sendError('insufficient_rights')`, and a bad
  session `sendError('invalid_session_id')`
- the handler then runs

**`sendSuccess(req, res, message)`** (`:250`):

```js
res.send({status:true, message})
req.log_entry.status = true
put_log(req.log_entry)          // ← broadcast
refreshSession(req.session)
```

**`sendError(req, res, message, status)`** (`:257`) — same, with `status = false` and the reason as the
message.

**`put_log(obj)`** (`:1406`) — the only broadcast point:

```js
obj.timestamp = Date.now(); obj.time = ut.formatDate(obj.timestamp).full;
if (obj.action != 'sendImage') {        // asset bytes are deliberately excluded
  EventBroadcast(obj);                  // → every open SSE stream
  delete obj.session;
  log.push(obj);                        // the server's own tail (initial fill for the Live Log screen)
  pingFillLog(obj);                     // → every session's backlog, capped at 50
}
```

Two consequences worth stating plainly:

1. **You cannot answer a request without broadcasting it.** The mutation messages (`{type:…}`) are simply the
   log entries whose `message` a handler replaced with an object; ordinary reads go out as `message:'access'`.
   The feed is a *request log*, and mutations are a subset of it.
2. `action != 'sendImage'` is the one exclusion — high-frequency asset responses would flood the feed. Any
   rebuild needs the same kind of exclusion, or the feed becomes a bandwidth problem the moment media is
   served.

**Persistence** (`write_log`, `:1427`): when idle, entries older than the last 50 are appended as JSONL to
`storage/logs/<YYYY-MM-DD>.log`, so the log survives restarts (only the tail is re-served).

---

## 2. Route inventory

Every route, its handler, the rights it demands, and what it publishes. `funnel()` is implied for all.

| route | handler | rights | publishes (`message`) |
|---|---|---|---|
| `POST /login` · `/logout` | `login` `:345` · `logout` `:374` | — | session |
| `GET /events` | `ssEvent` `:286` | — | *(the stream itself)* |
| `POST /ping` | `pong` `:171` | `write` | `{status, stats, message:'pong', log}` — **drains the backlog** |
| `POST /session` | `sessionInfo` `:1390` | — | session info |
| `POST /cms_start` | `cmsStart` `:720` | `write` | the collections/files bootstrap |
| `POST /functions` | `cms_functions` `:1260` | `admin` | maintenance & server functions |
| `POST /buckets/list` · `/add` · `/edit` · `/delete` | `listBuckets` `:385` · `addBucket` `:396` · `editBucket` `:414` · `deleteBucket` `:423` | `admin` except list | `doc` / `data` |
| `POST /storage/list` | `listFiles` `:761` | — | the bucket's files |
| `POST /storage/get` | `getFileEntry` `:798` | — | one record |
| `POST /storage/upload` | `uploadFile` `:1020` → `addUpload` `:1078` | `write` | `{type:'upload', bucket, data}` then `{type:'postproc', bucket, id, ticket}` |
| `POST /storage/add` | `fileAdd` `:1000` | `write` | `{type:'add', bucket, data}` |
| `POST /storage/delete` | `deleteFiles` `:957` | `write` | array of `{type:'deleted'|'moved'|'locked', bucket, id|data}` |
| `POST /storage/query` | `queryFiles` `:747` | `admin` | matches |
| `GET /storage/file` · `/image` · `/download` | `sendFile` `:773` · `sendImage` `:887` · `downloadFile` `:943` | — | **`sendImage` is excluded from the feed** |
| `POST /storage/createsizes` | `reprocess_media` `:815` | `admin` | postproc result |
| `POST /storage/convert` | `convert_media` `:828` | `admin` | conversion result |
| `POST /users/list` · `/add` · `/edit` · `/delete` | `:1136` `:1147` `:1182` `:1156` | `write` / `admin` | user records |
| `POST /dbs/list` · `/add` · `/edit` · `/delete` | `:441` `:452` `:470` `:479` | `write` / `admin` | table records |
| `POST /col/list` · `/listByName` · `/get` | `:499` `:529` `:674` | `write` / — / — | entries |
| `POST /col/add` · `/edit` · `/update` · `/delete` | `:566` `:587` `:606` `:624` | `write` | `doc` / `req.query.id` |
| `POST /col/query` | `queryCollections` `:691` | `admin` | matches |

Note what this map gives us for free: **the rebuild's route table is essentially decided already** — the old
CMS's granularity (list / add / edit / update / delete per entity, plus query behind `admin`) is a working
shape that the plan's §7 endpoint table is only loosely mirroring today.

---

## 3. Delivery guarantees — what the original actually guarantees

Two channels carry the *same* messages, deliberately:

| channel | when | carries |
|---|---|---|
| **SSE** (`/events`) | immediately, on `put_log` | the live message |
| **`/ping`** (client: every 5 s) | drains `sessions[id].log` and returns it, then empties it | every message missed meanwhile (backlog capped at 50) |

```js
// pong, :171
let data = { status:true, stats, message:'pong', log: sessions[req.session].log }
sessions[req.session].log = []        // drain
```

So **messages are not lost**: if the stream drops, the next ping (within 5 s) returns everything that happened.
The client pushes those into `g.log` (`nu_sse.js:sessionPing`).

**But — and this is the one place the original drops the ball — the replayed entries are only *logged*, not
*applied*.** `main.liveUpdate` is called from the SSE handler alone (`nu_sse.js:sseMessage`), never from
`sessionPing`. So a `postproc` missed while the stream was down arrives, is written to the log, and the row it
should have updated stays showing its placeholder — forever.

This corrects an earlier claim in `docs/upload-and-events-plan.md`: there **is** a catch-up mechanism, and it's
cheap and good. What's missing is one line — running the same `apply()` over the drained entries. That is
strictly better than the "resync on open by refetching" I proposed: no refetch, and it reuses the channel
already built for exactly this.

`serverStats()` (`:177`) also broadcasts `{type:'status', stats}` on a timer — the stats row in the stats
screen.

---

## 4. What the original does *not* have

Recorded so a rebuild doesn't presume it:

- **No edit lock.** The only `locked` in the entire non-vendored source is `deleteFile`'s ticket guard
  (`:978`), and no client handles a `locked` message. (See `upload-and-events-plan.md` §1.6.)
- **No write guard.** Every update stamps `m_date: Date.now()`; nothing compares it. Concurrent saves are
  last-write-wins.
- **No re-apply on replay** (§3).
- **No per-entity event granularity.** A change to one entry broadcasts the whole `doc`; there is no field-level
  diff, and a client that receives it re-renders the row.

---

## 5. The media pipeline (extracted)

### 5.1 The variant menu — `image_sizes`, `Server/index.js:31`

```js
//big_png:    { format:'png',  ext:'png',  options:{quality:80, adaptiveFiltering:true}, resize:{…3840} }   ← commented out
//medium_png: { format:'png',  ext:'png',  …1920 }                                                          ← commented out
big_avif:    { format:'avif', ext:'avif', resize:{ withoutEnlargement:true, width:3840, height:3840, fit:'inside' } }
medium_avif: { format:'avif', ext:'avif', …1920 }
big_webp:    { format:'webp', ext:'webp', …3840 }
medium_webp: { format:'webp', ext:'webp', …1920 }
big_jpg:     { format:'jpg',  ext:'jpg',  …3840 }
medium_jpg:  { format:'jpg',  ext:'jpg',  …1920 }
thumb_cms:   { format:'webp', ext:'webp', resize:{ …width:128, height:128, fit:'inside' } }
```

**Seven entries.** Not a `big/medium/thumb × three formats` grid — there is **no 1024px thumb family at all**,
and **`thumb_cms` is `webp`, not jpg**. Every entry uses `fit:'inside'` with `withoutEnlargement:true`, so
nothing is ever upscaled and aspect ratio is preserved with no crop.

⚠️ **A discrepancy worth resolving:** the migration plan §6 and the brief both state the menu as
*`big/medium/thumb` in avif/webp/jpg + `thumb_cms`*, and the old CMS's cache directory listing was measured to
contain `thumb_*` folders. The current config produces no `thumb_*`. So **the menu changed at some point**, and
the folders on disk are older than the config. "The variant menu is an invariant" therefore needs pinning to a
version — the question to answer is *when it changed and whether the old thumb family is still wanted*.

### 5.2 What happens to a video

`tools.createImage` (`Server/js/tools.js:55`):

```js
if (mime is video) {
  await tools.videoThumb(fp, temp_path)        // ffmpeg -ss 00:00:05.01 -vframes 1  → one jpg
  ret = await tools.createImageSizes(doc._id, temp_path, sizes)   // the IMAGE pipeline on that frame
  fs.unlink(temp_path)
}
```

So a video produces **one frame, five seconds in**, and that frame is then put through the same seven image
variants. There is **no video transcoding and no video variant family** in the pipeline at all. (`mp4_snap_*.png`
frames referenced in the plan come from somewhere else — not this code path.)

### 5.3 How the variants are made, and what the record keeps

- `createImageSizes` (`:79`) builds **one promise per menu entry and runs them in parallel**
  (`Promise.allSettled`), each with `sharp(fp, { failOnError: true })` **cloned** per variant, writing to
  `storage/cache/<name>/<id>.<ext>`.
- The result object is sharp's per-variant output info, stripped of `format`/`premultiplied`/`channels`, keyed
  by variant name — and that is stored **on the record** as `media_post` (`:868`), alongside a `bench` (ms).
  So the record carries its own variant manifest; the client does not derive paths from a menu, it reads them.
- **Two defects in the original here, both swallowed:** `delete ret[i].value.format` throws when a variant
  *rejected* (`value` is undefined), so one failed variant breaks the whole manifest; and for `audio`,
  `createImageSizes` calls `tools.createAudio` — **a function that does not exist** — so the throw is caught and
  `resolve(undefined)`. Audio silently gets no postprocessing.
- `tools.convertAudio` (`:117`) is a **stub**: `console.log(doc, formats); resolve('done')`. Audio conversion
  was never implemented.
- `clearCache(id)` (`:1121`) walks `image_sizes` and deletes every variant file for an id — the mirror of the
  pipeline, called on update and delete.

### 5.4 Serving

`sendImage` (`:887`) — `GET /storage/image?id=<id>&size=<name>`:

- resolves the file under `storage/cache/<size>/<id>.<ext>`; default size **`big_webp`**
- if the file is not there yet, responds `404 "Postprocessing unfinished"` — a distinct message, so "not ready"
  is distinguishable from "no such asset"
- image and video only; anything else → `404 "No Media File"`
- and it is **excluded from the feed** (`action != 'sendImage'`, §1), because it is hit for every thumbnail

The client uses a **direct static path** for thumbnails rather than this endpoint:
`${g.baseURL}/image/thumb_cms/${item._id}.webp` (`admin/js/main.js:updateImageX`).

### 5.5 Our implementation, compared

| | old CMS | nCMS today |
|---|---|---|
| menu entries | **7** (big/medium × avif/webp/jpg + `thumb_cms`) | **10** — adds a 1024px `thumb_*` family in 3 formats |
| `thumb_cms` | webp, 128 | jpeg, 128 |
| resize | `fit:'inside'`, never enlarge | (nMedia `max_dimension`) |
| video | one frame @5 s → the image menu; no video variants | plan says ffmpeg snaps |
| audio | stub — never implemented; postproc silently no-ops | refused at upload, no menu |
| scheduling | all variants in parallel, one `sharp.clone()` each | **N nMedia jobs, polled** |
| manifest | `media_post` on the record (+ `bench` ms) | `variants: {name:{file,size,c_date}}` |
| serving | `/storage/image?id=&size=`; `404 "Postprocessing unfinished"` | `/api/media/:id/file/:name` |
| cleanup | `clearCache(id)` removes every variant | **none** |

The `thumb_*` family in our implementation is **not from the old CMS** — I wrote it into `IMAGE_VARIANTS` from
the plan's restatement. That is the single most useful thing this extraction has produced so far.

---

## 6. Still to extract

- **Frontend inventory, pass 2:** every screen (`pages_work`, `files`, `log`, `dbs`, `users`, `server`, the
  editor) — its data source, its render, and *which messages it applies*. §1.5 of the events plan covers the
  mechanism; the per-screen map is not yet written.
- **The editor's block model** (`nui_cms_page_editor.js`, `cms_blocks/*`) — the entity/block template, the
  insert palette, the recursion bound. (`docs/reference/n000b_cms/n000b_cms_spec.md` §5–§6 already covers the
  UX; the *data shapes* are not extracted.)
- **`cms_functions`** (`:1260`) — the admin maintenance surface (backup, GC, export).
- **Users, rights and sessions** (`:1136`–`:1400`) — the rights model is only `write` / `admin` here; worth a
  full pass before nPort/auth is designed.
- **The `mp4_snap_*.png` frame path** — not in `tools.js`; find what produces it.

---

## 7. The database seam, in full (second pass, 2026-09-27)

Extracted while **building** the nDB port (`lib/legacy-ndb.js`, verified by `tools/test-legacy-ndb.js`),
which is a much stricter test of this section than reading was: an adapter either holds every call shape or
the old server breaks. Everything below is therefore measured against real call sites, not inferred.

### 7.1 The seam, and the second implementation that proves it

`Server/js/nedb.js` exports a singleton; `client.collection(db, name)` returns an object with **exactly five
methods** — `getDocs({query, projection, sort})`, `getDoc({query})`, `add(data)`, `update(options, data)`,
`delete(id)`. `index.js` never sees the engine, only those objects.

**`Server/js/mongo.js` is a second implementation of the same seam.** That is the strongest evidence the
seam is the right place to cut — it has been swapped once before without editing `index.js`. It is also a
reading aid: **where the two disagree, no caller can depend on the value.** Two cases settle that:

- `update` resolves the **updated document** in `nedb.js` and a **count** in `mongo.js` → the return value is
  not a contract. (`index.js:1086` and `:1210` do read `doc._id` off it, so neDB's richer answer is the one
  to keep.)
- `delete` resolves `'<id> deleted'` in `nedb.js` and a `deletedCount` in `mongo.js` → likewise unused.

### 7.2 The complete query surface — and the one write I first missed

| shape | where |
|---|---|
| `{}`, `{_id}`, `{_id: […]}`, `{bucket}`, `{name}`, `{email}` | reads. **Nothing else.** No `$regex`, `$in`, `$gt`, `$elemMatch` anywhere in the non-vendored source |
| sort `{c_date:-1}` · `{}` | every list |
| projection `{email:1}` · `{password:0}` · `{}` | `cmsStart`, and the admin-only query routes |
| `{$set: { … }}` | six sites, including dot-paths (`colUpdate` passes the body through) |
| bare document (replacement) | `index.js:588` (`replace:true`), `:1086`, `:1210` |
| **`{multi:true}` on a non-id query** | **exactly one site — `deleteBucket`, `:428`** |

⚠️ **A correction to my own earlier claim.** I grepped for the modifier forms, found no multi-document or
id-list write, and concluded "every update is keyed by `_id`". That was wrong, and wrong in the way that
matters: `deleteBucket` (`:423–437`) deletes the bucket and then **re-files every file that pointed at it**:

```js
op.collection = 'files_db'; op.query = {bucket:id}; op.update_options = {multi:true}
db.update(op, {$set:{bucket:'trash', m_date:Date.now()}}).then(docs => docs.map(item => item._id))
```

— a non-id query, `multi`, and the result **mapped as an array**. `mongo.js`'s `else` branch is not a
safety net; it is this call site. The lesson is worth keeping: a grep proves what *exists*, not what is
*absent* from a surface you then generalise over, and a second implementation's fallback branch is
evidence of a caller.

Related: `add` accepts an **array** — `dbsDelete` (`:482`) hands a whole fetched collection to the trash in
one call, and `mongo.js` has the matching `insertMany` branch.

### 7.3 `destroy`, and a real bug in the original

`client.destroy(db, collection)` removes every document and then unlinks the collection file. It builds the
path as `path.join(base_path, _db, _collection)` — **without the `.json` extension** — so the unlink always
fails and the promise rejects. `dbsDelete` chains `.then(result => …)` off it, so **the delete reports an
error to the client after having successfully exported every document to trash** (`index.js:484`). The port
reproduces the behaviour (documents gone, folder gone, a resolved count) and not the bug.

One consequence the port must keep: neDB's `destroy` left an open handle on a file it could not delete, so a
later write to the same collection *re-created* it. The nDB adapter evicts its handle deliberately, to the
same effect — implicit creation is this seam's behaviour, and the registry (`admin/dbs_db`) is what decides
whether a collection exists to a user.

### 7.4 What the port settles about our own design

- **The DB substitution is one file.** `index.js` is not edited.
- **Layout:** `(db, collection)` → `<root>/<db>/<collection>/data.jsonl`, i.e. `('admin','files_db')` →
  `data/legacy/admin/files_db/`. The old `DB_PATH/<db>/<collection>.json` maps one-to-one.
- **`_id` is the same shape.** nDB's `insert` returns a 16-char alphanumeric, which is what neDB produced
  and what the UI shows (`dbs_db` sample, `index.js:524–526`). Collection folders are named by those ids.
- **Tolerated no-ops are the contract.** A write matching nothing resolved `null` (single) or `[]` (multi),
  and the routes return that as a *success* — `dbsEdit` on a stale id answers `message:null`. Refusing
  would turn the original's tolerated no-op into an error, so the adapter does not refuse.
