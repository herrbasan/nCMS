'use strict';

// nCMS server. Zero dependencies — node:http for the transport, nDB in-process for storage.
// It carries glue only: static file serving and the JSON API. No framework, no middleware
// chain, no templating.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./lib/store.js');
const { HttpError } = require('./lib/http-error.js');

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

function sendFile(res, requested) {
	if (!fs.existsSync(requested)) {
		throw new HttpError(404, 'not_found', `No file at ${requested}.`);
	}
	// A directory means the index inside it. That is what lets /admin/ be the canonical URL for
	// the admin, which in turn is what lets the shell keep relative asset paths.
	const file = fs.statSync(requested).isDirectory() ? path.join(requested, 'index.html') : requested;
	const ext = path.extname(file).toLowerCase();
	const type = MIME[ext];
	if (!type) throw new HttpError(415, 'unsupported_type', `No content type for "${ext}".`);
	const body = fs.readFileSync(file);
	res.writeHead(200, { 'content-type': type, 'content-length': body.length });
	res.end(body);
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

async function handleApi(req, res, pathname) {
	const segments = pathname.split('/').filter(Boolean); // ['api', 'collections', ...]
	if (segments[1] !== 'collections') {
		throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
	}

	if (segments.length === 2) {
		if (req.method === 'GET') return ok(res, store.listCollections());
		if (req.method === 'POST') return ok(res, store.createCollection(await readJsonBody(req)));
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	const key = decodeURIComponent(segments[2]);
	if (segments.length === 3) {
		if (req.method === 'GET') return ok(res, store.getCollection(key));
		if (req.method === 'PATCH' || req.method === 'PUT') {
			return ok(res, store.updateCollection(key, await readJsonBody(req)));
		}
		if (req.method === 'DELETE') return ok(res, store.deleteCollection(key));
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}
	if (segments[3] !== 'entries') {
		throw new HttpError(404, 'not_found', `No API route for ${pathname}.`);
	}

	if (segments.length === 4) {
		if (req.method === 'GET') return ok(res, store.listEntries(key));
		if (req.method === 'POST') return ok(res, { _id: store.createEntry(key, await readJsonBody(req)) });
		throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
	}

	const id = decodeURIComponent(segments[4]);
	if (req.method === 'GET') return ok(res, store.getEntry(key, id));
	if (req.method === 'PUT') return ok(res, store.putEntry(key, id, await readJsonBody(req)));
	if (req.method === 'DELETE') return ok(res, store.deleteEntry(key, id));
	throw new HttpError(405, 'method_not_allowed', `${req.method} ${pathname}`);
}

function handleStatic(res, pathname) {
	const hit = STATIC.find(([prefix]) => pathname.startsWith(prefix));
	if (!hit) return false;

	const [prefix, root] = hit;
	const file = path.resolve(root, decodeURIComponent(pathname.slice(prefix.length)));
	// path.resolve collapses '..' segments; refusing anything that escaped the root is the
	// one boundary this server must not delegate to its callers.
	if (file !== root && !file.startsWith(root + path.sep)) {
		throw new HttpError(403, 'path_outside_root', `Refusing to serve ${pathname}.`);
	}
	sendFile(res, file);
	return true;
}

const server = http.createServer((req, res) => {
	(async () => {
		const { pathname, search } = new URL(req.url, `http://${req.headers.host}`);
		if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
		// The admin has one canonical URL, so its relative asset paths resolve. Links to "/"
		// still work.
		if (pathname === '/') {
			// Carry the query through: the library reads things like ?nui-debug from
			// location.search at load time, and a bare redirect would silently drop them.
			res.writeHead(302, { location: `/admin/${search}` });
			return res.end();
		}
		if (handleStatic(res, pathname)) return;
		return fail(res, 404, 'not_found', `No route for ${pathname}.`);
	})().catch((err) => {
		if (err instanceof HttpError) return fail(res, err.status, err.error, err.message, err.detail);
		console.error('[nCMS] unhandled:', err);
		return fail(res, 500, 'internal', err.message);
	});
});

server.listen(PORT, () => {
	console.log(`[nCMS] http://localhost:${PORT}/`);
	console.log(`[nCMS] data root: ${path.join(ROOT, 'data')}`);
	for (const collection of store.listCollections()) {
		console.log(`[nCMS]   ${collection.key} — ${collection.name}`);
	}
});
