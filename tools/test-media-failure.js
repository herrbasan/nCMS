'use strict';

// Fault injection for the media failure path. A healthy image job never fails, so the requirement that
// failures be **visible and retryable** cannot be exercised through the live service — this drives the
// module directly with nMedia made unreachable, then reachable again.
//
//   # needs its own data root, so it is not a second writer on the live one
//   NCMS_DATA_ROOT=<throwaway> node tools/test-media-failure.js
//
// It proves:
//   1. a failed upload stores the original and records a failure per variant, with the reason;
//   2. a retry attempted while nMedia is still down is recorded, not thrown away;
//   3. the same retry succeeds once nMedia is reachable, and every variant becomes usable;
//   4. deletion of the probe asset is reversible and touches no bytes.
//
// It cleans up after itself by deleting the asset it created.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Its own data root unless one is given. It used to require the server to be stopped because it was a second
// writer on the live root; with `NCMS_DATA_ROOT` that constraint is gone entirely.
if (!process.env.NCMS_DATA_ROOT) {
	process.env.NCMS_DATA_ROOT = path.join(os.tmpdir(), `ncms-failure-${Date.now()}`);
}
const media = require('../lib/media.js');

const SOURCE = path.join(__dirname, '..', 'docs', 'reference', 'n000b_cms', 'screenshots', '02-raw-database.png');
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  — ${detail}`}`);
	if (!ok) failures++;
}

async function main() {
	const buffer = fs.readFileSync(SOURCE);

	// 1. nMedia unreachable.
	globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 192.168.0.100:3500 (injected)'); };

	// The bytes go through the real two-act path: reserve, then hand the pool a file on disk, exactly as the
	// route does. `acceptBytes` takes a path because the pool *moves* the file rather than buffering it.
	const reservation = media.reserve({ bucket: null, filename: 'failure-probe.png', size: buffer.length });
	const staging = path.join(os.tmpdir(), `ncms-failure-probe-${Date.now()}.png`);
	fs.writeFileSync(staging, buffer);
	const asset = await media.acceptBytes(reservation._id, {
		ticket: reservation.ticket, originalPath: staging, size: buffer.length
	});

	const statuses = Object.values(asset.jobs).map((job) => job.status);
	check('every variant recorded a failure',
		statuses.length === 10 && statuses.every((status) => status === 'failed'), `${statuses.length} jobs: ${statuses[0]}`);
	check('the failure carries a reason',
		Object.values(asset.jobs).every((job) => typeof job.error === 'string' && job.error.length > 0),
		Object.values(asset.jobs)[0]?.error);
	check('no variant was written', Object.keys(asset.variants).length === 0);
	check('the original was preserved anyway', asset.original.size === buffer.length, `${asset.original.size}b`);

	// 2. A retry while it is still down.
	const stillDown = await media.reprocess(asset._id);
	check('a failed retry is recorded rather than thrown away',
		Object.values(stillDown.jobs).every((job) => job.status === 'failed'), stillDown.jobs.big_avif?.error);

	// 3. nMedia comes back — the same asset, retried.
	globalThis.fetch = realFetch;
	await media.reprocess(asset._id);
	for (let attempt = 0; attempt < 240; attempt++) {
		await media.advanceJobs();
		const now = media.getAsset(asset._id);
		if (Object.values(now.jobs).every((job) => !['queued', 'processing'].includes(job.status))) break;
		await sleep(1000);
	}
	const healed = media.getAsset(asset._id);
	const terminal = Object.values(healed.jobs).map((job) => job.status);
	check('the retry completed once nMedia was reachable',
		terminal.every((status) => status === 'completed'), `${terminal.filter((s) => s === 'completed').length}/10 completed`);
	check('and every variant is usable', Object.keys(healed.variants).length === 10,
		Object.keys(healed.variants).length);

	// 4. Reversible deletion — the record goes, the bytes stay.
	const folder = media.variantDir(asset._id);
	media.deleteAsset(asset._id);
	check('the probe asset is deleted from the listing',
		!media.listAssets(null).some((item) => item._id === asset._id));
	check('and its bytes are untouched, ready for a restore',
		fs.existsSync(path.join(folder, healed.original.file)));

	console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}  (probe asset ${asset._id}, now tombstoned)`);
	process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
	console.error(`\ntest-media-failure failed: ${error.stack ?? error.message}`);
	process.exitCode = 1;
});
