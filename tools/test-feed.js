'use strict';

// Proves the event feed's delivery guarantees.
//
//   node tools/test-feed.js
//
// The interesting assertions are the last two. Everything else is plumbing; those two are the
// design claim — that a monotonic `seq` makes it safe to apply both channels (the live stream and
// the drained backlog) without double-applying, and that it is what lets a client *notice* it fell
// behind the 50-entry cap instead of silently rendering stale rows.

const { createFeed, BACKLOG_LIMIT } = require('../lib/feed.js');

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

// A stand-in for `ServerResponse` that keeps what was written and lets a test fire 'close'.
function fakeResponse() {
	const listeners = {};
	return {
		frames: [],
		headers: null,
		status: null,
		writeHead(status, headers) { this.status = status; this.headers = headers; },
		write(chunk) { this.frames.push(chunk); return true; },
		on(event, fn) { (listeners[event] ??= []).push(fn); },
		end() { (listeners.close ?? []).forEach((fn) => fn()); },
		emit(event) { (listeners[event] ?? []).forEach((fn) => fn()); }
	};
}

// Every message the stream carried, in wire order. Parses the real SSE framing rather than reading
// internal state, so a malformed frame fails here instead of in a browser.
function streamed(res) {
	const out = [];
	for (const chunk of res.frames) {
		for (const block of chunk.split('\n\n')) {
			const data = block.split('\n').find((line) => line.startsWith('data: '));
			if (data) out.push(JSON.parse(data.slice(6)));
		}
	}
	return out;
}

function main() {
	const feed = createFeed();

	// ── Opening a stream ───────────────────────────────────────────────────────────────────
	console.log('\nsubscribe');
	const a = fakeResponse();
	const clientA = feed.subscribe(a);
	check('responds 200 with an event-stream content type', a.status === 200 && /text\/event-stream/.test(a.headers['content-type']));
	check('turns off proxy buffering (the feed arrives in bursts behind a batching proxy otherwise)',
		a.headers['x-accel-buffering'] === 'no' && /no-cache/.test(a.headers['cache-control']));
	check('sends a retry hint', a.frames[0] === 'retry: 10000\n\n');

	const b = fakeResponse();
	const clientB = feed.subscribe(b);
	check('two clients get distinct ids', clientA.sessionId !== clientB.sessionId);

	// The id has to reach the client on the stream — that is the only handle `/api/ping` can use.
	const helloA = streamed(a).find((m) => m.type === 'hello');
	check('the stream introduces the client to its own session id (this is what /ping drains)',
		helloA?.session === clientA.sessionId, JSON.stringify(helloA));
	check('the introduction reports the counter as a baseline, without claiming a number of its own',
		helloA.atSeq === 0 && helloA.seq === undefined, JSON.stringify(helloA));
	check('the introduction is not broadcast — the other client never sees it',
		streamed(b).find((m) => m.type === 'hello')?.session === clientB.sessionId);
	check('an unknown message type is carried as-is — the vocabulary is the route payloads, not a whitelist here',
		helloA.type === 'hello');
	check('the hub reports two live clients', feed.size === 2);

	// ── Broadcast ──────────────────────────────────────────────────────────────────────────
	console.log('\npublish');
	const first = feed.publish('add', { id: 'abc', bucket: 'b1' });
	check('publish reaches every client', streamed(a).some((m) => m.type === 'add') && streamed(b).some((m) => m.type === 'add'));
	check('both clients see the SAME seq for the same message',
		streamed(a).find((m) => m.type === 'add').seq === streamed(b).find((m) => m.type === 'add').seq);
	check('the payload is the message — there is no wrapper to unwrap', first.id === 'abc' && first.bucket === 'b1');
	check('publish returns the message it broadcast, so a route can use it as its response body',
		first.type === 'add' && typeof first.time === 'number');

	const second = feed.publish('updated', { id: 'abc' });
	check('seq increases monotonically', second.seq === first.seq + 1, `${first.seq} → ${second.seq}`);
	check('the wire carries the seq as `id:` so EventSource keeps it as lastEventId',
		a.frames.join('').includes(`id: ${first.seq}\ndata: `));

	// ── The backlog ────────────────────────────────────────────────────────────────────────
	console.log('\nbacklog (the /api/ping half)');
	const drained = feed.drain(clientA.sessionId);
	check('drain returns everything published since the last drain', drained.length === 2, String(drained.length));
	check('the drained entries are the messages, in order',
		drained[0].type === 'add' && drained[1].type === 'updated');
	check('drain clears — a second drain is empty', feed.drain(clientA.sessionId).length === 0);
	check('draining one client leaves the other its own backlog', feed.drain(clientB.sessionId).length === 2);
	check('draining an unknown session answers rather than throwing', feed.drain('nosuchsession') === null);

	// ── The cap ────────────────────────────────────────────────────────────────────────────
	// 50 is the original's limit. What matters is which end it keeps: the newest, because the
	// client's next move on a gap is to reload, not to replay.
	console.log('\nthe 50-entry cap');
	const c = fakeResponse();
	const clientC = feed.subscribe(c);
	for (let i = 0; i < BACKLOG_LIMIT + 10; i++) feed.publish('updated', { id: `id-${i}` });
	const capped = feed.drain(clientC.sessionId);
	check(`the backlog holds at most ${BACKLOG_LIMIT}`, capped.length === BACKLOG_LIMIT, String(capped.length));
	check('the cap drops the OLDEST, so the backlog ends at the newest message',
		capped[capped.length - 1].id === `id-${BACKLOG_LIMIT + 9}`, capped[capped.length - 1].id);
	check('a capped client is detectably behind: the first replayed seq is not the next one',
		capped[0].seq > 1);

	// ── Addressable send ───────────────────────────────────────────────────────────────────
	console.log('\nsend (addressable)');
	const beforeB = streamed(b).length;
	feed.send(clientB.sessionId, 'targeted', { id: 'only-b' });
	check('send reaches the named client', streamed(b).some((m) => m.type === 'targeted'));
	check('send does not reach the others', !streamed(a).some((m) => m.type === 'targeted'));
	check('the count of frames on the other stream is unchanged', streamed(b).length === beforeB + 1);
	check('send to an unknown session returns null', feed.send('nosuchsession', 'x') === null);

	// ── A client that has gone away ────────────────────────────────────────────────────────
	// The boundary case: a socket that vanished must not be able to stop the broadcast for
	// everyone else, and dropping it must be reported rather than silent.
	console.log('\ndead clients');
	// The warnings these cases produce are part of the guarantee — a client vanishing is tolerated at
	// the boundary and must leave a trace — so they are captured and asserted rather than printed.
	const warnings = [];
	const realWarn = console.warn;
	console.warn = (line) => warnings.push(String(line));

	const d = fakeResponse();
	feed.subscribe(d);
	d.write = () => { throw new Error('EPIPE'); };
	const sizeBefore = feed.size;
	feed.publish('deleted', { id: 'x' });
	check('a throwing writer does not break publish for the others', streamed(a).some((m) => m.type === 'deleted'));
	check('the dead client is dropped', feed.size === sizeBefore - 1, `${sizeBefore} → ${feed.size}`);
	check('the drop is logged, not silent (a boundary tolerance must leave a trace)',
		warnings.some((line) => /EPIPE/.test(line)), JSON.stringify(warnings));
	check('the surviving client is still addressable', feed.send(clientB.sessionId, 'still-here') !== null);

	const e = fakeResponse();
	const clientE = feed.subscribe(e);
	e.emit('close');
	check('a stream that closes is dropped without a publish', feed.size === sizeBefore - 1);
	check('a dropped client is no longer drainable', feed.drain(clientE.sessionId) === null);
	// The two drop paths are deliberately different. A closed stream is a reload, a navigation or a closed
	// tab — normal traffic that carries no information, so reporting it would put a warning in the log on
	// every page refresh. Only a write into a dead stream is the unexpected one.
	check('a normal close is NOT reported as a fault', !warnings.some((line) => /stream closed/.test(line)),
		JSON.stringify(warnings));

	// The same event on an intentional shutdown must stay quiet: a warning that means "this went away
	// unexpectedly" is wrong for the one case that is expected.
	warnings.length = 0;
	const transient = createFeed();
	const f2 = fakeResponse();
	transient.subscribe(f2);
	transient.close();
	check('closing the feed on purpose warns about nothing', warnings.length === 0, JSON.stringify(warnings));
	console.warn = realWarn;

	// ── The design claim: two channels, one counter ────────────────────────────────────────
	// This is what the extra `seq` buys. A client applies from both channels and must end up with
	// each message exactly once — that is the whole reason the original's "apply the replay" fix is
	// safe to make.
	console.log('\ndedupe across both channels');
	const f = fakeResponse();
	const clientF = feed.subscribe(f);
	feed.publish('add', { id: 'p1' });
	feed.publish('add', { id: 'p2' });

	// The client's own algorithm: keep the highest seq applied; apply anything newer.
	let lastSeq = 0;
	const applied = [];
	const applyFrom = (messages) => {
		for (const message of messages) {
			if (message.type === 'hello') continue;
			if (message.seq <= lastSeq) continue;
			lastSeq = message.seq;
			applied.push(message.id);
		}
	};

	// The live stream delivered both; the ping then replays the same two from the backlog.
	applyFrom(streamed(f));
	const replayed = feed.drain(clientF.sessionId);
	applyFrom(replayed);
	check('the backlog really does carry messages the live stream already delivered',
		replayed.length === 2, String(replayed.length));
	check('applying both channels yields each message exactly once',
		JSON.stringify(applied) === JSON.stringify(['p1', 'p2']), JSON.stringify(applied));
	check('the client is current afterwards', lastSeq === feed.seq);

	// ── The recovery path ──────────────────────────────────────────────────────────────────
	// The one thing the original cannot do: know that it is behind. With the cap in play the backlog
	// may not contain the miss, and rendering a partial replay is worse than reloading.
	console.log('\nrecovery — detecting a gap');
	// The client's watermark rule, isolated: a gap is `seq` jumping by more than one.
	const gapAfter = (messages, from) => {
		let last = from;
		let gap = false;
		for (const message of messages) {
			if (message.seq === undefined) continue; // addressed to this client only; no stream position
			if (message.seq > last + 1) gap = true;
			last = message.seq;
		}
		return { gap, last };
	};

	const i = fakeResponse();
	const clientI = feed.subscribe(i);
	const watermarkBefore = feed.seq;
	feed.publish('add', { id: 'seen' });
	check('the subscribe introduction does NOT consume a broadcast seq — otherwise every client would read a hole',
		gapAfter(streamed(i), watermarkBefore).gap === false,
		`watermark ${watermarkBefore}, stream ${JSON.stringify(streamed(i).map((m) => [m.type, m.seq]))}`);
	check('an addressed message does not consume a broadcast seq either',
		(() => {
			const before = feed.seq;
			feed.send(clientI.sessionId, 'targeted', { id: 'x' });
			return feed.seq === before;
		})());
	check('contiguous broadcasts report no gap', gapAfter(streamed(i), watermarkBefore).gap === false);

	// A client that was away: its backlog was capped, so the first entry is far ahead of where it was.
	const j = fakeResponse();
	const clientJ = feed.subscribe(j);
	feed.drain(clientJ.sessionId); // pretend it has been current until now
	const behind = feed.seq;
	for (let n = 0; n < BACKLOG_LIMIT + 5; n++) feed.publish('updated', { id: `miss-${n}` });
	const backlog = feed.drain(clientJ.sessionId);
	check('a capped backlog is detected as a gap, so the client reloads instead of replaying a hole',
		gapAfter(backlog, behind).gap === true);
	check('an uncapped backlog replays with no gap',
		gapAfter(backlog.slice(0, BACKLOG_LIMIT), backlog[0].seq - 1).gap === false);

	feed.close();
	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) console.log(failures.map((label) => `  - ${label}`).join('\n'));
	process.exit(failures.length ? 1 : 0);
}

main();
