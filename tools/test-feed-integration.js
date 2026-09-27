'use strict';

// End-to-end proof of the event feed: a real server, a real SSE stream, real HTTP mutations.
//
//   node tools/test-feed-integration.js
//
// The unit test (tools/test-feed.js) proves the hub. This proves the *wiring* — that a mutation made
// through the API, by one client, arrives on the stream of another. That is the property the whole
// design rests on, and it cannot be shown without a server.
//
// It runs its own instance on a spare port over a throwaway data root (`NCMS_DATA_ROOT`), because the
// user's server is normally running on 3300 and two processes writing one nDB file is a corruption, not
// a race. This is why that env var exists.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.NCMS_TEST_PORT || 3399);
const ROOT = path.join(__dirname, '..', 'data', 'feed-test');
const READY = `http://localhost:${PORT}/`;

let passed = 0;
const failures = [];

function check(label, condition, detail) {
	if (condition) {
		passed++;
		console.log(`  ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(port, method, route, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = http.request({
			port, method, path: route,
			headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}
		}, (res) => {
			const chunks = [];
			res.setEncoding('utf8');
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				const raw = chunks.join('');
				try {
					resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
				} catch {
					reject(new Error(`Non-JSON response from ${method} ${route}: ${raw.slice(0, 200)}`));
				}
			});
		});
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

// A minimal SSE client: accumulates frames and keeps the parsed messages. Parses the wire format rather
// than borrowing the server's internals, so a framing mistake fails here rather than in a browser.
function openStream(port) {
	return new Promise((resolve, reject) => {
		const req = http.get({ port, path: '/api/events' }, (res) => {
			if (res.statusCode !== 200) return reject(new Error(`events returned ${res.statusCode}`));
			const messages = [];
			let buffer = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				buffer += chunk;
				let index;
				while ((index = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					const line = block.split('\n').find((l) => l.startsWith('data: '));
					if (line) messages.push(JSON.parse(line.slice(6)));
				}
			});
			resolve({ messages, headers: res.headers, close: () => req.destroy() });
		});
		req.on('error', reject);
	});
}

async function waitFor(messages, predicate, label, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const hit = messages.find(predicate);
		if (hit) return hit;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(messages.map((m) => m.type))}`);
}

function startServer() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
			env: { ...process.env, PORT: String(PORT), NCMS_DATA_ROOT: ROOT },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		const onData = (chunk) => {
			out += chunk;
			if (out.includes(READY)) {
				child.stdout.off('data', onData);
				resolve(child);
			}
		};
		child.stdout.on('data', onData);
		child.stderr.on('data', (chunk) => { out += chunk; });
		child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out.slice(-800)}`)));
		setTimeout(() => reject(new Error(`server did not start: ${out.slice(-800)}`)), 15000);
	});
}

async function main() {
	fs.rmSync(ROOT, { recursive: true, force: true });
	const server = await startServer();

	try {
		// ── The stream ────────────────────────────────────────────────────────────────────
		console.log('\nthe stream');
		const stream = await openStream(PORT);
		check('GET /api/events answers 200', true);
		check('the content type is event-stream', /text\/event-stream/.test(stream.headers['content-type']),
			stream.headers['content-type']);
		check('a batching proxy is told not to buffer', stream.headers['x-accel-buffering'] === 'no');
		check('the cache is off (a cached stream is not a stream)', /no-cache/.test(stream.headers['cache-control']));

		const hello = await waitFor(stream.messages, (m) => m.type === 'hello', 'the hello frame');
		check('the stream introduces the client to its own session', typeof hello.session === 'string' && hello.session.length > 0);
		check('the introduction carries no broadcast seq, so it cannot make other clients read a hole',
			hello.seq === undefined, JSON.stringify(hello));
		check('it reports a baseline so a client can tell a real gap from its first message',
			hello.atSeq === 0, JSON.stringify(hello));

		// ── A mutation by one client, seen by another ────────────────────────────────────
		// This is the property. The mutating request and the observing stream are different connections.
		console.log('\na mutation reaches the stream');
		const created = await request(PORT, 'POST', '/api/collections', { name: 'Feed Test' });
		check('the mutation succeeds', created.status === 200 && created.body.status === true,
			JSON.stringify(created.body).slice(0, 200));

		const added = await waitFor(stream.messages, (m) => m.type === 'add' && m.key === 'feed-test', 'the add message');
		check('the message carries the created record', added.key === 'feed-test' && added.name === 'Feed Test',
			JSON.stringify(added));
		check('the message carries a broadcast seq', typeof added.seq === 'number' && added.seq > 0);
		check('the message is timestamped', typeof added.time === 'number');
		// `scope` is what a listener routes on. Without it the client would have to infer the resource from
		// field names, which is guessing — and this vocabulary is shared with the Chat app.
		check('the message names its scope', added.scope === 'collections', JSON.stringify(added).slice(0, 160));

		// ── The catch-up channel, and no double-apply ────────────────────────────────────
		console.log('\nping and dedupe');
		const ping = await request(PORT, 'POST', '/api/ping', { session: hello.session });
		check('POST /api/ping answers', ping.status === 200 && ping.body.status === true);
		check('the backlog contains the message the stream already delivered',
			ping.body.data.log.some((m) => m.seq === added.seq), JSON.stringify(ping.body.data.log.map((m) => m.type)));

		// The client's rule, over both channels — the reason the seq exists.
		let watermark = 0;
		const applied = [];
		for (const message of [...stream.messages, ...ping.body.data.log]) {
			if (message.seq === undefined || message.seq <= watermark) continue;
			watermark = message.seq;
			applied.push(message.type);
		}
		check('applying the stream and the drained backlog yields each message exactly once',
			new Set(applied).size === applied.length && applied.filter((t) => t === 'add').length === 1,
			JSON.stringify(applied));

		const second = await request(PORT, 'POST', '/api/ping', { session: hello.session });
		check('a second ping drains nothing — the backlog was cleared', second.body.data.log.length === 0);

		// ── More message types ───────────────────────────────────────────────────────────
		console.log('\nmessage types');
		await request(PORT, 'DELETE', '/api/collections/feed-test');
		await waitFor(stream.messages, (m) => m.type === 'deleted', 'the deleted message');
		check('a delete publishes `deleted` with the record identity',
			stream.messages.some((m) => m.type === 'deleted' && m.key === 'feed-test'));

		const bucket = await request(PORT, 'POST', '/api/buckets', { name: 'Feed Bucket' });
		check('a bucket create succeeds', bucket.status === 200 && bucket.body.status === true, JSON.stringify(bucket.body).slice(0, 200));
		await waitFor(stream.messages, (m) => m.type === 'add' && m.name === 'Feed Bucket', 'the bucket add message');
		check('bucket messages use the same vocabulary as collections — one shape, not one per resource',
			stream.messages.some((m) => m.type === 'add' && m.name === 'Feed Bucket'));
		check('and they name their own scope',
			stream.messages.some((m) => m.type === 'add' && m.name === 'Feed Bucket' && m.scope === 'buckets'));

		// An entry message must say WHICH collection: an entry id is unique within its collection, not
		// across them, so an id alone could not tell a listener which list to patch.
		console.log('\nentry scope');
		await request(PORT, 'POST', '/api/collections', { name: 'Scoped Entries' });
		const entry = await request(PORT, 'POST', '/api/collections/scoped-entries/entries', { name: 'one' });
		check('an entry create succeeds', entry.status === 200, JSON.stringify(entry.body).slice(0, 200));
		const entryMessage = await waitFor(stream.messages,
			(m) => m.type === 'add' && m.scope === 'entries', 'the entry add message');
		check('the entry message names its collection', entryMessage.collection === 'scoped-entries',
			JSON.stringify(entryMessage).slice(0, 200));
		check('and its id', entryMessage._id === entry.body.data._id);
		await request(PORT, 'DELETE', '/api/collections/scoped-entries');

		const renamed = await request(PORT, 'PATCH', `/api/buckets/${bucket.body.data._id}`, { name: 'Feed Bucket 2' });
		check('a bucket rename succeeds', renamed.status === 200, JSON.stringify(renamed.body).slice(0, 200));
		await waitFor(stream.messages, (m) => m.type === 'updated', 'the updated message');
		check('a rename publishes `updated`', stream.messages.some((m) => m.type === 'updated'));

		// ── Reads do not publish ─────────────────────────────────────────────────────────
		// A broadcast of "someone looked" is noise. The old CMS logged reads but the feed is for changes.
		console.log('\nreads stay off the feed');
		const before = stream.messages.length;
		await request(PORT, 'GET', '/api/collections');
		await request(PORT, 'GET', '/api/buckets');
		await request(PORT, 'GET', '/api/media');
		await sleep(150);
		check('three reads produced no messages', stream.messages.length === before,
			`${before} → ${stream.messages.length}`);

		// ── A failing request publishes nothing ──────────────────────────────────────────
		console.log('\nfailures stay off the feed');
		const beforeFail = stream.messages.length;
		const bad = await request(PORT, 'POST', '/api/collections', { name: '' });
		check('an invalid create is refused', bad.status === 400, JSON.stringify(bad.body).slice(0, 160));
		await sleep(150);
		check('a refused mutation broadcasts nothing — there is no change to announce',
			stream.messages.length === beforeFail, `${beforeFail} → ${stream.messages.length}`);

		// ── Two clients ──────────────────────────────────────────────────────────────────
		console.log('\ntwo clients');
		const second2 = await openStream(PORT);
		const hello2 = await waitFor(second2.messages, (m) => m.type === 'hello', 'the second hello');
		check('a second client gets a different session', hello2.session !== hello.session);
		await request(PORT, 'POST', '/api/collections', { name: 'Both See This' });
		await waitFor(stream.messages, (m) => m.type === 'add' && m.name === 'Both See This', 'the first client');
		await waitFor(second2.messages, (m) => m.type === 'add' && m.name === 'Both See This', 'the second client');
		check('both clients received the same message', true);
		check('and with the same seq',
			stream.messages.find((m) => m.name === 'Both See This').seq
			=== second2.messages.find((m) => m.name === 'Both See This').seq);

		second2.close();
		stream.close();
	} finally {
		server.kill();
		// Give the child a moment to release the nDB folder lock before the tree is removed.
		await sleep(300);
		fs.rmSync(ROOT, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) console.log(failures.map((label) => `  - ${label}`).join('\n'));
	process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
	console.error(error.message ?? error);
	fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(1);
});
