// The feed client: one stream, one ping loop, one watermark.
//
// Two channels carry the same messages (see lib/feed.js), so this module's whole job is to make that
// invisible — `onMessage` is called exactly once per change, whichever channel delivered it, and
// `onRecovery` is called when the client can tell it has missed something it cannot replay.
//
// The watermark is the mechanism. Every broadcast carries a `seq`; the client keeps the highest it has
// applied and drops anything at or below it. That is what makes it safe to apply both the live stream and
// a drained backlog. Without it, applying the replay would re-run every message the stream already
// delivered — which is precisely why the old CMS drained its backlog into a log and never acted on it
// (behaviour-inventory.md §3).
//
// The one thing the original cannot do is *notice* it is behind. Its backlog is capped at 50, so a client
// away long enough is missing messages that will never arrive — and rendering a partial replay is worse
// than reloading. A jump in `seq` is that signal, and `onRecovery` is the answer.

const PING_MS = 5000; // the original's cadence. It is also the worst-case delivery delay for a dropped stream.

export function connectFeed({ onMessage, onRecovery, path = '/api/events', pingMs = PING_MS } = {}) {
	let source = null;
	let session = null;
	let watermark = 0;
	let pingTimer = null;
	let closed = false;

	// Apply in arrival order and never twice. Returns whether anything was applied.
	function ingest(messages) {
		let applied = 0;
		for (const message of messages) {
			if (!message || typeof message !== 'object') continue;
			if (message.type === 'hello') continue; // the introduction is not a change
			// Unsequenced messages are addressed to this client alone and are delivered once, so there is
			// no position to compare them against — they are always applied. (Unused today; `hello` aside,
			// the server only broadcasts.)
			if (message.seq === undefined) {
				onMessage?.(message);
				applied++;
				continue;
			}
			if (message.seq <= watermark) continue; // already applied from the other channel
			if (message.seq > watermark + 1) {
				// A hole. The backlog may not contain it (that is what the cap means), so replaying the
				// rest would leave the view wrong in a way nothing later corrects. Reload instead, and
				// take the newest position so the recovery is not re-triggered by every message after it.
				watermark = message.seq;
				console.warn(`[nCMS] feed: gap — expected ${watermark}, got ${message.seq}; reloading.`);
				onRecovery?.(message);
			}
			watermark = message.seq;
			onMessage?.(message);
			applied++;
		}
		return applied;
	}

	// The catch-up half. Runs on a timer rather than on demand so a stream that dies *silently* — the case
	// a browser gives no event for — is covered by the same path as one that dies loudly.
	async function ping() {
		if (!session || closed) return;
		try {
			const response = await fetch('/api/ping', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ session })
			});
			const payload = await response.json();
			if (!payload?.status) return;
			if (Array.isArray(payload.data?.log)) ingest(payload.data.log);
		} catch {
			// The stream's own reconnect and the next tick cover this; a failed ping is not worth a banner.
		}
	}

	function open() {
		if (closed) return;
		source = new EventSource(path);

		source.onmessage = (event) => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch (error) {
				// One malformed frame must not kill the stream. Logged, never thrown.
				console.warn('[nCMS] feed: ignoring an unparsable frame.', error.message);
				return;
			}
			if (message.type === 'hello') {
				session = message.session;
				// The baseline, so the first real message is not mistaken for a gap. It is only a floor:
				// the watermark is never moved backwards, because a reconnect must not re-apply history.
				watermark = Math.max(watermark, message.atSeq ?? 0);
				clearInterval(pingTimer);
				pingTimer = setInterval(ping, pingMs);
				return;
			}
			ingest([message]);
		};

		source.onerror = () => {
			// EventSource reconnects on its own and the server sends `retry:`. Reconnecting means a new
			// session, so the old one is dropped — its backlog is not consulted again, and the next hello
			// re-baselines. No banner: a reconnect is normal, and the delay is bounded by `pingMs`.
			console.warn('[nCMS] feed: stream interrupted; reconnecting.');
			session = null;
			clearInterval(pingTimer);
			pingTimer = null;
		};
	}

	open();

	return {
		get connected() { return source?.readyState === EventSource.OPEN; },
		get watermark() { return watermark; },
		close() {
			closed = true;
			clearInterval(pingTimer);
			pingTimer = null;
			source?.close();
			source = null;
		}
	};
}
