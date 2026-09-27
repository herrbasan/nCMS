# Upload progress, the event feed, and the create-first flow

> **Status:** working document — a plan, nothing built.
> **Source:** read out of the old CMS's own source (`D:\Work\_GIT\# n000b_cms`), 2026-09-27, at David's
> instruction. File:line references are to that checkout.
> **Companion:** [cms-migration-plan.md](cms-migration-plan.md) §6 (media), §11.4 (the media surface).

---

## 1. What the old CMS actually does

### 1.1 One SSE channel per session

`Server/index.js:283` — `GET /events`:

```js
'Content-Type': 'text/event-stream', 'Connection': 'keep-alive',
'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'
res.write('retry: 10000\n\n');
sessions[req.session].sse = (message) => { res.write(`data: ${JSON.stringify(message)}\n\n`); res.flush(); }
req.on('close', …) // the writer is dropped from the session
```

Two delivery modes, both trivial because the writer hangs off the session:

- `ssEventSend(sessionId, message)` → one client (`:311`)
- `ssEventBroadcast(message)` → every session with an open stream (`:322`), and `EventBroadcast` is that
  (`:317`)

The client (`admin/js/lib/nu_sse.js`) opens exactly one `EventSource('/events?session=<cookie>')` and routes
by `msg.type`: `status` → server stats, `session`+`expired` → back to the login screen, **everything else** →
`g.log.push(msg)` and `main.liveUpdate(msg)`.

### 1.2 Every mutation emits a typed message — and that message is *both* the HTTP response and the broadcast

Handlers are wrapped by `funnel()`, which attaches `req.log_entry` (`Server/index.js:201`):

```js
req.log_entry = { ip: req.user_ip, user:'anon', action: fnc.name, message:'access', status:false, url: req.originalUrl }
```

Note `action: fnc.name` — **the action name in the log is the handler function's own name**, which is why the log
reads `fileAdd`, `uploadFile`, `listFiles`, `colList`. Nothing maintains that list by hand. `message` defaults to
`'access'` (an ordinary call) and `status` starts false; success sets `status = true` (`:252`), an error sets
`status = false` and the reason as the message (`:259`). A handler that did real work overwrites `message` with
its payload. The same object is returned to the caller and broadcast to everyone else. The vocabulary observed:

| type | emitted by | payload |
|---|---|---|
| `add` | `fileAdd` (`:1004`) | `{bucket, data: doc}` — record created, no bytes yet |
| `upload` | `addUpload` (`:1081`) | `{bucket, data: doc}` — bytes landed |
| `postproc` | `addUpload` (`:1097`) | `{bucket, id, ticket}` — variants finished |
| `moved` | `deleteFile` (`:1000`) | `{bucket, data: doc}` — filed to trash |
| `deleted` | `deleteFile` (`:983`) | `{bucket:'trash', id}` |
| `locked` | `deleteFile` (`:978`) | `{bucket:'trash', id}` — refused: a ticket is live |
| `status` | stats timer (`:185`) | `{stats}` |

**The feed is a *request* log, not only a mutation log.** Every route call produces a row — ordinary reads
appear as `access` with no payload (seen live in the Live Log: `colList`, `listFiles`). Mutations are just the
rows that carry a message. So the same channel doubles as a request monitor, and the Live Log screen is its
raw view (see §1.5d).

Confirmed live, 2026-09-27 — one real upload as the log showed it:

```
07:28:53  fileAdd     {"type":"add","data":[{"bucket":"0rqnD9y3cyNfx19","ticket":"_5uhg2t4din"…
07:28:53  listFiles   access
07:28:53  uploadFile  {"type":"upload","bucket":"0rqnD9y3cyNfx19","data":{"bucket":"0rqnD9y…
07:28:55  uploadFile  {"type":"postproc","bucket":"0rqnD9y3cyNfx19","id":"X1GuZEAH1GwnY2…
```

Three stages, two seconds apart, each carrying its type — with the **ticket in `add`** and the **id in the
`postproc`** that follows. Row layout: status icon · timestamp · action · user `(idx)` · ip · payload as
Prism-highlighted JSON.

**This is the elegant part.** The initiator receives the message as its own response; every other client
receives the identical object over SSE. So the UI has **one** apply path — `main.liveUpdate(obj)` routes on
`obj.message.type` — and a change made in one browser appears in another with no refetch and no polling.

### 1.3 Create first, upload asynchronously — the ticket

Client, `main.sendFileP` (`admin/js/main.js:1105`):

1. `ticket = ut.id()` — a client-generated id for *this* upload.
2. `POST /storage/add` with the file's **metadata only** (`{bucket, ticket, filename, filesize, ext, mime,
   f_date, c_date, m_date}`) → the server creates the record and returns `_id`.
3. `POST /storage/upload` (multipart) carrying that `id` and the bytes.

Server, `addUpload` (`Server/index.js:1039`):

```js
let mem_ticket = data.ticket;
data.ticket = null;
db.update(…, data)
file.mv(fp, …)                     // bytes → <storage>/files/<id>.<ext>
→ broadcast {type:'upload', bucket, data: doc}
→ if image/video: createImageSizes(doc) → broadcast {type:'postproc', bucket, id, ticket: mem_ticket}
```

Three consequences, all deliberate:

- **The record exists before any byte does.** The item appears in the list instantly, because it *is* a
  record already — only `ticket` says the binary is still coming.
- **The ticket links the server's later message back to the UI placeholder.** The client keeps
  `g.media_ticket = [{ticket, img, url, data}]`; when `postproc` with that ticket arrives,
  `checkMediaTicket` (`admin/js/main.js:1001`) sets `img.src = item.url` — **the placeholder becomes the real
  thumbnail** — and `updateImage(id)` calls `filelist.updateItem(idx)` so the list row re-renders with its
  ticket cleared.
- **A live ticket locks the item.** `deleteFile` resolves `{type:'locked'}` rather than deleting a file that
  is mid-upload or mid-processing.

### 1.4 The sidebar progress area

`admin/js/main.js:960` — a queue and a fixed display, not a notification:

```js
main.uploadQue = { idx, max, bytes, bytesTotal, files: [] }
display_label.innerText = 'Uploading ' + (que.idx+1) + ' of ' + que.max;
display_stats.innerText = ut.formatFileSize(que.bytes) + ' / ' + ut.formatFileSize(que.bytesTotal);
display_proz.style.width = Math.round((que.bytes / que.bytesTotal) * 100) + '%';
```

fed by `xhr.upload.addEventListener('progress', …)` (`:1085`) — **byte-level**, from XHR, because that is the
only API that reports upload progress. On completion: label `Upload finished`, bar 100%, area fades out
(`display_main.style.opacity = 0`).

So the three progress sources are distinct and each covers what only it can:

| what | source | granularity |
|---|---|---|
| the transfer | XHR `upload.onprogress` | bytes within the current file |
| the batch | the queue counter | N of M files |
| what happens after the bytes land | **SSE** | per-item, per-stage |

### 1.5 The frontend, in detail — where the elegance actually is

Five small mechanisms, and the first one is the whole idea.

**(a) The actor reloads; the feed patches.** This is the distinction that makes it work, and it is
narrower than "everything updates itself":

| who | learns about a change by |
|---|---|
| the client that acted | the **response** to its own request → `main.filelist()` (a reload) |
| every other client | the **feed**, and only for work that outlives its request (`postproc`) |

`main.uploadFiles` (`admin/js/main.js:853`) shows both halves in one function: POST the metadata array to
`/storage/add`, then `main.filelist()` — *reload my own list so the new rows appear immediately* — and then
start the byte uploads. Nothing about the add/upload stages is fed to anyone else; the feed exists for the
**tail**, the part that finishes later, when no request is outstanding. SSE here is not general state sync;
it is the completion channel.

**(b) The row owns its own update.** In `admin_filelist.js` (`:139`) each rendered row defines a hook:

```js
html.update = () => {
  if (item.ticket) { img.src = './images/loader.svg'; img.style.opacity = null }
  else { img.src = `${g.baseURL}/image/thumb_cms/${item._id}.webp`; img.addEventListener('load', imageLoaded) }
}
```

and the message handler calls `g.filelist.updateItem(idx)` — the list's own API, which re-runs the row's
`update()`. So the message supplies **an id and nothing else**; the row knows what to do with its new state.
No diffing, no re-render of the list, no framework. Our `nui-list` has `updateItem(idx, data?, force?)`, so
this transfers directly.

**(c) The placeholder carries the link back.** In the editor's media block (`cms_block_media.js:66`) a
pending item renders `<img src="./images/loader.svg">` and registers:

```js
window.g.media_ticket.push({ ticket: prop.data[i].ticket, img: img, url: url, data: prop.data[i] })
```

When `postproc` arrives for that ticket, `checkMediaTicket` (`main.js:1001`) sets `img.src = item.url` — **the
spinner becomes the real image**, fading in on `load`. Two details worth copying: the *same* ticket is
registered by both the strip thumbnail and the big preview, so `allIdxByProp` (all matches) is used rather
than `findIndex` — one message flips every element waiting on that ticket.

**(d) The log screen is the feed's raw view.** `nu_log.js` is a `superList({ logmode: true, height: 42,
data: event_log, render: renderLogItem })`, and `pushLog(item)` just does `event_log.push(item)` +
`list.appendData()`. Each row prints `item.action`, user, ip, and `JSON.stringify(item.message)`
Prism-highlighted as JavaScript. So the activity monitor is *the same list component in log mode* — no
separate UI. Our addon has `appendData()` and log mode too.

**(e) Per-bucket client cache.** `g.storage_cache[g.bucket] = g.filelist.data` (`main.js:820`) — the acting
client keeps the list data it just loaded, keyed by bucket.

**The honest limits of the original**, since they shape what we build:

1. Only `postproc` is applied to the UI. `add`, `upload` and `deleted` reach other clients over the feed and
   are **ignored** by `liveUpdate` — a second browser does not see a new file appear, and cannot see a file
   deleted. It only sees a pending thumbnail become real, because that row is already in its list.
2. No resync on reconnect — a message missed during the 10-second `retry` gap leaves a stale row forever.
3. Uploads are **serial** (one file at a time, `next()` chains the queue) — deliberate, so the byte counter
   is honest.
4. `uploadFilesCheck` skips files whose `filename` + `filesize` already exist in the bucket (logged, not
   surfaced).

So the thing to replicate is not "a live feed" — it is **a completion channel plus rows that can update
themselves**, with the placeholder as the join between the two. (b) and (c) are the load-bearing parts; the
transport is almost incidental.

### 1.6 What the lock actually covers — and what it does not

Checked exhaustively, because "items can be locked while editing" is the property worth having: across the
whole non-vendored source (server, `admin/js`, `admin/nui`, the blocks), the string `locked` appears **once**.

```js
// Server/index.js:978 — deleteFile()
if (data.ticket) resolve({ type:'locked', bucket:'trash', id })
```

That is the **only** lock in the system, and it does one thing: an item whose binary is still in flight cannot
be deleted. Nothing sets a ticket on edit, and **no client handles a `locked` message** — `main.liveUpdate`
filters on `action == 'uploadFile' && message.type == 'postproc'` and drops everything else.

Writes are unguarded too: every update stamps `m_date: Date.now()` and **nothing ever compares it**. Two
editors saving the same document is silently last-write-wins — which answers the plan's §13.4, and not in the
direction it hoped.

So what the feed gives is **visibility, not exclusion**: every client sees the same activity and the same
state changes, and the ticket stops one specific destructive act during one specific window. Neither is an
edit lock.

**The extension, and it is small.** The ticket already *is* a general lock primitive — a field on the record
with a lifetime, enforced by the server, published as a message. Using it for editing is the same mechanism
with a different lifetime and an owner:

- set on open (`{by, at}`), refreshed while the editor is open, cleared on save or close;
- a write carrying a stale or foreign lock is refused with the existing `locked` type;
- the message is published on acquire and release, so **other clients grey the row out** — which is the
  multi-user behaviour, and it costs one field plus one message type rather than a locking subsystem.

The same primitive then covers the third case the plan needs: `m_date` optimistic locking for a client that
is *not* holding the lock (an LLM writing to a document a human has open).

---

## 2. The plan for nCMS

### A. Split the add into three acts

> **BUILT 2026-09-27.** `lib/media.js` (`reserve` / `acceptBytes`), `server.js` (`POST /api/media` is JSON,
> `PUT /api/media/:id/file` is the bytes), `admin/js/app.js` (a serial queue + `XMLHttpRequest` progress),
> `admin/index.html` + `css/main.css` (the sticky `#uploads` region under the axis). Verified by
> `tools/test-media.js` (33 assertions) and in the browser: the region walks idle → `Uploading 1 of 1` at
> `0 B / 327 kB` → `327 kB / 327 kB` at 100% → `Uploaded 1 of 1` → hidden, while the row appears and finishes
> processing off the feed.
>
> Three decisions were taken in the building. **`postproc` follows the bytes** — the reframe makes the old CMS
> the specification and it starts processing automatically, so the "costs a click" alternative in open decision
> 1 was not taken. **The ticket is server-issued** (open decision 2 resolved that way): a client-chosen
> identifier for a half-uploaded record is a value the server merely believes, and it is the only thing between
> a losing race and one upload writing over another's bytes. **The ticket expires** (`NCMS_TICKET_TTL_MS`,
> 30 min) — a gap neither the original nor this plan had: without an expiry, an abandoned reservation is
> permanently undeletable, locked by a capability nobody holds. That is closed here rather than reproduced.

Today `POST /api/media` streams the body, writes the record, **and** queues ten nMedia jobs in one request —
which is why the base and the processing are entangled.

| step | route | what it does | publishes |
|---|---|---|---|
| 1. reserve | `POST /api/media` (JSON `{filename, size, mime, bucket}`) | creates the record with `ticket`, `original: null` | `add` |
| 2. bytes | `PUT /api/media/:id/file` (raw body + `x-ticket`) | streams to the pool, clears `ticket`, sets `original` | `upload` |
| 3. process | *not implied by 1 or 2* — a separate act | queues the variant menu | `postproc` |

- Step 1 is the base: **a bucket holds a file**, and nothing else has to happen for that to be true.
- Step 2 is the base's other half; it is async by construction, which is what the progress area is for.
- Step 3 becomes an explicit decision — a button, or a policy on the bucket/collection — instead of a side
  effect of adding a file. That is the separation the current code is missing.

Deleting a record with a live ticket refuses with `locked` (as the old CMS does), so a half-uploaded file
cannot be removed from under its own upload.

### B. The event feed

> **BUILT 2026-09-27** — `lib/feed.js` (the hub), `server.js` (`GET /api/events`, `POST /api/ping`, a
> `publish` on every mutation), `admin/js/events.js` (the client). Verified by `tools/test-feed.js`
> (42 assertions) and `tools/test-feed-integration.js` (31, over a real server on a spare port).
> Four decisions were made in the building, all of them below; the rest of this section is still the spec.

- `GET /api/events` — `text/event-stream`, `retry: 10000`, no-cache, `X-Accel-Buffering: no`.
- A hub in `server.js`: a `Set` of writers; `send(message)` (one) and `broadcast(message)` (all). Start with
  one shared hub — there are no sessions yet, because auth is nPort's job later — and keep the addressable
  `send()` for when there are.
- Every mutating route publishes. Message shapes are the ones already in the envelope: **the route's own
  response payload is the message**, so there is one shape and no second serialisation.
- Client: one `EventSource('/api/events')`; `apply(message)` routes by `message.type`; unknown types are
  logged and ignored, never fatal.

#### What building it added to the design

1. **A `seq`, shared by both channels.** The fix below (apply the drained backlog) *double-applies* if taken
   literally, because the backlog holds everything the live stream already delivered. One monotonic counter
   on every broadcast makes applying both channels safe with no per-type bookkeeping — and it is what lets a
   client detect the gap the 50-cap creates. `hello` and `send` take **no** number: a seq spent on a message
   only one client receives is a hole in every other client's stream, which they all read as a drop and
   reload for. (A test caught exactly this; the rule is now explicit in `lib/feed.js`.)
2. **`hello.atSeq`** — the counter's current value, reported not claimed. Without a baseline a client cannot
   tell "I am behind" from "this is my first message".
3. **A `scope` on every message** — what the message is *about* (`collections`, `buckets`, `entries`,
   `media`). The client routes on it. Without it a listener infers the resource from payload field names,
   which is guessing dressed as a contract — and this vocabulary is shared with the Chat app, so it *is* a
   contract. `scope` rides on the broadcast only; the responding client already knows what it did.
4. **Nothing polls.** The media list's `setTimeout` refresh loop is gone, replaced by the `postproc`
   message. That loop existed only because there was no feed.

Still open from §4: whether `postproc` is its own act (§A), and whether the ticket doubles as the edit lock.

**One improvement over the original, and it is a single line.** The old CMS already guarantees delivery: each
session keeps a 50-entry backlog and `/ping` (client: every 5 s) drains and returns it, so nothing is lost when
the stream drops. But the replayed entries are only *logged* — `main.liveUpdate` runs from the SSE handler
alone, never from `sessionPing` — so a `postproc` missed during the gap arrives, lands in the log, and **the row
it should have updated stays showing its placeholder forever**. The fix is to run the same `apply()` over the
drained entries. No refetch, no resync-on-open: the catch-up channel already exists, it just isn't applied.

(Full evidence: `reference/n000b_cms/behaviour-inventory.md` §1 and §3.)

### C. The client apply path

Faithful to the original split — **the actor reloads, the feed carries the tail**:

- The client that initiates step 1 or step 2 applies its own **response** (a reload of the current view). It
  does not need the feed to know what it just did.
- The feed exists for the part that finishes when no request is outstanding: `postproc` (and, if we keep a
  processing step separate, whatever it reports).
- `postproc` → find the row by id and call `updateItem(idx)`; the row's own `update()` hook swaps the
  placeholder for the real thumbnail. **The message carries an id, not a payload to apply** — the row knows
  what to do.
- The placeholder registers itself as `{ticket, element, url}` at render time, so one message flips every
  element waiting on that ticket (several elements can share a ticket; match *all*, not the first).

**One deliberate extension, and it is the one worth arguing about.** The original leaves `add`, `upload` and
`deleted` unapplied by other clients, so a second browser shows a stale list. Our plan's invariant is *one
API, two clients* — the Chat app is an equal consumer. If the Chat app adds a file while the admin is open,
the admin showing nothing is a defect, not a simplification. So: route `add` / `upload` / `updated` /
`deleted` into the same `apply()` as well, by id.

Both paths end in the same place — `apply(message)` — so this is a matter of which *types* it handles, not of
a second mechanism. Start with `postproc` (exactly as the original), and widen when the Chat app becomes a
writer.

### D. The sidebar area

A fixed region in the sidebar under the axis (the old CMS puts it at the bottom):

- label: `Uploading N of M`; stats: `uploaded / total`; a thin progress bar.
- fed by XHR for bytes, the queue for the file count, and the feed for the tail.
- idle → faded out. **A failure is the only thing that gets a banner** (the rule already in place), so the
  progress area never becomes a notification surface.

`fetch` cannot report upload progress, so the bytes step uses `XMLHttpRequest` — exactly as the old CMS does.
That is the one place the modern API is worse and the old code is right.

---

## 3. Files this touches

| file | change |
|---|---|
| `lib/media.js` | split `upload()` into `reserve()` / `acceptBytes()` / `startProcessing()`; `ticket` on the record; refuse a delete while a ticket is live |
| `server.js` | the three routes, `GET /api/events`, the hub, and a `publish()` in every mutating route |
| `admin/js/app.js` | `EventSource` + `apply()`; patch rows through `updateItem`; the ticketed placeholder swap |
| `admin/index.html` · `admin/css/main.css` | the sidebar progress region |
| `Agents.md` · `docs/cms-migration-plan.md` | record the flow and the message vocabulary once it is settled |

---

## 4. Open decisions

1. **Is `postproc` triggered by the upload, or is it its own act?** The old CMS starts it automatically when
   the bytes land. Separating it is what makes the base independent — but it costs a click. (This is the
   decision the current entanglement is really about.)
2. **Do we keep a client-generated ticket, or issue it server-side?** Server-side is one fewer thing the
   client can get wrong and one fewer field to trust; client-side is what makes the placeholder matchable
   before the response arrives.
3. **Does the feed carry server stats** as the old CMS does (`status`), or is that a separate concern?
4. **Does the ticket become the edit lock?** The old CMS has no edit lock (§1.6) — the ticket only guards
deletion during upload. Extending it is the cheapest route to "locked while editing" and reuses a field and a
message type we already need. Alternatives: `m_date` optimistic locking alone (reject stale writes, no
visible lock), or both.
5. **Does the Chat app consume the same feed?** The plan's invariant is one API, two clients; if yes, the
   message vocabulary has to be a contract from the start rather than an admin convenience.
6. **Apply the replayed backlog** — the original drains missed messages into the log but never applies them
   (§1.3/B). Running `apply()` over the drained entries is one line and needs no refetch. Match the original
   instead, or fix it?
   → **Decided, and it took more than one line.** We apply it, guarded by `seq` so the same message cannot be
   applied twice, and a `seq` jump triggers a full reload rather than a partial replay. The original's
   omission was load-bearing: the backlog is *unconditional*, so applying it naively re-runs everything the
   stream already delivered. Built and tested (§B).
7. **`scope` on every message, and a baseline in `hello`** — additions the build forced, not in the original
   plan. See §B. Both exist because the alternative was the client guessing.
