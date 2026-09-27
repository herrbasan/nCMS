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
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Database } = require('../modules/nDB/napi/index.js');
const { HttpError } = require('./http-error.js');

// What the media layer *announces*, for whoever is listening. Deliberately an emitter and not a call into
// the feed: the job driver runs on a timer with no request behind it, and the one thing it knows is that an
// asset changed — not that anything is subscribed. `server.js` is what turns this into a broadcast.
//
// Only terminal job transitions are emitted. A pass that merely advances `progress` is not news: the row
// that is waiting does not move for it, and emitting every pass would put a message on the feed every poll
// interval for the whole duration of every upload.
const events = new EventEmitter();
events.setMaxListeners(0);

const DATA_ROOT = process.env.NCMS_DATA_ROOT
	? path.resolve(process.env.NCMS_DATA_ROOT)
	: path.join(__dirname, '..', 'data');
const MEDIA_ROOT = path.join(DATA_ROOT, 'media');
const POOL_ROOT = path.join(MEDIA_ROOT, 'pool');
// Where a body lands while it is being received. It is *moved* into the pool from here, never copied through
// memory: the two are on the same volume, so placing a 4 GiB original costs a rename.
const UPLOAD_TMP = path.join(MEDIA_ROOT, 'tmp');
const BUCKET_DB = path.join(MEDIA_ROOT, 'buckets', 'data.jsonl');
const ASSET_DB = path.join(MEDIA_ROOT, 'assets', 'data.jsonl');

const NMEDIA = process.env.NMEDIA_URL || 'http://192.168.0.100:3500';
const POLL_MS = Number(process.env.NMEDIA_POLL_MS || 1500);
// Generous by intent: the pool stores whole files, and a video belongs here as much as an image does. The
// bytes are streamed straight to disk, so this is a policy ceiling, not a memory one.
const MAX_UPLOAD_BYTES = Number(process.env.NCMS_MAX_UPLOAD_BYTES || 4 * 1024 ** 3);

// How long a reservation waits for its bytes. A ticket is live only while bytes could still reasonably be
// arriving.
//
// This exists because the guard has an obvious hole without it: a reservation whose upload was abandoned — the
// tab closed, the machine slept, the network died — would be **permanently undeletable**, locked by a
// capability nobody holds any more. The old CMS's ticket guard has that hole; it is closed here rather than
// reproduced, because the failure it produces is both permanent and visible to the user. 30 minutes is
// generous for a 4 GiB upload and short enough that a stale record cleans up on its own.
const TICKET_TTL_MS = Number(process.env.NCMS_TICKET_TTL_MS || 30 * 60 * 1000);
const ticketIsLive = (asset) => Boolean(asset.ticket) && Date.now() < (asset.ticket_expires ?? 0);

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
	// Anything else is a file the pool stores and serves: no processor, therefore no variant menu. The shape
	// rule is the one `nui-file-icon` enforces — letters, digits and "+".
	return /^[a-z0-9+]+$/.test(ext) ? 'file' : null;
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

	// A record whose bytes are still arriving cannot be removed from under its own upload — an in-flight write
	// would then finish into an asset that no longer exists, and the bytes would land with nothing pointing at
	// them. This is the old CMS's one real locked state (`deleteFile`'s ticket guard, index.js:978) and the only
	// place it uses the word; extending it to *editing* is open decision 4 in the events plan, not something to
	// assume here.
	//
	// The guard lasts only as long as the ticket does. An **expired** ticket locks nothing: its upload is never
	// coming, so the record is an ordinary empty asset and deleting it is how the mess gets cleaned up.
	if (ticketIsLive(db.get(id))) {
		throw new HttpError(409, 'locked', 'This asset is still receiving its upload.', { id });
	}

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

// Editing an asset's metadata. Only what the request names changes — a PATCH carrying a filename must not
// silently clear the bucket. `filename` is a **label**: the reference resolves by asset id, so renaming
// never invalidates a reference already written into a document, and the filename is only the last segment
// for legibility. The extension is not editable: it is what decides the asset's kind, and therefore its
// variant menu, so changing it would leave the record describing a menu it does not have.
function editAsset(id, change) {
	if (change === null || typeof change !== 'object' || Array.isArray(change)) {
		throw new HttpError(400, 'invalid_change', 'Expected an object naming filename and/or bucket.', change);
	}
	const asset = getAsset(id);
	const next = {};

	// The record carries derived fields (`original`, `variants`, `jobs`, ids, dates) that are written by the
	// upload and the job driver, never by hand. A raw edit that names one of them is refused rather than
	// silently ignored — otherwise the editor would look as if it had saved something it had not.
	const unknown = Object.keys(change).filter((field) => field !== 'filename' && field !== 'bucket');
	if (unknown.length) {
		throw new HttpError(400, 'field_not_editable',
			`Not editable by hand: ${unknown.join(', ')}. Only filename and bucket can be changed.`,
			{ fields: unknown });
	}

	if ('filename' in change) {
		const filename = typeof change.filename === 'string' ? change.filename.trim() : '';
		if (!filename) {
			throw new HttpError(400, 'invalid_filename', 'A media asset needs a non-empty filename.', change.filename);
		}
		if (/[/\\]/.test(filename)) {
			throw new HttpError(400, 'invalid_filename', 'A filename cannot contain a path separator.', filename);
		}
		const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
		if (extension !== String(asset.extension).toLowerCase()) {
			throw new HttpError(400, 'extension_immutable',
				`The extension decides how this asset is processed, so it cannot change (".${asset.extension}").`,
				{ extension });
		}
		next.filename = filename;
	}

	if ('bucket' in change) {
		const bucket = change.bucket ?? null;
		if (bucket !== null && !bucketDb().contains(bucket)) {
			throw new HttpError(404, 'unknown_bucket', `No bucket "${bucket}".`);
		}
		next.bucket = bucket;
	}

	if (!Object.keys(next).length) {
		throw new HttpError(400, 'nothing_to_change', 'Name filename and/or bucket.', change);
	}
	return updateAsset(id, next);
}

// ─── The pool ─────────────────────────────────────────────────────────────────────────────────

function storeOriginal(assetId, extension, source, size) {
	const dir = variantDir(assetId);
	fs.mkdirSync(dir, { recursive: true });
	const file = `original.${extension}`;
	fs.renameSync(source, path.join(dir, file));
	return { file, size };
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

// ─── The pool's integrity ─────────────────────────────────────────────────────────────────────
//
// The old CMS's `files_check` (`index.js:1305`) walks `storage/files`, reports bytes with no record
// (`unlinked`) and records whose bucket no longer exists (`no_bucket`), and **deletes** the unlinked bytes on
// the spot.
//
// Three things are done differently, and each has a reason rather than a preference:
//
//   * **The sweep is a separate act.** The check reports; nothing is removed until it is asked for. The
//     original deletes inside what reads like a read-only operation, which is a footgun on a maintenance
//     screen — the one place you go to look before you act.
//
//   * **A tombstone is not an orphan.** Deletion here is a tombstone whose whole purpose is to make a restore
//     possible, so "no live record" does not mean "unreferenced". nDB keeps `deletedIds()`, and bytes belonging
//     to a deleted record are reported separately as restorable and never swept. Without this distinction the
//     sweep would destroy exactly what the tombstone exists to preserve — a data-loss bug that looks like
//     housekeeping.
//
//   * **Removing a directory takes its variants with it.** Variants live inside the asset's own pool folder,
//     so one removal is complete. The original kept them in a separate `cache/<size>/` tree and had to call
//     `clearCache(id)` — which it called with `item._id` on an object that held `id`, so it cleared `undefined`
//     and shipped nothing. An asset-shaped folder makes the whole problem disappear.
function dirSize(dir) {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
	}
	return total;
}

/** Reports what is wrong with the pool. Reads only — nothing here changes anything. */
function integrity() {
	const assets = assetDb().iter();
	const live = new Set(assets.map((asset) => asset._id));
	const deleted = new Set(assetDb().deletedIds());
	const buckets = new Set(bucketDb().iter().map((bucket) => bucket._id));
	const deletedBuckets = new Set(bucketDb().deletedIds());

	const dirs = fs.existsSync(POOL_ROOT)
		? fs.readdirSync(POOL_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory())
		: [];

	const unreferenced = []; // bytes nothing claims at all — the only thing the sweep may remove
	const restorable = [];   // bytes a tombstone still claims — kept, or a restore would find nothing
	const missingBytes = []; // a live record whose bytes are gone
	const noBucket = [];     // a live record filed under a bucket id nothing knows about
	const deletedBucket = []; // a live record under a *tombstoned* bucket — the normal result of deleting one

	for (const dir of dirs) {
		if (live.has(dir.name)) continue;
		(deleted.has(dir.name) ? restorable : unreferenced).push({ _id: dir.name, size: dirSize(path.join(POOL_ROOT, dir.name)) });
	}

	for (const asset of assets) {
		const file = asset.original ? path.join(variantDir(asset._id), asset.original.file) : null;
		// A reservation whose bytes are still on their way is not missing anything. Without this the report would
		// flag every in-flight upload as damage — the loudest possible false positive, on the screen you open
		// when something is genuinely wrong.
		if ((!file || !fs.existsSync(file)) && !ticketIsLive(asset)) {
			missingBytes.push({
				_id: asset._id,
				filename: asset.filename,
				bucket: asset.bucket,
				// An abandoned reservation (its ticket expired with no bytes) is the usual way to arrive here, and
				// saying so turns "broken" into "clean this up".
				abandoned: Boolean(asset.ticket)
			});
		}

		// A null bucket is not missing — it means "filed nowhere", which is a legal place for an asset to be.
		if (asset.bucket === null) continue;

		// The same distinction the bytes get, for the same reason. Deleting a bucket here is a *tombstone* and
		// its assets keep pointing at it on purpose, so that restoring the bucket brings the organisation back
		// (see `deleteBucket`). That makes "filed under a bucket that is not listed" the **normal** outcome of a
		// deletion, not a fault — reporting it as one would flag the design's intended state and would train the
		// reader to ignore the section that also holds the genuine breakage.
		if (buckets.has(asset.bucket)) continue;
		(deletedBuckets.has(asset.bucket) ? deletedBucket : noBucket)
			.push({ _id: asset._id, filename: asset.filename, bucket: asset.bucket });
	}

	return {
		unreferenced,
		restorable,
		missingBytes,
		noBucket,
		deletedBucket,
		counts: { assets: assets.length, directories: dirs.length, buckets: buckets.size }
	};
}

/** Removes exactly what `integrity().unreferenced` reports — and nothing else. */
function sweepPool() {
	const { unreferenced } = integrity();
	const removed = [];
	let bytes = 0;
	for (const item of unreferenced) {
		fs.rmSync(variantDir(item._id), { recursive: true, force: true });
		removed.push(item._id);
		bytes += item.size;
	}
	return { removed, bytes };
}

// ─── nMedia, as a client ──────────────────────────────────────────────────────────────────────

async function nmedia(method, route, body, headers) {
	// A streamed body needs `duplex: 'half'` — undici refuses it otherwise. A fixed-length stream is fine
	// because the caller sets Content-Length itself.
	const init = { method, body, headers };
	if (body && typeof body.pipe === 'function') init.duplex = 'half';
	const response = await fetch(NMEDIA + route, init);
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

// Streams the stored original rather than holding it: it is already a file on disk and may be gigabytes.
async function submitOriginal(file, size, filename) {
	const response = await nmedia('POST', '/v1/upload', fs.createReadStream(file), {
		'content-type': 'application/octet-stream',
		'content-length': String(size),
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
 * **Act one: reserve.** Creates the record with a ticket and no bytes, and returns as soon as it exists.
 *
 * The old CMS creates the item first and attaches the binary afterwards, and that order is the whole reason an
 * upload progress area is possible: the row can appear while its bytes are still in flight, and the bytes can
 * be sent by something that reports progress (upload-and-events-plan.md §A). It is kept because it is the
 * behaviour, not because it is convenient.
 *
 * The ticket is server-issued. The client could generate one, but then the identifier of a half-uploaded
 * record would be a value the client chose and the server merely believed — and it is the only thing standing
 * between a losing race and one upload writing over another's bytes.
 */
function reserve({ filename, size, mime, bucket }) {
	if (typeof filename !== 'string' || !filename.trim()) {
		throw new HttpError(400, 'filename_required', 'A filename is required.', filename);
	}
	const clean = filename.trim();
	if (/[/\\]/.test(clean)) {
		throw new HttpError(400, 'invalid_filename', 'A filename cannot contain a path separator.', clean);
	}

	// The extension names the stored original and decides whether there is a menu at all, so a file without a
	// usable one is refused here rather than stored under a name nothing can resolve.
	const extension = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
	const kind = kindOfExtension(extension);
	if (!kind) {
		throw new HttpError(415, 'unsupported_type', `"${extension}" is not a usable file extension.`, { extension });
	}
	if (bucket !== undefined && bucket !== null && !bucketDb().contains(bucket)) {
		throw new HttpError(404, 'unknown_bucket', `No bucket "${bucket}".`);
	}

	// A declared size over the limit is refused now, cheaply, rather than after the client has sent 4 GiB. The
	// authoritative check is still the one made as the bytes arrive — a declared length is a claim.
	if (size !== undefined && size !== null && (!Number.isInteger(size) || size < 0)) {
		throw new HttpError(400, 'invalid_size', 'A declared size must be a non-negative integer.', { size });
	}
	if (typeof size === 'number' && size > MAX_UPLOAD_BYTES) {
		throw new HttpError(413, 'too_large', `Upload is ${size} bytes; the limit is ${MAX_UPLOAD_BYTES}.`,
			{ limit: MAX_UPLOAD_BYTES });
	}

	const assets = assetDb();
	const id = assets.insert({
		bucket: bucket ?? null,
		filename: clean,
		extension,
		mime: mime ?? 'application/octet-stream',
		kind,
		size: size ?? null,
		original: null,
		variants: {},
		jobs: {},
		processing: null,
		ticket: crypto.randomBytes(12).toString('base64url'),
		ticket_expires: Date.now() + TICKET_TTL_MS,
		c_date: Date.now(),
		m_date: Date.now()
	});
	assets.flush();
	return getAsset(id);
}

/**
 * **Act two: the bytes.** Streams the received file into the pool against the reservation's ticket, then hands
 * straight to processing.
 *
 * Processing follows the bytes here, as it does in the old CMS, rather than being a third client action. The
 * alternative — a separate *process* step — buys a state ("uploaded, not processing") that the original does
 * not have and costs the author a click; it is left recorded as open decision 1 in the events plan rather than
 * silently taken.
 */
async function acceptBytes(id, { ticket, originalPath, size }) {
	const asset = getAsset(id);

	// Both refusals are 409s, not 400s: the request is well formed and the asset is real — it is the *state*
	// that does not allow it, and saying which state is what makes the failure actionable.
	if (!asset.ticket) {
		throw new HttpError(409, 'not_awaiting_bytes',
			'This asset is not waiting for bytes — it already has its own.', { id });
	}
	if (ticket !== asset.ticket) {
		throw new HttpError(409, 'bad_ticket', 'The ticket does not match this asset.', { id });
	}
	if (!ticketIsLive(asset)) {
		throw new HttpError(409, 'ticket_expired',
			'This reservation expired, so its bytes are no longer accepted — reserve the file again.', { id });
	}

	const original = storeOriginal(id, asset.extension, originalPath, size);
	updateAsset(id, { original, size, ticket: null, ticket_expires: null });
	return reprocess(id);
}

// A named retry is checked against the asset's own menu rather than accepted blindly: a typo must be a
// refusal, not a job queued for a variant that does not exist.
function namesToVariants(menu, only) {
	if (!Array.isArray(only) || !only.length) {
		throw new HttpError(400, 'empty_variant_list', 'Name at least one variant to reprocess.', only);
	}
	return [...new Set(only)].map((name) => {
		const variant = menu.find((candidate) => candidate.name === name);
		if (!variant) {
			throw new HttpError(400, 'unknown_variant', `No variant "${name}" in this asset's menu.`, { name });
		}
		return variant;
	});
}

// Re-queues an asset's variants. An omitted `only` re-queues the whole menu; naming variants re-queues just
// those, so fixing one failed job does not re-run the other nine. The original is re-uploaded either way
// rather than trusting nMedia's cached copy: that cache expires, and a reprocess that silently depended on
// it would fail for no visible reason.
async function reprocess(id, only) {
	const asset = getAsset(id);
	const menu = variantsFor(asset.kind);
	const selected = only === undefined || only === null ? menu : namesToVariants(menu, only);

	// A kind with no menu has nothing to process, so nMedia is not contacted at all and there is no job state
	// to report. This is the same rule the first upload follows, and it is why reprocessing a stored document
	// is a no-op rather than a request that cannot do anything.
	if (!menu.length) return updateAsset(id, { processing: null });

	// Streamed from the stored original — reprocessing must not read the whole file into memory either.
	const original = path.join(variantDir(id), asset.original.file);

	let fileId;
	try {
		fileId = await submitOriginal(original, asset.original.size, asset.filename);
	} catch (error) {
		// Recorded per variant instead of thrown away: a retry that fails must say so and say why, and the
		// variants that already work are untouched either way. Same shape as a failed first upload. Only the
		// selected variants are touched, so a failed attempt at one never marks the others as failed.
		const failed = Object.fromEntries(selected.map((variant) => [variant.name, {
			...(asset.jobs?.[variant.name] ?? {}), status: 'failed', error: error.message, m_date: Date.now()
		}]));
		return updateAsset(id, {
			jobs: { ...asset.jobs, ...failed },
			processing: { fileId: null, error: error.message }
		});
	}

	const jobs = {};
	for (const variant of selected) {
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
		// Set when a job reaches a state a waiting client cares about, which is what becomes a message.
		let settled = false;
		for (const [name, job] of Object.entries(asset.jobs ?? {})) {
			if (job.status !== 'queued' && job.status !== 'processing') continue;
			try {
				const status = await (await nmedia('GET', `/v1/jobs/${job.jobId}`)).json();
				advanced++;
				if (status.status === 'completed') {
					settled = true;
					const bytes = Buffer.from(await (await nmedia('GET', `/v1/assets/${status.assetId}`)).arrayBuffer());
					const stored = storeVariant(asset._id, { ...byVariantName(name), buffer: bytes });
					next.variants = { ...next.variants, [name]: { ...stored, c_date: Date.now() } };
					next.jobs = { ...next.jobs, [name]: { ...job, status: 'completed', assetId: status.assetId, progress: 100, m_date: Date.now() } };
				} else if (status.status === 'failed' || status.status === 'cancelled') {
					// Kept and surfaced: a failed variant is reported with the processor's own message and
					// is retryable, and any earlier working variant is still in place.
					settled = true;
					next.jobs = { ...next.jobs, [name]: { ...job, status: status.status, error: status.error ?? 'processing failed', m_date: Date.now() } };
				} else {
					next.jobs = { ...next.jobs, [name]: { ...job, status: status.status, progress: status.progress ?? job.progress ?? 0, m_date: Date.now() } };
				}
			} catch (error) {
				settled = true;
				next.jobs = { ...next.jobs, [name]: { ...job, status: 'failed', error: error.message, m_date: Date.now() } };
			}
		}
		writeAsset(next);
		if (settled) events.emit('asset-settled', next);
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
	events,
	NMEDIA,
	MAX_UPLOAD_BYTES,
	UPLOAD_TMP,
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
	editAsset,
	assetFile,
	variantDir,
	integrity,
	sweepPool,
	reserve,
	acceptBytes,
	reprocess,
	advanceJobs,
	startJobDriver,
	nmediaHealth,
	kindOfExtension
};
