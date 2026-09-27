'use strict';

// nCMS server. Zero dependencies — node:http for the transport, nDB in-process for storage.
// It carries glue only: static file serving and the JSON API. No framework, no middleware
// chain, no templating.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./lib/store.js');
const media = require('./lib/media.js');
const { HttpError } = require('./lib/http-error.js');
const { feed } = require('./lib/feed.js');
const { createLog, QUIET } = require('./lib/log.js');

const PORT = Number(process.env.PORT || 3300);
const ROOT = __dirname;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.woff2': 'font/woff2',
	'.ico': 'image/x-icon'
};

// Static roots, longest prefix first. Nothing outside these is reachable.
const STATIC = [
	['/nui/', path.join(ROOT, 'modules', 'nui_wc2', 'NUI')],
	['/admin/', path.join(ROOT, 'admin')]
];

function envelope(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store'
	});
	res.end(body);
}

const ok = (res, data) => envelope(res, 200, { status: true, data });
const fail = (res, status, error, message, detail) =>
	envelope(res, status, { status: false, error, message, detail });

// Every mutation publishes, and **the response is the message** — one construction, one shape, no second
// serialisation of the same fact. This is the old CMS's `sendSuccess` doing both jobs at once
// (behaviour-inventory.md §1.2), and it is what makes a second client's view correct without a refetch.
// Reads do not publish: a broadcast of "someone looked" is noise, and the old CMS only logged it.
//
// `scope` names what the message is *about* — the axis it affects. It rides on the broadcast and not on the
// response, because the responding client already knows what it just did; the scope is for the clients that
// didn't ask. Without it a listener has to infer the resource from the payload's field names, which is
// guessing dressed as a contract — and the vocabulary is a contract, because the Chat app is meant to be an
// equal consumer of this feed (plan §4.5).
//
// `broadcast` defaults to `data` and exists for the one case where they must differ: an asset's upload ticket
// is a *capability*, so it belongs in the answer to the client that asked and not in a message every client
// receives.
function mutate(res, type, data, scope, broadcast = data) {
	feed.publish(type, scope === undefined ? broadcast : { scope, ...broadcast });
	return ok(res, data);
}

// The ticket is a write capability for one record, so it is never broadcast — but the reservation *is* news,
// which is why the record is published without it rather than not published at all.
const withoutTicket = ({ ticket, ...rest }) => rest;

function sendFile(req, res, requested) {
	if (!fs.existsSync(requested)) {
		throw new HttpError(404, 'not_found', `No file at ${requested}.`);
	}
	// A directory means the index inside it. That is what lets /admin/ be the canonical URL for
	// the admin, which in turn is what lets the shell keep relative asset paths.
	const file = fs.statSync(requested).isDirectory() ? path.join(requested, 'index.html') : requested;
	const ext = path.extname(file).toLowerCase();
	const type = MIME[ext];
	if (!type) {
		// Only the admin and NUI roots come through here — our own assets — so an extension outside the
		// table is a gap in the table, not a bad request. The path is logged because the status alone is
		// undiagnosable: a 415 here was once seen in the browser console and could not be traced to a
		// request, since the message named the extension and not the file.
		console.error(`[nCMS] no content type for "${ext}" — not serving ${file}`);
		throw new HttpError(415, 'unsupported_type', `No content type for "${ext}".`, { file, ext });
	}

	// **A valid cache, revalidated every time.** These roots are served straight from source with no build
	// step, so the file on disk *is* the deployment — and a stale copy is not merely out of date, it is a
	// changed API against an old client, which is exactly how a working change looks broken. (It happened
	// here: the browser ran a cached app.js that still posted bytes to a route that had started expecting
	// JSON, and the failure read as a server bug.)
	//
	// `no-cache` means "revalidate before use", not "do not store", and the ETag makes that a cheap 304
	// rather than a re-download. `no-store` would be the blunt fix and would give up caching entirely.
	const stat = fs.statSync(file);
	const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
	if (req.headers['if-none-match'] === etag) {
		res.writeHead(304, { etag, 'cache-control': 'no-cache' });
		return res.end();
	}

	const body = fs.readFileSync(file);
	res.writeHead(200, {
		'content-type': type,
		'content-length': body.length,
		'cache-control': 'no-cache',
		etag
	});
	res.end(body);
}

// Raw binary, not multipart: the upload is one file with its metadata in headers, which is exactly the
// shape nMedia's own upload endpoint takes, so the CMS relays rather than re-encodes.
const UPLOAD_TYPES = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
	gif: 'image/gif', tiff: 'image/tiff', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
	mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
	mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

// Streams the body to a file rather than buffering it. The limit is 4 GiB (media.MAX_UPLOAD_BYTES), and a
// Buffer that size is both a memory hazard and at Node's maximum allocation — so the bytes go straight to
// disk and the limit is enforced as they arrive. The caller owns the file and must consume or remove it.
async function readBinaryBodyToFile(req, limit) {
	const declared = Number(req.headers['content-length']);
	if (!Number.isFinite(declared) || declared <= 0) {
		throw new HttpError(411, 'length_required', 'A Content-Length header is required.');
	}
	if (declared > limit) {
		throw new HttpError(413, 'too_large', `Upload is ${declared} bytes; the limit is ${limit}.`, { limit });
	}

	fs.mkdirSync(media.UPLOAD_TMP, { recursive: true });
	const file = path.join(media.UPLOAD_TMP, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	let received = 0;
	try {
		const out = fs.createWriteStream(file);
		for await (const chunk of req) {
			received += chunk.length;
			// Fail loud rather than truncate: a body that lies about its length is not a body to store.
			if (received > limit) throw new HttpError(413, 'too_large', `Upload exceeds ${limit} bytes.`, { limit });
			if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
		}
		await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
	} catch (error) {
		fs.rmSync(file, { force: true });
		throw error;
	}

	if (received !== declared) {
		fs.rmSync(file, { force: true });
		throw new HttpError(400, 'length_mismatch',
			`Received ${received} bytes but Content-Length said ${declared}.`);
	}
	return { file, size: received };
}

// `segments` is [api, <resource>, <id>, <action>, <name>]. The resource is segments[1] — `/api/buckets`
// has no id, while `/api/media/:id` does.
async function handleMedia(req, res, pathname, segments) {
	const resource = segments[1];

	if (resource === 'pool') {
		// The pool's integrity, as two acts: read the report, then act on it. The old CMS deletes inside its
		// `files_check`, which is the wrong shape for a maintenance screen — that is the one place you open to
		// look *before* you act.
		if (req.method === 'GET') return ok(res, media.integrity());
		if (req.method === 'POST') return mutate(res, 'deleted', media.sweepPool(), 'media');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	if (resource === 'nmedia') {
		if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
		return ok(res, { nmedia: await media.nmediaHealth(), url: media.NMEDIA });
	}

	if (resource === 'buckets') {
		if (segments.length === 2) {
			if (req.method === 'GET') return ok(res, media.listBuckets());
			if (req.method === 'POST') return mutate(res, 'add', media.createBucket(await readJsonBody(req)), 'buckets');
			throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
		}
		const bucketId = decodeURIComponent(segments[2]);
		if (req.method === 'PATCH' || req.method === 'PUT') return mutate(res, 'updated', media.renameBucket(bucketId, await readJsonBody(req)), 'buckets');
		if (req.method === 'DELETE') return mutate(res, 'deleted', media.deleteBucket(bucketId), 'buckets');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	if (resource !== 'media' && resource !== 'assets') {
		throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
	}

	if (segments.length === 2) {
		if (req.method === 'GET') {
			const query = new URL(req.url, 'http://localhost').searchParams;
			return ok(res, media.listAssets(query.get('bucket') || null));
		}
		if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
		// **Act one: reserve.** JSON, not bytes. The record is created first and its bytes arrive in their own
		// request, which is what lets the row appear — and its progress be reported — while the upload is still
		// in flight. The old CMS does the same thing, and the same reason applies (upload-and-events-plan.md §A).
		const body = await readJsonBody(req);
		const filename = String(body.filename ?? '').trim();
		const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
		const reserved = media.reserve({
			bucket: body.bucket ?? null,
			filename,
			size: body.size ?? null,
			mime: body.mime ?? UPLOAD_TYPES[extension] ?? 'application/octet-stream'
		});
		return mutate(res, 'add', reserved, 'media', withoutTicket(reserved));
	}

	const id = decodeURIComponent(segments[2]);
	if (segments.length === 3) {
		if (req.method === 'GET') return ok(res, media.getAsset(id));
		if (req.method === 'PATCH' || req.method === 'PUT') {
			// Only what the body names changes — a filename edit does not clear the bucket.
			return mutate(res, 'updated', media.editAsset(id, await readJsonBody(req)), 'media');
		}
		if (req.method === 'DELETE') return mutate(res, 'deleted', media.deleteAsset(id), 'media');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	const action = decodeURIComponent(segments[3]);
	if (action === 'restore' && req.method === 'POST') return mutate(res, 'updated', media.restoreAsset(id), 'media');
	if (action === 'reprocess' && req.method === 'POST') {
		// The body is optional: no body re-queues the whole menu, `{variants:[…]}` names a targeted retry.
		const body = await readOptionalJsonBody(req);
		return mutate(res, 'postproc', await media.reprocess(id, body?.variants), 'media');
	}
	// **Act two: the bytes.** Its own request, so the client can report progress on it and so a reservation
	// that never receives bytes is a visible record someone can delete rather than a request that hangs.
	if (action === 'file' && req.method === 'PUT') {
		const ticket = String(req.headers['x-ticket'] || '');
		if (!ticket) throw new HttpError(400, 'ticket_required', 'An X-Ticket header is required.');
		const incoming = await readBinaryBodyToFile(req, media.MAX_UPLOAD_BYTES);
		try {
			return mutate(res, 'upload', await media.acceptBytes(id, {
				ticket,
				originalPath: incoming.file,
				size: incoming.size
			}), 'media');
		} catch (error) {
			// The pool never took the bytes, so the received file is removed rather than left behind.
			fs.rmSync(incoming.file, { force: true });
			throw error;
		}
	}
	if (action === 'file' && req.method === 'GET') {
		const name = decodeURIComponent(segments[4] ?? 'original');
		const file = media.assetFile(id, name);
		const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
		const body = fs.readFileSync(file);
		res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
		return res.end(body);
	}
	throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) throw new HttpError(400, 'empty_body', 'A JSON body is required.');
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.', err.message);
	}
}

// For routes whose body is optional — `null` means "not sent", which is different from `{}`.
async function readOptionalJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.', err.message);
	}
}

async function handleApi(req, res, pathname) {
	const segments = pathname.split('/').filter(Boolean); // ['api', 'collections', ...]
	if (segments[1] !== 'collections') {
		throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
	}

	if (segments.length === 2) {
		if (req.method === 'GET') return ok(res, store.listCollections());
		if (req.method === 'POST') return mutate(res, 'add', store.createCollection(await readJsonBody(req)), 'collections');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	const key = decodeURIComponent(segments[2]);
	if (segments.length === 3) {
		if (req.method === 'GET') return ok(res, store.getCollection(key));
		if (req.method === 'PATCH' || req.method === 'PUT') {
			return mutate(res, 'updated', store.updateCollection(key, await readJsonBody(req)), 'collections');
		}
		if (req.method === 'DELETE') return mutate(res, 'deleted', store.deleteCollection(key), 'collections');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}
	if (segments[3] === 'definition' && segments.length === 4) {
		if (req.method === 'GET') return ok(res, store.readDefinition(key));
		if (req.method === 'PUT') return mutate(res, 'updated', store.setCollectionDefinition(key, await readJsonBody(req)), 'collections');
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}
	if (segments[3] !== 'entries') {
		throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
	}

	if (segments.length === 4) {
		if (req.method === 'GET') return ok(res, store.listEntries(key));
		// The collection travels with the message: an entry id is unique within its collection, not across
		// them, so a client that only received the id could not tell which list to patch.
		if (req.method === 'POST') {
			return mutate(res, 'add', { collection: key, _id: store.createEntry(key, await readJsonBody(req)) }, 'entries');
		}
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	const id = decodeURIComponent(segments[4]);
	if (req.method === 'GET') return ok(res, store.getEntry(key, id));
	if (req.method === 'PUT') return mutate(res, 'updated', { collection: key, _id: id, entry: store.putEntry(key, id, await readJsonBody(req)) }, 'entries');
	if (req.method === 'DELETE') return mutate(res, 'deleted', { collection: key, _id: id, entry: store.deleteEntry(key, id) }, 'entries');
	throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
}

function handleStatic(req, res, pathname) {
	const hit = STATIC.find(([prefix]) => pathname.startsWith(prefix));
	if (!hit) return false;

	const [prefix, root] = hit;
	const file = path.resolve(root, decodeURIComponent(pathname.slice(prefix.length)));
	// path.resolve collapses '..' segments; refusing anything that escaped the root is the
	// one boundary this server must not delegate to its callers.
	if (file !== root && !file.startsWith(root + path.sep)) {
		throw new HttpError(403, 'path_outside_root', `Refusing to serve ${pathname}.`);
	}
	sendFile(req, res, file);
	return true;
}

const log = createLog({
	quiet: (entry) =>
		QUIET.includes(entry.pathname)
		// The admin and the library are static roots the old CMS served *outside* its own funnel, so their
		// requests never reached its log either. A page load would otherwise be several dozen entries of noise.
		|| STATIC.some(([prefix]) => entry.pathname.startsWith(prefix))
		// The asset bytes: one request per thumbnail — the traffic the original excludes by name (`sendImage`),
		// for exactly this reason.
		|| (entry.method === 'GET' && /^\/api\/media\/[^/]+\/file\//.test(entry.pathname))
});

// The route *shape* — `/api/media/AbC123/file/original` → `/api/media/:id/file/:id`. The old CMS used the
// handler function's own name as the action (`fileAdd`, `listFiles`), because `funnel()` wrapped every route
// and could read `fnc.name`. Our routes are inline, so the shape is the equivalent: stable enough to group and
// filter by, and it keeps record ids out of a log where they would be noise.
//
// The literals are listed rather than inferred. A first attempt guessed "a long alphanumeric segment is an id",
// which labelled `/api/collections` as `/api/:id` — a resource name and an id are the same shape, and only
// knowing the vocabulary tells them apart. A wrong label in a log is worse than a coarse one: it groups
// unrelated traffic together and the reader has no way to notice.
const ROUTE_WORDS = new Set(['api', 'collections', 'entries', 'definition', 'media', 'assets', 'buckets',
	'nmedia', 'pool', 'events', 'ping', 'log', 'file', 'restore', 'reprocess']);

function shapeOf(pathname) {
	const segments = pathname.split('/').filter(Boolean);
	if (segments[0] !== 'api') return pathname;
	return '/api/' + segments.slice(1).map((segment) => (ROUTE_WORDS.has(segment) ? segment : ':id')).join('/');
}

const server = http.createServer((req, res) => {
	const started = Date.now();
	const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

	// Every request is logged, successes and failures alike — the old CMS's log is a request log, and a log
	// that only records what worked is not an audit trail. (Its own quiet routes are excluded inside the log.)
	const record = (ok, error) => log.record({
		pathname,
		ip: req.socket.remoteAddress ?? null,
		method: req.method,
		url: req.url,
		action: `${req.method} ${shapeOf(pathname)}`,
		status: ok,
		ms: Date.now() - started,
		...(error === undefined ? {} : { error })
	});

	run(req, res).then(
		() => record(true),
		(error) => {
			if (error instanceof HttpError) {
				record(false, error.error);
				return fail(res, error.status, error.error, error.message, error.detail);
			}
			console.error('[nCMS] unhandled:', error);
			record(false, 'internal');
			return fail(res, 500, 'internal', error.message);
		}
	);
});

async function run(req, res) {
	const { pathname, search } = new URL(req.url, `http://${req.headers.host}`);
	const segments = pathname.split('/').filter(Boolean);

		// The feed. It is not an envelope response — the stream *is* the response and it stays open, so it
		// is handled before anything that would try to write a body and end it.
		if (pathname === '/api/events') {
			if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
			feed.subscribe(res);
			return;
		}
		// The catch-up half. `session` comes from the `hello` frame on the stream (behaviour-inventory §3);
		// without it there is nothing to drain, which is the honest answer rather than an empty success.
		if (pathname === '/api/ping') {
			if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
			const body = await readOptionalJsonBody(req);
			return ok(res, { session: body?.session ?? null, log: body?.session ? feed.drain(body.session) : null, seq: feed.seq });
		}
		// The request log, read with a cursor. Deliberately **not** on the feed: the feed exists to keep a second
		// client's view correct, so it carries changes and keeps reads off. A log wants the opposite — every
		// request, reads included — and it is read on demand rather than pushed, which is what a cursor is for.
		if (pathname === '/api/log') {
			if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
			const params = new URL(req.url, 'http://localhost').searchParams;
			return ok(res, log.since(Number(params.get('since') ?? 0), Number(params.get('limit') ?? 200)));
		}

		if (pathname.startsWith('/api/media') || pathname.startsWith('/api/buckets')
			|| pathname.startsWith('/api/assets') || pathname.startsWith('/api/nmedia')
			|| pathname.startsWith('/api/pool')) {
			return handleMedia(req, res, pathname, segments);
		}
		if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
		// The admin has one canonical URL, so its relative asset paths resolve. Links to "/"
		// still work.
		if (pathname === '/') {
			// Carry the query through: the library reads things like ?nui-debug from
			// location.search at load time, and a bare redirect would silently drop them.
			res.writeHead(302, { location: `/admin/${search}` });
			return res.end();
		}
		if (handleStatic(req, res, pathname)) return;
		return fail(res, 404, 'not_found', `No route for ${pathname}.`);
}

server.listen(PORT, () => {
	console.log(`[nCMS] http://localhost:${PORT}/`);
	console.log(`[nCMS] data root: ${store.DATA_ROOT}`);
	console.log(`[nCMS] media: nMedia at ${media.NMEDIA}`);
	for (const collection of store.listCollections()) {
		console.log(`[nCMS]   ${collection.key} — ${collection.name}`);
	}
	media.events.on('asset-settled', (asset) => {
		// The **same shape as the route's** `postproc` (and as every other media message): the asset's own
		// fields. It used to be `{id, bucket, asset}`, which made `postproc` the one type with two shapes — and a
		// client that read the route's had no `id`, so it announced "undefined is ready". One type, one shape; the
		// vocabulary is a contract, not a convenience.
		feed.publish('postproc', { scope: 'media', ...withoutTicket(asset) });
	});
	media.startJobDriver();
	media.nmediaHealth().then((health) =>
		console.log(`[nCMS] nMedia health: ${health.status} ${JSON.stringify(health.processors ?? {})}`));
});
