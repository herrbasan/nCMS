'use strict';

// Media: the shared pool, buckets, asset records, and the nMedia job driver.
//
// Division of labour (plan §6): **nMedia computes; nCMS orchestrates.** nMedia is a remote service whose
// own asset store is a *cache* — it expires (measured: `cacheTtl` 3600s) — so it can never be the pool of
// record. The CMS owns the originals, the generated variants, the job bookkeeping and the reporting.
//
// Physical storage (see the brief's D7): bytes live on the filesystem under one root, and the *index* —
// asset records and buckets — lives in two local nDB databases. That split is deliberate: the pool needs a
// stable id per asset, many variants per asset under predictable names, and one root outside every
// collection, none of which nDB buckets offer (they are per-database, hash-named, one blob per hash). It
// also keeps the variant bytes out of nDB's refcounted GC entirely, so a failed write can never take a
// working variant with it.
//
// Nothing here starts, stops or restarts nMedia. If it is unreachable or its processors are down, that is
// recorded on the job and surfaced — never worked around.

const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('../modules/nDB/napi/index.js');
const { HttpError } = require('./http-error.js');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const MEDIA_ROOT = path.join(DATA_ROOT, 'media');
const POOL_ROOT = path.join(MEDIA_ROOT, 'pool');
const BUCKET_DB = path.join(MEDIA_ROOT, 'buckets', 'data.jsonl');
const ASSET_DB = path.join(MEDIA_ROOT, 'assets', 'data.jsonl');

const NMEDIA = process.env.NMEDIA_URL || 'http://192.168.0.100:3500';
const POLL_MS = Number(process.env.NMEDIA_POLL_MS || 1500);
const MAX_UPLOAD_BYTES = Number(process.env.NCMS_MAX_UPLOAD_BYTES || 64 * 1024 * 1024);

// The variant menu is the output contract (plan §6, invariant #2). nMedia takes *one* output per job, so a
// menu is N jobs against one upload — `markUploadProcessed` extends an upload's lifetime rather than
// consuming it, which is what makes that work.
const QUALITY = 82;
const IMAGE_VARIANTS = [
	['big_avif', 'avif', 3840], ['medium_avif', 'avif', 1920], ['thumb_avif', 'avif', 1024],
	['big_webp', 'webp', 3840], ['medium_webp', 'webp', 1920], ['thumb_webp', 'webp', 1024],
	['big_jpg', 'jpeg', 3840], ['medium_jpg', 'jpeg', 1920], ['thumb_jpg', 'jpeg', 1024],
	['thumb_cms', 'jpeg', 128]
].map(([name, format, maxDimension]) => ({
	name,
	format,
	maxDimension,
	extension: format === 'jpeg' ? 'jpg' : format
}));

const databases = new Map();
function open(file) {
	let db = databases.get(file);
	if (!db) {
		db = Database.open(file, { persistence: 'immediate' });
		databases.set(file, db);
	}
	return db;
}

const bucketDb = () => open(BUCKET_DB);
const assetDb = () => open(ASSET_DB);
const variantDir = (assetId) => path.join(POOL_ROOT, assetId);

// ─── Media references ──────────────────────────────────────────────────────────────────────────
// The reference an author writes is `media/<assetId>/<filename>`, and it resolves by the **asset id** —
// the first segment after `media/`. The filename is carried for legibility and is not identity, which is
// what lets a reference survive a rename and what makes moving an asset between buckets a change to
// organization only: the reference never named the bucket.

const REFERENCE_RE = /^media\/([A-Za-z0-9_-]+)\/(.*)$/;

function referenceOf(asset) {
	return `media/${asset._id}/${asset.filename}`;
}

function parseReference(text) {
	const match = REFERENCE_RE.exec(String(text));
	return match ? { assetId: match[1], filename: match[2] } : null;
}

// ─── Buckets ───────────────────────────────────────────────────────────────────────────────────
// A bucket is a label on an asset, never a directory (D7). Creating, renaming or removing one moves no
// bytes and changes no reference.

function listBuckets() {
	return bucketDb().iter().sort((a, b) => a.name.localeCompare(b.name));
}

function createBucket(input) {
	const name = typeof input?.name === 'string' ? input.name.trim() : '';
	if (!name) throw new HttpError(400, 'invalid_name', 'A bucket needs a non-empty name.', input?.name);
	if (listBuckets().some((bucket) => bucket.name.toLowerCase() === name.toLowerCase())) {
		throw new HttpError(409, 'bucket_exists', `A bucket named "${name}" already exists.`, { name });
	}
	const db = bucketDb();
	const _id = db.insert({ name, c_date: Date.now() });
	db.flush();
	return { _id, name };
}

function renameBucket(id, input) {
	const db = bucketDb();
	if (!db.contains(id)) throw new HttpError(404, 'unknown_bucket', `No bucket "${id}".`);
	const name = typeof input?.name === 'string' ? input.name.trim() : '';
	if (!name) throw new HttpError(400, 'invalid_name', 'A bucket needs a non-empty name.', input?.name);
	const next = { ...db.get(id), name, m_date: Date.now() };
	db.update(id, next);
	db.flush();
	return next;
}

// Reversible, like every other deletion here: the declaration is tombstoned and nothing else changes. The
// assets keep pointing at a bucket id that is simply no longer listed, so restoring brings them back with
// their organization intact. Purging is a separate act and is not wired up.
function deleteBucket(id) {
	const db = bucketDb();
	if (!db.contains(id)) throw new HttpError(404, 'unknown_bucket', `No bucket "${id}".`);
	db.delete(id);
	db.flush();
	return { _id: id };
}

// ─── Assets ───────────────────────────────────────────────────────────────────────────────────

const imageExtension = (variant) => variant.extension;

function kindOfExtension(extension) {
	const ext = String(extension).toLowerCase();
	if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tiff', 'tif', 'bmp', 'heic', 'heif'].includes(ext)) return 'image';
	if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'].includes(ext)) return 'audio';
	if (['mp4', 'webm', 'mkv', 'mov'].includes(ext)) return 'video';
	return null;
}

const variantsFor = (kind) => (kind === 'image' ? IMAGE_VARIANTS : []);

function listAssets(bucketId) {
	const assets = assetDb().iter();
	const scoped = bucketId ? assets.filter((asset) => asset.bucket === bucketId) : assets;
	return scoped.map((asset) => ({ ...asset, reference: referenceOf(asset) }));
}

function getAsset(id) {
	const db = assetDb();
	if (!db.contains(id)) throw new HttpError(404, 'unknown_asset', `No media asset "${id}".`);
	const asset = db.get(id);
	return { ...asset, reference: referenceOf(asset) };
}

function writeAsset(asset) {
	const db = assetDb();
	db.update(asset._id, asset);
	db.flush();
	// Every write returns the enriched shape, so no caller has to remember to re-read it to get the
	// reference. A bare nDB record would silently lack one.
	return getAsset(asset._id);
}

function updateAsset(id, change) {
	const db = assetDb();
	if (!db.contains(id)) throw new HttpError(404, 'unknown_asset', `No media asset "${id}".`);
	return writeAsset({ ...db.get(id), ...change, m_date: Date.now() });
}

// Deletion is a tombstone on the record — the bytes stay exactly where they are, so a restore is a
// single call and a purge is a separate, deliberate act.
function deleteAsset(id) {
	const db = assetDb();
	if (!db.contains(id)) throw new HttpError(404, 'unknown_asset', `No media asset "${id}".`);
	db.delete(id);
	db.flush();
	return { _id: id };
}

function restoreAsset(id) {
	const db = assetDb();
	db.restore(id);
	db.flush();
	return getAsset(id);
}

// Moving an asset between buckets is an edit to a label: no bytes move, the id is unchanged, and every
// reference stays valid because a reference names the asset, not the bucket.
function moveAsset(id, bucketId) {
	if (bucketId !== null && !bucketDb().contains(bucketId)) {
		throw new HttpError(404, 'unknown_bucket', `No bucket "${bucketId}".`);
	}
	return updateAsset(id, { bucket: bucketId });
}

// ─── The pool ─────────────────────────────────────────────────────────────────────────────────

function storeOriginal(assetId, extension, buffer) {
	const dir = variantDir(assetId);
	fs.mkdirSync(dir, { recursive: true });
	const file = `original.${extension}`;
	fs.writeFileSync(path.join(dir, file), buffer);
	return { file, size: buffer.length };
}

// A variant is written beside its target and renamed over it, so a failure part-way leaves the working
// variant exactly where it was. Reprocessing therefore never discards a version that works.
function storeVariant(assetId, variant) {
	const dir = variantDir(assetId);
	fs.mkdirSync(dir, { recursive: true });
	const file = `${variant.name}.${imageExtension(variant)}`;
	const target = path.join(dir, file);
	const staging = `${target}.staging`;
	try {
		fs.writeFileSync(staging, variant.buffer);
		fs.renameSync(staging, target);
	} catch (error) {
		fs.rmSync(staging, { force: true });
		throw error;
	}
	return { file, size: variant.buffer.length };
}

// Serves a file out of an asset's folder, resolving by asset id. This is what previews and any renderer
// use; the authoring reference stays `media/<assetId>/<filename>` and needs no bucket or database access.
function assetFile(assetId, name) {
	const asset = getAsset(assetId);
	// `name` is a variant name (`thumb_cms`), a literal filename, or `original`. A variant name is the
	// case previews and the admin use, so it resolves through the record rather than by guessing a path.
	const wanted = name === 'original' || !name
		? asset.original.file
		: (asset.variants?.[name]?.file ?? name);
	const dir = variantDir(assetId);
	const file = path.resolve(dir, wanted);
	if (!file.startsWith(dir + path.sep)) {
		throw new HttpError(403, 'path_outside_asset', `Refusing to serve ${name}.`);
	}
	if (!fs.existsSync(file)) throw new HttpError(404, 'no_such_variant', `No "${name}" for asset ${assetId}.`);
	return file;
}

// ─── nMedia, as a client ──────────────────────────────────────────────────────────────────────

async function nmedia(method, route, body, headers) {
	const response = await fetch(NMEDIA + route, { method, body, headers });
	if (!response.ok) {
		throw new Error(`nMedia ${method} ${route} → ${response.status} ${(await response.text()).slice(0, 200)}`);
	}
	return response;
}

async function nmediaHealth() {
	try {
		return await (await fetch(`${NMEDIA}/health`)).json();
	} catch (error) {
		return { status: 'unreachable', error: error.message };
	}
}

// One upload feeds every variant: nMedia keeps the upload alive once it has been used for processing, so
// the menu costs one upload and N jobs, not N uploads.
async function submitOriginal(buffer, filename, mime) {
	const response = await nmedia('POST', '/v1/upload', buffer, {
		'content-type': 'application/octet-stream',
		'content-length': String(buffer.length),
		'x-original-filename': filename
	});
	return (await response.json()).fileId;
}

async function submitJob(fileId, variant) {
	const response = await nmedia('POST', '/v1/process', JSON.stringify({
		fileId,
		processor: 'image',
		options: { max_dimension: variant.maxDimension, quality: QUALITY, format: variant.format }
	}), { 'content-type': 'application/json' });
	return (await response.json()).jobId;
}

// ─── Upload and the job driver ────────────────────────────────────────────────────────────────

/**
 * Stores one original and queues the whole variant menu for it. Returns as soon as the jobs are queued —
 * the plan's contract is that upload returns a job, and no request waits on processing.
 */
async function upload({ bucket, filename, extension, mime, buffer }) {
	const kind = kindOfExtension(extension);
	if (!kind) {
		throw new HttpError(415, 'unsupported_type', `No processor handles ".${extension}".`, { extension });
	}
	if (kind !== 'image') {
		// Surfaced rather than worked around: audio and video have no variant menu in the plan yet, and
		// nMedia's own processors may be down. The asset is still stored, so the upload is not lost.
		throw new HttpError(415, 'unsupported_kind',
			`"${kind}" media is not processed yet — only images have a variant menu.`, { kind });
	}
	if (bucket !== null && !bucketDb().contains(bucket)) {
		throw new HttpError(404, 'unknown_bucket', `No bucket "${bucket}".`);
	}

	const assets = assetDb();
	const id = assets.insert({
		bucket: bucket ?? null,
		filename,
		extension,
		mime,
		kind,
		c_date: Date.now()
	});
	const original = storeOriginal(id, extension, buffer);
	const variants = variantsFor(kind);

	let fileId;
	try {
		fileId = await submitOriginal(buffer, filename, mime);
	} catch (error) {
		// The original is stored, so nothing is lost and the failure is recorded against every variant
		// rather than hidden. The operator can retry once nMedia is back.
		writeAsset({
			...assets.get(id),
			original,
			variants: {},
			jobs: Object.fromEntries(variants.map((v) => [v.name, { status: 'failed', error: error.message, c_date: Date.now() }])),
			processing: { fileId: null, error: error.message }
		});
		return getAsset(id);
	}

	const jobs = {};
	for (const variant of variants) {
		try {
			jobs[variant.name] = { jobId: await submitJob(fileId, variant), status: 'queued', c_date: Date.now() };
		} catch (error) {
			jobs[variant.name] = { status: 'failed', error: error.message, c_date: Date.now() };
		}
	}

	writeAsset({ ...assets.get(id), original, variants: {}, jobs, processing: { fileId, error: null } });
	return getAsset(id);
}

// Re-queues the menu for an asset. The original is re-uploaded rather than trusting nMedia's cached copy:
// that cache expires, and a reprocess that silently depended on it would fail for no visible reason.
async function reprocess(id) {
	const asset = getAsset(id);
	const variants = variantsFor(asset.kind);
	const buffer = fs.readFileSync(path.join(variantDir(id), asset.original.file));

	let fileId;
	try {
		fileId = await submitOriginal(buffer, asset.filename, asset.mime);
	} catch (error) {
		// Recorded per variant instead of thrown away: a retry that fails must say so and say why, and the
		// variants that already work are untouched either way. Same shape as a failed first upload.
		const failed = Object.fromEntries(variants.map((variant) => [variant.name, {
			...(asset.jobs?.[variant.name] ?? {}), status: 'failed', error: error.message, m_date: Date.now()
		}]));
		return updateAsset(id, {
			jobs: { ...asset.jobs, ...failed },
			processing: { fileId: null, error: error.message }
		});
	}

	const jobs = {};
	for (const variant of variants) {
		try {
			jobs[variant.name] = { jobId: await submitJob(fileId, variant), status: 'queued', c_date: Date.now() };
		} catch (error) {
			jobs[variant.name] = { status: 'failed', error: error.message, c_date: Date.now() };
		}
	}
	// Existing variants are left in `variants` untouched: they keep working until a replacement has been
	// written, and only then does the new file take their place.
	return updateAsset(id, { jobs: { ...asset.jobs, ...jobs }, processing: { fileId, error: null } });
}

const byVariantName = (name) => variantsFor('image').find((variant) => variant.name === name);

/** One pass of the job driver: advance every queued/processing job, one step each. */
async function advanceJobs() {
	const active = assetDb().iter().filter((asset) => Object.values(asset.jobs ?? {})
		.some((job) => job.status === 'queued' || job.status === 'processing'));
	if (!active.length) return 0;

	let advanced = 0;
	for (const asset of active) {
		let next = { ...asset };
		for (const [name, job] of Object.entries(asset.jobs ?? {})) {
			if (job.status !== 'queued' && job.status !== 'processing') continue;
			try {
				const status = await (await nmedia('GET', `/v1/jobs/${job.jobId}`)).json();
				advanced++;
				if (status.status === 'completed') {
					const bytes = Buffer.from(await (await nmedia('GET', `/v1/assets/${status.assetId}`)).arrayBuffer());
					const stored = storeVariant(asset._id, { ...byVariantName(name), buffer: bytes });
					next.variants = { ...next.variants, [name]: { ...stored, c_date: Date.now() } };
					next.jobs = { ...next.jobs, [name]: { ...job, status: 'completed', assetId: status.assetId, progress: 100, m_date: Date.now() } };
				} else if (status.status === 'failed' || status.status === 'cancelled') {
					// Kept and surfaced: a failed variant is reported with the processor's own message and
					// is retryable, and any earlier working variant is still in place.
					next.jobs = { ...next.jobs, [name]: { ...job, status: status.status, error: status.error ?? 'processing failed', m_date: Date.now() } };
				} else {
					next.jobs = { ...next.jobs, [name]: { ...job, status: status.status, progress: status.progress ?? job.progress ?? 0, m_date: Date.now() } };
				}
			} catch (error) {
				next.jobs = { ...next.jobs, [name]: { ...job, status: 'failed', error: error.message, m_date: Date.now() } };
			}
		}
		writeAsset(next);
	}
	return advanced;
}

let timer = null;
function startJobDriver() {
	if (timer) return;
	timer = setInterval(() => {
		advanceJobs().catch((error) => console.error('[nCMS] media job driver:', error.message));
	}, POLL_MS);
	timer.unref?.();
}

module.exports = {
	NMEDIA,
	MAX_UPLOAD_BYTES,
	IMAGE_VARIANTS,
	referenceOf,
	parseReference,
	listBuckets,
	createBucket,
	renameBucket,
	deleteBucket,
	listAssets,
	getAsset,
	deleteAsset,
	restoreAsset,
	moveAsset,
	assetFile,
	variantDir,
	upload,
	reprocess,
	advanceJobs,
	startJobDriver,
	nmediaHealth,
	kindOfExtension
};
