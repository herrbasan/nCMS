'use strict';

// The request log — the server's own record of what was asked of it.
//
// The old CMS has one, and it is the reason its log screen exists: `funnel()` builds a `log_entry` for
// **every** request before the handler runs, `sendSuccess`/`sendError` set its `status`, and `put_log`
// broadcasts it. So its Live Log is a *request log*, not a change feed — reads included, failures included.
// That is a different thing from what our feed carries, and conflating them is why the log had no home here:
//
//   the feed    changes, so a second client's view stays correct. Reads stay off it — a broadcast of
//               "someone looked" is noise, and it is what makes the feed worth subscribing to.
//   this log    every request, for an audit trail and a log screen. Nothing subscribes to it live; a screen
//               reads it with a cursor, which is what a log is for.
//
// The old CMS kept 100 entries and flushed all but the last 50 to `storage/logs/<date>.log` when idle. The
// ring buffer is kept; the disk flush is not built yet, and is deliberately not faked here.
//
// ── What is NOT logged, and why it matters ───────────────────────────────────────────────────
//
// Two kinds of traffic are excluded, and both are exclusions the original makes for the same reason — it kept
// its admin and its asset bytes out of its own log rather than drowning in them.
//
//   **The static roots.** The old CMS served `/admin` and its library with `express.static` *outside* its
//   `funnel()` wrapper, so a page load's several dozen asset requests never reached its log. Ours go through
//   the same handler as everything else, so the exclusion is explicit here.
//
//   **The asset bytes.** `GET /api/media/:id/file/:name` is fetched once per thumbnail, which is exactly the
//   case the original excludes by name (`sendImage`) and for exactly this reason: it would bury everything
//   else. A log that lists ten `file/medium_webp` lines for one list render is not a log.
//
// Both are decided by the caller (`quiet`), because only the caller knows its own routes. The three
// high-frequency internal routes are excluded by default, and `/api/log` above all: without it the screen's own
// polling becomes the loudest thing in the log it is displaying.

const DEFAULT_LIMIT = 200;

// The routes that are plumbing rather than activity: the feed, its catch-up half, and this log's own cursor
// reads. Matched on the pathname only, because they have no parameters.
const QUIET = ['/api/events', '/api/ping', '/api/log'];

function createLog({ limit = DEFAULT_LIMIT, quiet = (entry) => QUIET.includes(entry.pathname) } = {}) {
	const entries = []; // oldest first, so the cap drops from the front
	let seq = 0;

	return {
		record(entry) {
			if (quiet(entry)) return null;
			const record = { ...entry, seq: ++seq, timestamp: Date.now() };
			delete record.pathname; // the shape is what identifies a route; the raw path is not kept
			entries.push(record);
			// One in, one out. The cap is the point: this is a rolling window, not a store, and an unbounded
			// log in a process that never restarts is a leak with a friendly name.
			while (entries.length > limit) entries.shift();
			return record;
		},

		// Entries after a cursor. The current seq comes back **even when nothing matched**, so a caller that
		// fell behind the cap still advances its cursor instead of asking for a range that will never exist.
		since(after = 0, count = limit) {
			const fresh = entries.filter((entry) => entry.seq > after);
			return {
				entries: count >= fresh.length ? fresh : fresh.slice(-count),
				seq,
				// A gap means entries were dropped by the cap before this cursor could read them. The screen
				// says so rather than presenting a log with an invisible hole in it.
				gap: fresh.length > 0 && fresh[0].seq > after + 1
			};
		},

		get seq() { return seq; },
		get size() { return entries.length; },
		clear() { entries.length = 0; }
	};
}

module.exports = { createLog, QUIET, DEFAULT_LIMIT };
