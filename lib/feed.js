'use strict';

// The event feed. A hub of Server-Sent-Events streams, plus a per-client backlog — the old CMS's
// `EventBroadcast` / `put_log` / `pingFillLog`, rebuilt on `node:http` with no dependencies.
//
// The old CMS has no separate event system: the HTTP response and the broadcast are the same two
// functions (`sendSuccess`/`sendError`), so **every request is a message** and mutations are simply
// the entries whose payload is an object (behaviour-inventory.md §1). This keeps that property —
// the route's own response payload *is* the message, so there is one shape and no second
// serialisation.
//
// ── Two channels, deliberately ───────────────────────────────────────────────────────────────
//
//   SSE (`GET /api/events`)  the live message, immediately
//   `POST /api/ping`         drains a client's backlog and returns it — the catch-up channel
//
// The old CMS runs the client's ping every 5 s, which is what makes delivery a guarantee rather
// than a hope: a dropped stream costs at most one ping interval. Two things about its backlog are
// worth keeping explicitly:

//   * **a cap.** 50 entries per session (`put_log` → `pingFillLog`). Beyond that the oldest are
//     dropped, which means a client that was away long enough *cannot* be brought up to date by
//     replay. The original never noticed, because it never applied the replay at all (§3).
//
//   * **it is pushed unconditionally**, in parallel with the live stream — so the same message
//     arrives twice, once on each channel. The original got away with that only because the
//     replayed copy was written to a log and never acted on.
//
// ── What we do differently, and why it is three lines instead of one ─────────────────────────
//
// Applying the replay is the fix the inventory asks for ("the fix is to run the same apply() over
// the drained entries"). Applied naively it double-applies every message, because the backlog holds
// everything the live stream already delivered. So every **broadcast** carries a monotonic `seq`
// and the client ignores anything it has already seen. One counter then buys three things:
//
//   * no double-apply, on either channel, with no bookkeeping per message type;
//   * a **recovery** path the original never had — the client can tell it is *behind* (the first
//     replayed `seq` is not the next one) and reload the view, which is the only correct answer
//     when the 50-entry cap has actually dropped something;
//   * `id:` on the wire, which is what `EventSource` keeps as `lastEventId`.
//
// That counter is the **broadcast stream's** position and nothing else's. A message addressed to one
// client — the `hello` on subscribe, and `send()` — takes no number from it. It was tempting to
// sequence those too, and it is wrong: a number spent on a message only one client receives is a hole
// in every other client's stream, so they all read it as a dropped message and reload for nothing.
// (A test caught exactly that.) Addressed messages are therefore delivered once, unsequenced, and are
// not replayable — the consequence is spelled out on `send()`.
//
// Without sessions there is one shared hub, and `send()` to a single client is kept for when there
// are (auth is nPort's job, plan §2 B). A client is still *addressable* today: `subscribe` issues
// the id, which is what makes `/api/ping` able to drain the right backlog.

// 50 is the original's cap, kept so the recovery path is exercised at the same threshold the
// original's clients lived with rather than at an invented one.
const BACKLOG_LIMIT = 50;

function createFeed({ backlogLimit = BACKLOG_LIMIT } = {}) {
	let seq = 0;
	const clients = new Map(); // sessionId → { res, log }

	// `id:` is written only for sequenced messages. An addressed message has no position in the
	// broadcast stream, and emitting `id: undefined` would also clobber the `lastEventId` the client
	// keeps for a broadcast it *did* receive.
	function sseWrite(res, message) {
		const id = message.seq === undefined ? '' : `id: ${message.seq}\n`;
		return res.write(`${id}data: ${JSON.stringify(message)}\n\n`);
	}

	// A client that has gone away must not take the broadcast down with it. Both failure shapes are
	// handled: a synchronous throw from a destroyed stream, and the asynchronous 'close' a client that
	// vanished without one. Either way the client is dropped — and only the throw is *reported*, because
	// the two are not the same event. A browser navigating, reloading or closing a tab closes the stream,
	// which is normal traffic that says nothing; a write into a dead stream is the unexpected one, and it
	// must leave a trace (a boundary tolerance without a trace is a silent failure — prime directive).
	function drop(sessionId, why, { expected = false } = {}) {
		if (!clients.delete(sessionId)) return;
		if (expected) return;
		console.warn(`[nCMS] feed: dropped client ${sessionId} (${why}); ${clients.size} remaining.`);
	}

	function write(client, message) {
		try {
			sseWrite(client.res, message);
			return message;
		} catch (error) {
			drop(client.sessionId, error.message);
			return null;
		}
	}

	return {
		// Opens one stream. The client is told its own id on the stream rather than in a response
		// body, because the stream *is* the subscription — and that id is the handle `/api/ping` uses.
		subscribe(res) {
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
				// Tells a reverse proxy not to buffer the stream — without it the feed "works" locally
				// and arrives in bursts behind anything that batches responses.
				'x-accel-buffering': 'no'
			});
			// The client reconnects on its own if the stream drops; 10 s is the original's cadence
			// (its `/ping` runs every 5 s and re-establishes).
			res.write('retry: 10000\n\n');

			const sessionId = Math.random().toString(36).slice(2, 12);
			const client = { sessionId, res, log: [] };
			clients.set(sessionId, client);
			res.on('close', () => drop(sessionId, 'stream closed', { expected: true }));

			// An introduction, not news: sent to this client alone and **unsequenced**, because
			// taking a number from the broadcast counter would put a hole in every other client's
			// stream and make them all read it as a dropped message.
			//
			// `atSeq` is the counter's *current* value, reported rather than claimed. Without a baseline
			// the client cannot distinguish "I am behind" from "this is simply my first message": its
			// watermark would be 0 and the next broadcast — whatever its number — would read as a gap.
			write(client, { type: 'hello', time: Date.now(), session: sessionId, atSeq: seq });
			return client;
		},

		// The one broadcast point. Returns the message so a caller can also use it as its response
		// body — which is how "the response *is* the message" stays true with one construction.
		publish(type, data = {}) {
			const message = { ...data, seq: ++seq, type, time: Date.now() };
			for (const client of [...clients.values()]) {
				client.log.push(message);
				if (client.log.length > backlogLimit) client.log.shift();
				write(client, message);
			}
			return message;
		},

		// Addressed delivery, for when sessions exist.
		//
		// Deliberately **unsequenced and not backlogged**: the counter belongs to the broadcast stream
		// so that a gap in it means exactly one thing, and a message only one client ever receives has
		// no position in that stream. The consequence, stated rather than hidden: a targeted message
		// does not survive a dropped stream, because replaying it later — out of order with respect to
		// the broadcasts around it — has no defined meaning. If sessions ever need targeted catch-up,
		// it is a second backlog and a decision to make then, not something to infer here.
		send(sessionId, type, data = {}) {
			const client = clients.get(sessionId);
			if (!client) return null;
			return write(client, { ...data, type, time: Date.now() });
		},

		// Drains a client's backlog and returns it — the `/api/ping` half of the pair. Empty means the
		// client is current, which is the common case and costs nothing.
		drain(sessionId) {
			const client = clients.get(sessionId);
			if (!client) return null;
			const log = client.log;
			client.log = [];
			return log;
		},

		// What the client needs to answer "am I behind?": the highest seq issued, and its own backlog.
		state(sessionId) {
			const client = clients.get(sessionId);
			return { seq, pending: client ? client.log.length : null };
		},

		get size() { return clients.size; },
		get seq() { return seq; },

		close() {
			// Cleared *before* the streams are ended, so the 'close' handler each end() fires finds
			// nothing to remove and stays quiet. Ending them first would log a "dropped client" warning
			// for every client on an intentional shutdown — a warning that means "this went away
			// unexpectedly" would be printed for the one case that is expected.
			const open = [...clients.values()];
			clients.clear();
			for (const client of open) {
				try { client.res.end(); } catch { /* already gone; nothing to close */ }
			}
		}
	};
}

// The server uses a singleton — one process, one hub — while tests build their own so they never
// share state with a running server.
const feed = createFeed();

module.exports = { createFeed, feed, BACKLOG_LIMIT };
