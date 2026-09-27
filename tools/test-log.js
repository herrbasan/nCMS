'use strict';

// Proves the request log: the ring buffer, the cursor, and the gap.
//
//   node tools/test-log.js
//
// The interesting assertions are the last three. A log's failure mode is not a crash — it is a *quietly
// incomplete* record, and the two ways that happens are the cap dropping entries a reader never saw, and a
// cursor that never advances because a query returned nothing. Both are asserted here rather than reasoned
// about, because neither is visible from the outside.

const { createLog, QUIET } = require('../lib/log.js');

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

const entry = (overrides = {}) => ({
	pathname: '/api/collections',
	method: 'GET',
	url: '/api/collections',
	action: 'GET /api/collections',
	status: true,
	ms: 1,
	...overrides
});

// ── Recording ────────────────────────────────────────────────────────────────────────────────
console.log('\nrecording');
const log = createLog();
const first = log.record(entry());
check('record returns the stored entry', first?.seq === 1 && first.status === true, JSON.stringify(first));
check('it is timestamped', typeof first.timestamp === 'number' && first.timestamp > 0);
check('the raw pathname is NOT kept — the shape is the identity', first.pathname === undefined,
	JSON.stringify(Object.keys(first)));
check('the action survives', first.action === 'GET /api/collections');
check('the size grows', log.size === 1);

// ── The quiet routes ────────────────────────────────────────────────────────────────────────
// The default excludes the feed, its catch-up half and this log's own cursor reads. The last one is the one
// that matters most: without it the screen's own polling becomes the loudest thing in the log it displays.
console.log('\nquiet by default');
for (const pathname of QUIET) {
	check(`a ${pathname} request is not recorded`, log.record(entry({ pathname })) === null);
}
check('and none of them consumed a seq', log.record(entry()).seq === 2, 'seq drifted');
check('the log is only as big as the entries that were kept', log.size === 2, String(log.size));

// Only the caller knows its own routes, so the caller supplies the rule — here the static roots and the asset
// bytes, which is exactly what `server.js` passes.
console.log('\nquiet by rule');
const filtered = createLog({
	quiet: (e) => QUIET.includes(e.pathname) || e.pathname.startsWith('/admin/') || e.pathname.startsWith('/nui/')
});
check('an /admin/ asset is skipped', filtered.record(entry({ pathname: '/admin/js/app.js' })) === null);
check('a /nui/ asset is skipped', filtered.record(entry({ pathname: '/nui/css/nui-theme.css' })) === null);
check('an API request is kept', filtered.record(entry())?.seq === 1);
check('and the skipped ones did not advance the seq', filtered.seq === 1, String(filtered.seq));

// ── The cursor ───────────────────────────────────────────────────────────────────────────────
console.log('\nthe cursor');
const page = log.since(0);
check('since(0) returns everything retained, oldest first',
	page.entries.length === 2 && page.entries[0].seq === 1 && page.entries[1].seq === 2);
check('it reports the current seq', page.seq === 2, String(page.seq));
check('nothing is dropped by an up-to-date cursor', log.since(2).entries.length === 0);
check('but the seq is STILL reported, so a caller advances instead of re-asking an empty range forever',
	log.since(2).seq === 2, JSON.stringify(log.since(2)));

log.record(entry());
check('a cursor collects only what is newer', log.since(2).entries.length === 1);
check('and the seq moves with it', log.since(3).seq === 3);

// ── The cap, and the gap ─────────────────────────────────────────────────────────────────────
// The cap is the reason a gap exists. It is asserted at a small limit so the test does not have to write 200
// entries to exercise it.
console.log('\nthe cap and the gap');
const small = createLog({ limit: 5 });
for (let i = 0; i < 20; i++) small.record(entry({ url: `/n${i}` }));
check('the buffer holds at most the limit', small.size === 5, String(small.size));
check('the oldest are the ones dropped', small.since(0).entries[0].seq === 16,
	String(small.since(0).entries[0].seq));

const behind = small.since(2);
check('a cursor older than the oldest retained entry is told there is a gap', behind.gap === true,
	JSON.stringify({ first: behind.entries[0]?.seq, gap: behind.gap }));
check('a contiguous cursor is not', small.since(15).gap === false,
	JSON.stringify({ first: small.since(15).entries[0]?.seq, gap: small.since(15).gap }));
check('a cursor at the head is not a gap', small.since(20).gap === false);
check('the gap is reported even when the entries come back empty for a fresh cursor',
	small.since(20).entries.length === 0 && small.since(20).gap === false);

// ── The limit on a read ──────────────────────────────────────────────────────────────────────
console.log('\nreading with a limit');
const wide = createLog({ limit: 50 });
for (let i = 0; i < 30; i++) wide.record(entry({ url: `/n${i}` }));
const capped = wide.since(0, 10);
check('a read is capped to the count it asked for', capped.entries.length === 10, String(capped.entries.length));
check('and it keeps the NEWEST of them, so a reader lands at the head rather than the tail',
	capped.entries[capped.entries.length - 1].seq === 30, String(capped.entries[capped.entries.length - 1].seq));
check('a read larger than the buffer returns everything there is', wide.since(0, 999).entries.length === 30);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((label) => `  - ${label}`).join('\n'));
process.exit(failures.length ? 1 : 0);
