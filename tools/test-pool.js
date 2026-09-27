'use strict';

// Proves the pool integrity report, and above all that the sweep cannot destroy a tombstone's bytes.
//
//   NCMS_DATA_ROOT=<throwaway> node tools/test-pool.js
//
// It builds its own data root, so it is not a second writer on the live one and needs no server stopped. The
// assertions are ordered so that the destructive step happens only after the thing it must not destroy has been
// proved to be present — the risk here is not a crash, it is a sweep that quietly reclaims the bytes a restore
// was counting on.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.NCMS_DATA_ROOT) {
	process.env.NCMS_DATA_ROOT = path.join(os.tmpdir(), `ncms-pool-${Date.now()}`);
}
const media = require('../lib/media.js');

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

const POOL = path.join(process.env.NCMS_DATA_ROOT, 'media', 'pool');
const original = (id) => path.join(POOL, id, 'original.png');

async function main() {
	// A real asset, so the report has a legitimate entry to *not* complain about.
	const bucket = media.createBucket({ name: 'Pool test' });
	const reserved = media.reserve({ bucket: bucket._id, filename: 'real.png', size: 4 });
	const staging = path.join(os.tmpdir(), `ncms-pool-${Date.now()}.png`);
	// A one-pixel PNG is overkill; the pool never parses the bytes, and nMedia is unreachable here on purpose.
	fs.writeFileSync(staging, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const asset = await media.acceptBytes(reserved._id, { ticket: reserved.ticket, originalPath: staging, size: 4 });

	// ── The shapes the report has to tell apart ──────────────────────────────────────────────
	console.log('\nthe report');
	let report = media.integrity();
	check('a live asset with its bytes is not reported at all',
		report.missingBytes.length === 0 && report.noBucket.length === 0, JSON.stringify(report.counts));
	check('the counts describe the pool', report.counts.assets === 1 && report.counts.directories === 1,
		JSON.stringify(report.counts));
	check('nothing is unreferenced yet', report.unreferenced.length === 0);
	check('nothing is restorable yet', report.restorable.length === 0);
	check('the integrity read changed nothing on disk (it is a read)', fs.existsSync(original(asset._id)));

	// Bytes nothing ever claimed — the previous CMS's `unlinked`.
	const stray = path.join(POOL, 'StrayBytesNobodyOwns');
	fs.mkdirSync(stray, { recursive: true });
	fs.writeFileSync(path.join(stray, 'original.png'), Buffer.alloc(2048));
	report = media.integrity();
	check('bytes with no record at all are unreferenced', report.unreferenced.length === 1
		&& report.unreferenced[0]._id === 'StrayBytesNobodyOwns', JSON.stringify(report.unreferenced));
	check('and their size is measured, so the payoff is visible before acting',
		report.unreferenced[0].size === 2048, String(report.unreferenced[0].size));
	check('they are NOT listed as restorable', report.restorable.length === 0);

	// A record filed under a bucket that does not exist — the previous CMS's `no_bucket`.
	// Two cases, and they are not the same: a *tombstoned* bucket is the normal aftermath of deleting one (the
	// assets keep their label on purpose so a restore brings the organisation back), while an id nothing knows
	// about is genuinely broken. Reporting them together would put the design's intended state in the same list
	// as real damage, which is how a warning section gets ignored.
	const orphanBucket = media.createBucket({ name: 'Doomed' });
	const doomed = media.reserve({ bucket: orphanBucket._id, filename: 'orphan.png', size: 4 });
	const staging2 = path.join(os.tmpdir(), `ncms-pool-2-${Date.now()}.png`);
	fs.writeFileSync(staging2, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await media.acceptBytes(doomed._id, { ticket: doomed.ticket, originalPath: staging2, size: 4 });
	media.deleteBucket(orphanBucket._id);
	report = media.integrity();
	check('a live record under a *deleted* bucket is reported as expected, not broken',
		report.deletedBucket.length === 1 && report.deletedBucket[0]._id === doomed._id
		&& report.noBucket.length === 0,
		JSON.stringify({ deletedBucket: report.deletedBucket.map((r) => r._id), noBucket: report.noBucket.map((r) => r._id) }));
	check('its bytes are NOT unreferenced — the record still claims them',
		!report.unreferenced.some((item) => item._id === doomed._id));

	// An asset filed nowhere (`bucket: null`) is a legal place to be, not a finding — and a reservation whose
	// bytes are still on their way is not "missing bytes" either. Both are asserted here because both are ways
	// the report could cry wolf on a state that is completely normal.
	const nowhere = media.reserve({ bucket: bucket._id, filename: 'nowhere.png', size: 4 });
	media.editAsset(nowhere._id, { bucket: null });
	report = media.integrity();
	check('an asset filed nowhere is legal and reported in neither bucket list',
		!report.noBucket.some((r) => r._id === nowhere._id)
		&& !report.deletedBucket.some((r) => r._id === nowhere._id),
		JSON.stringify({ noBucket: report.noBucket.length, deletedBucket: report.deletedBucket.length }));
	check('a reservation still awaiting its bytes is NOT reported as missing them',
		!report.missingBytes.some((r) => r._id === nowhere._id),
		JSON.stringify(report.missingBytes.map((r) => r._id)));

	// There is deliberately no way to reach `noBucket` through the public API: `reserve` and `editAsset` both
	// refuse a bucket id that does not exist. So the genuinely-broken case can only come from data written
	// another way, and the report still names it rather than assuming it cannot happen.

	// A live record whose bytes are gone.
	fs.rmSync(path.dirname(original(doomed._id)), { recursive: true, force: true });
	report = media.integrity();
	check('a live record with no bytes is reported separately from an unreferenced directory',
		report.missingBytes.length === 1 && report.missingBytes[0]._id === doomed._id,
		JSON.stringify(report.missingBytes));

	// ── The distinction the sweep must respect ───────────────────────────────────────────────
	// A tombstone keeps its bytes so a restore can find them. That is what makes it a tombstone rather than a
	// delete — so a sweep that treats "no live record" as "unreferenced" would destroy the one thing the design
	// preserves, and it would look like housekeeping while doing it.
	console.log('\nthe sweep must not touch a tombstone');
	const restorable = media.reserve({ bucket: bucket._id, filename: 'deleted-later.png', size: 4 });
	const staging3 = path.join(os.tmpdir(), `ncms-pool-3-${Date.now()}.png`);
	fs.writeFileSync(staging3, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await media.acceptBytes(restorable._id, { ticket: restorable.ticket, originalPath: staging3, size: 4 });
	const bytesBefore = fs.readFileSync(original(restorable._id));
	media.deleteAsset(restorable._id);

	report = media.integrity();
	check('deleting a record moves its bytes to `restorable`, not `unreferenced`',
		report.restorable.some((item) => item._id === restorable._id)
		&& !report.unreferenced.some((item) => item._id === restorable._id),
		JSON.stringify({ restorable: report.restorable.map((r) => r._id), unreferenced: report.unreferenced.map((r) => r._id) }));

	const swept = media.sweepPool();
	check('the sweep removes the unreferenced directory', swept.removed.includes('StrayBytesNobodyOwns'),
		JSON.stringify(swept.removed));
	check('and reports the bytes it reclaimed', swept.bytes === 2048, String(swept.bytes));
	check('the stray directory is gone', !fs.existsSync(stray));

	check('**the tombstoned asset still has its bytes**', fs.existsSync(original(restorable._id)),
		`expected ${original(restorable._id)} to exist`);
	check('and they are byte-for-byte what was stored',
		fs.readFileSync(original(restorable._id)).equals(bytesBefore));
	check('so a restore still works', media.restoreAsset(restorable._id)?._id === restorable._id);

	// ── After the sweep ─────────────────────────────────────────────────────────────────────
	console.log('\nafter the sweep');
	report = media.integrity();
	check('the unreferenced list is empty', report.unreferenced.length === 0, JSON.stringify(report.unreferenced));
	check('the live asset is untouched', fs.existsSync(original(asset._id)));
	check('a sweep with nothing to do is a no-op', media.sweepPool().removed.length === 0);
	// Four live records by now: the real asset, the one under a deleted bucket, the one that was deleted and
	// restored, and the one filed nowhere. One bucket, because `Doomed` was deleted.
	check('the counts still describe reality after a sweep and a restore',
		report.counts.assets === 4 && report.counts.buckets === 1, JSON.stringify(report.counts));

	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) console.log(failures.map((label) => `  - ${label}`).join('\n'));
	fs.rmSync(process.env.NCMS_DATA_ROOT, { recursive: true, force: true });
	process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	fs.rmSync(process.env.NCMS_DATA_ROOT, { recursive: true, force: true });
	process.exit(1);
});
