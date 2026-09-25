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

function collectionDb(key) {
	const declared = listCollections().find((c) => c.key === key);
	if (!declared) {
		throw new HttpError(404, 'unknown_collection',
			`No collection "${key}" is declared in meta.`, { declared: listCollections().map((c) => c.key) });
	}
	return open(path.join(DATA_ROOT, key, 'data.jsonl'));
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

function createEntry(key, doc) {
	const db = collectionDb(key);
	const id = db.insert({ ...doc, c_date: Date.now() });
	db.flush();
	return id;
}

function putEntry(key, id, doc) {
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
	listEntries,
	getEntry,
	createEntry,
	putEntry,
	deleteEntry
};
