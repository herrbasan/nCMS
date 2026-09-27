'use strict';

// One upload-to-processed-media path, end to end, in its own bucket. Real bytes to real nMedia.
//
//   node server.js            # in one terminal (nMedia runs elsewhere; this never starts it)
//   node tools/test-media.js
//
// What it proves:
//   1. an original uploads, is preserved, and is stored in the pool under a stable asset id;
//   2. the variant menu is queued automatically — one nMedia upload feeding one job per variant;
//   3. the jobs complete, their results are stored, and each variant is servable;
//   4. the authoring reference `media/<assetId>/<filename>` resolves;
//   5. reprocessing does **not** discard working variants before replacements succeed;
//   6. a targeted retry re-queues only the variants it names, and a bad name is refused before the
//      original is uploaded;
//   7. editing renames the label without moving bytes or clearing the bucket, and the extension — which
//      decides how the asset is processed — cannot change.
//
// Re-runnable. It creates assets; it never migrates or deletes existing content.

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.NCMS_API || 'http://localhost:3300/api';
const BUCKET_NAME = 'Media test';
const SOURCE = path.join(__dirname, '..', 'docs', 'reference', 'n000b_cms', 'screenshots',
	'17-editor-composed-columns.png');

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  — ${detail}`}`);
	if (!ok) failures++;
}
const show = (value) => JSON.stringify(value);

async function call(method, route, body, headers) {
	const response = await fetch(API + route, {
		method,
		headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body))
	});
	const type = response.headers.get('content-type') ?? '';
	if (!type.includes('json')) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), type };
	return { status: response.status, payload: await response.json() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(assetId, predicate, label, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		last = (await call('GET', `/media/${assetId}`)).payload.data;
		if (predicate(last)) return last;
		await sleep(1200);
	}
	check(label, false, `timed out; job statuses ${show(Object.fromEntries(
		Object.entries(last?.jobs ?? {}).map(([k, v]) => [k, v.status])))}`);
	return null;
}

const terminal = (asset) => Object.values(asset.jobs ?? {}).every((job) => !['queued', 'processing'].includes(job.status));

async function main() {
	const health = await call('GET', '/nmedia/health').catch(() => null);
	if (!health?.payload?.data) {
		console.error(`Cannot reach ${API}. Start the server first: node server.js`);
		process.exitCode = 1;
		return;
	}
	console.log(`nMedia at ${health.payload.data.url}: ${health.payload.data.nmedia.status} `
		+ `${show(health.payload.data.nmedia.processors ?? {})}\n`);

	// A bucket to file the uploads under. Buckets are labels, so this moves nothing.
	const buckets = (await call('GET', '/buckets')).payload.data;
	let bucket = buckets.find((b) => b.name === BUCKET_NAME);
	if (!bucket) {
		bucket = (await call('POST', '/buckets', { name: BUCKET_NAME })).payload.data;
		check('bucket created', typeof bucket?._id === 'string', show(bucket));
	} else {
		console.log(` ok   bucket "${BUCKET_NAME}" already exists`);
	}

	const bytes = fs.readFileSync(SOURCE);
	const filename = path.basename(SOURCE);
	console.log(`uploading ${filename} (${bytes.length} bytes)`);

	// ── Act one: reserve ────────────────────────────────────────────────────────────────────────
	// The record exists before any bytes move. That is the whole point of the split: the row the UI shows is
	// bound to a record, so it can appear (and report progress) while the upload is still in flight.
	const reserved = await call('POST', '/media', { filename, size: bytes.length, bucket: bucket._id });
	check('the upload is reserved before any bytes are sent',
		reserved.status === 200 && reserved.payload.status === true, show(reserved.payload));
	const reservation = reserved.payload.data;
	check('the record exists with no bytes yet',
		reservation?.original === null && typeof reservation?._id === 'string', show(reservation));
	check('the reservation carries a ticket',
		typeof reservation?.ticket === 'string' && reservation.ticket.length > 0, show(reservation?.ticket));
	check('the reservation names its bucket', reservation?.bucket === bucket._id, show(reservation?.bucket));
	check('the declared size is on the record before the bytes are',
		reservation?.size === bytes.length, show(reservation?.size));

	// The guards, exercised against a real reservation before it is used.
	const wrongTicket = await call('PUT', `/media/${reservation._id}/file`, bytes, { 'x-ticket': 'not-the-ticket' });
	check('bytes sent against the wrong ticket are refused',
		wrongTicket.status === 409 && wrongTicket.payload.error === 'bad_ticket', show(wrongTicket.payload));
	const noTicket = await call('PUT', `/media/${reservation._id}/file`, bytes, {});
	check('bytes sent with no ticket at all are refused',
		noTicket.status === 400 && noTicket.payload.error === 'ticket_required', show(noTicket.payload));
	const lockedDelete = await call('DELETE', `/media/${reservation._id}`);
	check('a record still receiving its upload cannot be deleted from under it',
		lockedDelete.status === 409 && lockedDelete.payload.error === 'locked', show(lockedDelete.payload));
	check('and it is still there afterwards',
		(await call('GET', `/media/${reservation._id}`)).status === 200);

	// ── Act two: the bytes ──────────────────────────────────────────────────────────────────────
	const uploaded = await call('PUT', `/media/${reservation._id}/file`, bytes, { 'x-ticket': reservation.ticket });
	check('the bytes are accepted against the ticket',
		uploaded.status === 200 && uploaded.payload.status === true, show(uploaded.payload));
	const asset = uploaded.payload.data;
	check('the asset has a stable id and a reference',
		typeof asset?._id === 'string' && asset.reference === `media/${asset._id}/${filename}`, show(asset?.reference));
	check('the original is preserved', asset?.original?.size === bytes.length, show(asset?.original));
	check('the ticket is cleared once the bytes land', asset?.ticket === null, show(asset?.ticket));
	check('the whole variant menu was queued',
		Object.keys(asset?.jobs ?? {}).length === 10, show(Object.keys(asset?.jobs ?? {})));

	// A reservation is exactly one upload. Sending bytes twice must not write over a finished asset's original.
	const secondSend = await call('PUT', `/media/${asset._id}/file`, bytes, { 'x-ticket': reservation.ticket });
	check('bytes sent again to a finished asset are refused',
		secondSend.status === 409 && secondSend.payload.error === 'not_awaiting_bytes', show(secondSend.payload));

	// A response that returned before any processing — the contract is that upload returns a job.
	const queued = Object.values(asset.jobs).filter((job) => job.status === 'queued').length;
	console.log(`     ${queued} job(s) queued; upload returned without waiting on nMedia\n`);

	const settled = await waitFor(asset._id, terminal, 'every job reached a terminal state');
	if (settled) {
		const statuses = Object.fromEntries(Object.entries(settled.jobs).map(([k, v]) => [k, v.status]));
		const failed = Object.entries(statuses).filter(([, s]) => s !== 'completed');
		check('every variant completed', failed.length === 0, show(failed.length ? failed : statuses));
		check('every completed variant has a stored file',
			Object.keys(settled.variants).length === 10, show(Object.keys(settled.variants)));

		// Each variant is servable, and is a real image rather than an error page.
		const thumb = await call('GET', `/media/${asset._id}/file/thumb_cms`);
		check('a variant is servable', thumb.status === 200 && thumb.buffer.length > 0,
			`${thumb.status} ${thumb.type} ${thumb.buffer?.length ?? 0}b`);
		const original = await call('GET', `/media/${asset._id}/file/original`);
		check('the original is servable', original.status === 200 && original.buffer.length === bytes.length,
			`${original.status} ${original.buffer?.length ?? 0}b`);

		// "Moving media between buckets changes organization, not asset identity or references."
		const moved = await call('PATCH', `/media/${asset._id}`, { bucket: null });
		check('moving to no bucket keeps the id and the reference',
			moved.payload.data._id === asset._id && moved.payload.data.reference === asset.reference,
			show(moved.payload.data?.reference));
		await call('PATCH', `/media/${asset._id}`, { bucket: bucket._id });

		// Editing. A rename moves the label, not the bytes and not the membership: the reference resolves by
		// asset id, so renaming cannot invalidate a reference already written into a document.
		const renamed = await call('PATCH', `/media/${asset._id}`, { filename: 'renamed-screenshot.png' });
		check('a rename keeps the id and the bucket, and changes only the label',
			renamed.payload.data?._id === asset._id
			&& renamed.payload.data?.bucket === bucket._id
			&& renamed.payload.data?.filename === 'renamed-screenshot.png'
			&& renamed.payload.data?.reference === `media/${asset._id}/renamed-screenshot.png`,
			show({ bucket: renamed.payload.data?.bucket, filename: renamed.payload.data?.filename }));
		const servedAfterRename = await call('GET', `/media/${asset._id}/file/original`);
		check('the bytes are still served under the same asset id',
			servedAfterRename.status === 200 && servedAfterRename.buffer.length === bytes.length,
			show(`${servedAfterRename.status} ${servedAfterRename.buffer?.length ?? 0}b`));

		const wrongExtension = await call('PATCH', `/media/${asset._id}`, { filename: 'renamed-screenshot.jpg' });
		check('changing the extension is refused',
			wrongExtension.status === 400 && wrongExtension.payload.error === 'extension_immutable',
			show(wrongExtension.payload));
		const pathSeparator = await call('PATCH', `/media/${asset._id}`, { filename: 'a/b.png' });
		check('a filename carrying a path separator is refused',
			pathSeparator.status === 400 && pathSeparator.payload.error === 'invalid_filename',
			show(pathSeparator.payload));
		const emptyPatch = await call('PATCH', `/media/${asset._id}`, {});
		check('a PATCH naming nothing is refused',
			emptyPatch.status === 400 && emptyPatch.payload.error === 'nothing_to_change',
			show(emptyPatch.payload));

		// Reprocessing must not discard what works. The check runs immediately after the call, while the
		// replacements are still queued — that is the window the requirement is about.
		const before = Object.keys(settled.variants);
		const requeued = await call('POST', `/media/${asset._id}/reprocess`);
		const during = Object.keys(requeued.payload.data?.variants ?? {});
		check('reprocessing keeps the working variants in place',
			before.every((name) => during.includes(name)), `${before.length} → ${during.length}`);

		const after = await waitFor(asset._id, terminal, 'the reprocess reached a terminal state');
		if (after) {
			check('and they are still there once it finishes',
				before.every((name) => Object.keys(after.variants).includes(name)),
				show(Object.keys(after.variants)));

			// A bad name is refused *before* the original is uploaded, so it cannot queue anything.
			const bogus = await call('POST', `/media/${asset._id}/reprocess`, { variants: ['nope'] });
			check('an unknown variant is refused rather than queued',
				bogus.status === 400 && bogus.payload.error === 'unknown_variant', show(bogus.payload));
			const none = await call('POST', `/media/${asset._id}/reprocess`, { variants: [] });
			check('an empty variant list is refused',
				none.status === 400 && none.payload.error === 'empty_variant_list', show(none.payload));

			// The point of a targeted retry: re-queue one variant without re-running the other nine. The
			// refusals above must also have left nothing queued — if either had, this would see more than one.
			const one = await call('POST', `/media/${asset._id}/reprocess`, { variants: ['thumb_cms'] });
			const statuses = Object.fromEntries(Object.entries(one.payload.data.jobs).map(([k, v]) => [k, v.status]));
			const requeued = Object.entries(statuses)
				.filter(([, status]) => status === 'queued' || status === 'processing').map(([name]) => name);
			check('a targeted retry re-queues only the variant it names',
				requeued.length === 1 && requeued[0] === 'thumb_cms', show(requeued));
			check('and leaves every other variant untouched',
				Object.entries(statuses).filter(([name]) => name !== 'thumb_cms').every(([, status]) => status === 'completed'),
				show(statuses));

			const retried = await waitFor(asset._id, terminal, 'the targeted retry reached a terminal state');
			if (retried) {
				check('the retried variant completed and the menu is whole',
					retried.jobs.thumb_cms.status === 'completed' && Object.keys(retried.variants).length === 10,
					show({ thumb_cms: retried.jobs.thumb_cms.status, variants: Object.keys(retried.variants).length }));
			}
		}
	}

	console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}  (asset ${asset?._id}, bucket "${BUCKET_NAME}")`);
	process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
	console.error(`\ntest-media failed: ${error.stack ?? error.message}`);
	process.exitCode = 1;
});
