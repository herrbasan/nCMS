'use strict';

// Storage layer. nDB is database-as-folder: the database *is* the data.jsonl file inside a
// folder, and each collection is one such folder under data/.
//
// Which collections exist is declared by data/meta/data.jsonl, not by what happens to be on
// disk. That matters because `Database.open()` CREATES a database it cannot find — so a
// typo'd collection key would otherwise silently bring a new collection into existence
// instead of failing. `collectionDb()` therefore checks the declaration before opening.

const path = require('node:path');
const { Database } = require('../modules/nDB/napi/index.js');
const { HttpError } = require('./http-error.js');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const META_FILE = path.join(DATA_ROOT, 'meta', 'data.jsonl');

const databases = new Map();

function open(file) {
	let db = databases.get(file);
	if (!db) {
		db = Database.open(file, { persistence: 'immediate' });
		databases.set(file, db);
	}
	return db;
}

// A meta document without a `key` is not a collection. The meta file's own format header
// (the `_meta` record nDB writes as line 1) is the case that actually occurs.
function listCollections() {
	return open(META_FILE).iter().filter((doc) => typeof doc.key === 'string');
}

function collectionMeta(key) {
	const meta = listCollections().find((c) => c.key === key);
	if (!meta) {
		throw new HttpError(404, 'unknown_collection',
			`No collection "${key}" is declared in meta.`, { declared: listCollections().map((c) => c.key) });
	}
	return meta;
}

function collectionDb(key) {
	collectionMeta(key); // refuse an undeclared key before Database.open() would create it
	return open(path.join(DATA_ROOT, key, 'data.jsonl'));
}

// ─── Collections ────────────────────────────────────────────────────────────────────────────
// A collection is a declaration in meta plus a folder of its own, and the plan gives it
// create/edit/delete as **axis actions** — the ones `nui-link-list`'s rowAction was built for.
// The declaration is written first and the folder materialised second: that order is what
// keeps the load-bearing check in `collectionDb()` meaningful.

const RESERVED_KEYS = new Set(['meta']);
const KEY_RE = /^[a-z][a-z0-9-]*$/;

function slugify(name) {
	const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (!slug) {
		throw new HttpError(400, 'invalid_name', `Cannot derive a collection key from "${name}".`);
	}
	return slug;
}

// Languages are the only schema a collection itself carries: which languages its documents are
// translatable into (one document per language in `docs`). Every collection has at least one.
function normalizeLanguages(value) {
	if (value === undefined) return ['en'];
	if (!Array.isArray(value) || !value.length) {
		throw new HttpError(400, 'invalid_languages',
			'translatability must be a non-empty array of language codes.', value);
	}
	const codes = value.map((code) => String(code).toLowerCase().trim());
	for (const code of codes) {
		if (!/^[a-z]{2}(-[a-z]{2})?$/.test(code)) {
			throw new HttpError(400, 'invalid_language', `"${code}" is not a language code.`, value);
		}
	}
	return [...new Set(codes)];
}

function getCollection(key) {
	return collectionMeta(key);
}

function createCollection(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new HttpError(400, 'invalid_body', 'A collection body must be an object.', input);
	}
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name) throw new HttpError(400, 'invalid_name', 'A collection needs a non-empty name.', input.name);

	const key = input.key === undefined || input.key === '' ? slugify(name) : String(input.key);
	if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
		throw new HttpError(400, 'invalid_key',
			`"${key}" is not a usable collection key — lowercase letters, digits and dashes, starting with a letter.`, key);
	}
	if (listCollections().some((c) => c.key === key)) {
		throw new HttpError(409, 'collection_exists', `A collection "${key}" already exists.`, { key });
	}

	const translatability = normalizeLanguages(input.translatability);
	const metaDb = open(META_FILE);
	const _id = metaDb.insert({ key, name, translatability, c_date: Date.now() });
	metaDb.flush();

	// Materialise the folder so the collection is a real database from the moment it is declared.
	open(path.join(DATA_ROOT, key, 'data.jsonl')).flush();

	return { _id, key, name, translatability, c_date: Date.now() };
}

function updateCollection(key, patch) {
	const meta = collectionMeta(key);
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
		throw new HttpError(400, 'invalid_body', 'A collection patch must be an object.', patch);
	}
	// The key is the collection's identity — the folder on disk and the path in the API. Only the
	// declaration's contents are editable.
	if (patch.key !== undefined && patch.key !== key) {
		throw new HttpError(400, 'key_immutable',
			'A collection key cannot be changed — it is the folder and the API path. Rename `name` instead.',
			{ key, requested: patch.key });
	}

	const next = { ...meta };
	if (patch.name !== undefined) {
		const name = typeof patch.name === 'string' ? patch.name.trim() : '';
		if (!name) throw new HttpError(400, 'invalid_name', 'A collection needs a non-empty name.', patch.name);
		next.name = name;
	}
	if (patch.translatability !== undefined) {
		next.translatability = normalizeLanguages(patch.translatability);
	}
	next.m_date = Date.now();

	const metaDb = open(META_FILE);
	metaDb.update(meta._id, next);
	metaDb.flush();
	return next;
}

// Two-stage deletion, declaration-sized. The declaration is tombstoned; the folder and every
// document in it stay exactly where they are. That is nDB's own trash applied to the one thing
// that decides whether a collection exists — `listCollections()` reads declarations, so a
// tombstoned declaration removes the collection from the axis without touching a single byte of
// content, and `restore(id)` brings it back. Purging the folder is the irreversible act, and it
// is deliberately not wired to anything yet.
//
// A choice, not a constraint: a folder move is also available. nDB's native binding implements
// `close()`, which does release the Windows lock (`db._native.close()` — measured, and asserted in
// tools/probe-ndb.js); the public JavaScript wrapper omits it (nDB #5). Marking is preferred because
// the two stages mean different things, neither is a filesystem operation, and it needs no trash
// directory.
function deleteCollection(key) {
	const meta = collectionMeta(key);
	const metaDb = open(META_FILE);
	metaDb.delete(meta._id);
	metaDb.flush();
	return { key, name: meta.name, _id: meta._id };
}

// The raw view is schema-unaware: a row's label is derived from the first conventional name
// that is present, or falls back to the id. This is a display convenience, explicitly not a
// schema — nothing is ever written from here.
function titleOf(doc) {
	if (typeof doc.name === 'string' && doc.name) return doc.name;
	if (typeof doc.title === 'string' && doc.title) return doc.title;
	if (doc.docs) {
		const first = Object.values(doc.docs).find((v) => typeof v === 'string');
		const title = first && first.match(/^title:[ \t]*(.+)$/m);
		if (title) return title[1].trim();
	}
	return null;
}

function snippetOf(doc) {
	if (doc.docs) {
		const first = Object.values(doc.docs).find((v) => typeof v === 'string');
		if (first) return first.replace(/\s+/g, ' ').trim().slice(0, 200);
	}
	return null;
}

function summary(doc) {
	return {
		_id: doc._id,
		title: titleOf(doc),
		snippet: snippetOf(doc),
		c_date: doc.c_date === undefined ? null : doc.c_date,
		m_date: doc.m_date === undefined ? null : doc.m_date
	};
}

function listEntries(key) {
	return collectionDb(key).iter().map(summary);
}

function getEntry(key, id) {
	const db = collectionDb(key);
	if (!db.contains(id)) {
		throw new HttpError(404, 'unknown_entry', `No entry "${id}" in "${key}".`);
	}
	return db.get(id);
}

// An entry body must be a JSON object. Not defensive coding — the alternative is a silent lie: a
// string body spreads into `{0:'h',1:'e',…}` and becomes a junk record that no one asked for, and
// an array or null reaches nDB's `insert` as a JSON scalar, which aborts the whole process rather
// than throwing (nDB #6). One check at the boundary removes both.
function assertDocument(doc) {
	if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
		throw new HttpError(400, 'invalid_document', 'An entry body must be a JSON object.', {
			received: doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc
		});
	}
}

function createEntry(key, doc) {
	assertDocument(doc);
	const db = collectionDb(key);
	const id = db.insert({ ...doc, c_date: Date.now() });
	db.flush();
	return id;
}

function putEntry(key, id, doc) {
	assertDocument(doc);
	const db = collectionDb(key);
	if (!db.contains(id)) {
		throw new HttpError(404, 'unknown_entry', `No entry "${id}" in "${key}".`);
	}
	if (doc._id !== undefined && doc._id !== id) {
		throw new HttpError(400, 'id_mismatch',
			`Document _id "${doc._id}" does not match the entry id "${id}" in the URL.`);
	}
	const next = { ...doc, _id: id, m_date: Date.now() };
	db.update(id, next);
	db.flush();
	return next;
}

// Soft delete: nDB tombstones the document. Nothing is destroyed until the trash is
// emptied — the two-stage deletion the plan describes.
function deleteEntry(key, id) {
	const db = collectionDb(key);
	if (!db.contains(id)) {
		throw new HttpError(404, 'unknown_entry', `No entry "${id}" in "${key}".`);
	}
	db.delete(id);
	db.flush();
	return { _id: id };
}

module.exports = {
	listCollections,
	getCollection,
	createCollection,
	updateCollection,
	deleteCollection,
	listEntries,
	getEntry,
	createEntry,
	putEntry,
	deleteEntry
};
