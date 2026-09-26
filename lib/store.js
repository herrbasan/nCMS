'use strict';

// Storage layer. nDB is database-as-folder: the database *is* the data.jsonl file inside a
// folder, and each collection is one such folder under data/.
//
// Which collections exist is declared by data/meta/data.jsonl, not by what happens to be on
// disk. That matters because `Database.open()` CREATES a database it cannot find — so a
// typo'd collection key would otherwise silently bring a new collection into existence
// instead of failing. `collectionDb()` therefore checks the declaration before opening.

const fs = require('node:fs');
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

// ─── Collection definition ──────────────────────────────────────────────────────────────────
// The definition lives in the collection's own `meta.json` under a `cms` key — not in the registry
// (brief D1). The registry answers "does this collection exist"; the definition answers "what do its
// entries mean". nDB's `schemas` key in the same file is a *different* contract (storage types) and
// its core ignores the whole file, so ours is namespaced and nothing collides.
//
// The file is read and written here directly, not through nDB. That is the point: it is nDB's file,
// the core neither reads nor writes it, and a definition change is an explicit act (D3b) rather
// than a side effect of saving an entry.

const DEFINITION_KEY = 'cms';
const BODY_POLICIES = new Set(['required', 'optional', 'none']);
const FIELD_KINDS = new Set(['shared', 'per-language']);
const EMPTY_DEFINITION = Object.freeze({ languages: [], body: 'optional', display: null, fields: {} });

const definitionPath = (key) => path.join(DATA_ROOT, key, 'meta.json');

function readDefinition(key) {
	const file = definitionPath(key);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, 'utf8'))[DEFINITION_KEY] ?? null;
}

function normalizeDefinition(input) {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new HttpError(400, 'invalid_definition', 'A definition must be a JSON object.', input);
	}
	if (input.body !== undefined && !BODY_POLICIES.has(input.body)) {
		throw new HttpError(400, 'invalid_definition',
			`body must be one of ${[...BODY_POLICIES].join(', ')}.`, input.body);
	}
	if (input.display !== undefined && input.display !== null && typeof input.display !== 'string') {
		throw new HttpError(400, 'invalid_definition', 'display is a field name or null.', input.display);
	}
	const fields = {};
	for (const [name, spec] of Object.entries(input.fields ?? {})) {
		if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || !FIELD_KINDS.has(spec.kind)) {
			throw new HttpError(400, 'invalid_definition',
				`Field "${name}" needs a kind of ${[...FIELD_KINDS].join(' or ')}.`, spec);
		}
		fields[name] = { kind: spec.kind };
	}
	return {
		languages: normalizeLanguages(input.languages),
		body: input.body ?? 'optional',
		display: input.display ?? null,
		fields
	};
}

// A value is **not** inspected to decide what it is. A shared field may legitimately hold
// `{en: 5, de: 7}` meaning something else entirely, and no amount of looking can tell that from a
// language map — so the only thing the rule may judge is what a definition *declares*. The
// consequence is deliberate: a declaration can only appear or change for a field that holds no
// values yet. Anything else is conversion, and conversion is not built.
function definitionConflicts(before, after, entries) {
	const conflicts = [];

	// A language that has content cannot be withdrawn: that content becomes unreadable. A field's
	// kind says how to read it, so this is declared-shape reading, not guessing.
	for (const language of before.languages) {
		if (after.languages.includes(language)) continue;
		for (const entry of entries) {
			if (entry.docs !== undefined && Object.prototype.hasOwnProperty.call(entry.docs, language)) {
				conflicts.push({ entry: entry._id, field: 'docs', code: 'language_in_use', language });
			}
			for (const [field, spec] of Object.entries(before.fields)) {
				if (spec.kind !== 'per-language') continue;
				const value = (entry.facts ?? {})[field];
				if (value !== null && typeof value === 'object' && !Array.isArray(value)
					&& Object.prototype.hasOwnProperty.call(value, language)) {
					conflicts.push({ entry: entry._id, field, code: 'language_in_use', language });
				}
			}
		}
	}

	// A declaration may only appear or change where nothing has been written yet — including a
	// declaration appearing over values that were written as undeclared free JSON, whose kind is
	// simply unknown.
	for (const [name, spec] of Object.entries(after.fields)) {
		const was = before.fields[name];
		if (was && was.kind === spec.kind) continue;
		for (const entry of entries) {
			if ((entry.facts ?? {})[name] !== undefined) {
				conflicts.push({ entry: entry._id, field: name, code: 'declaration_over_values' });
			}
		}
	}
	return conflicts;
}

// Write beside the file and rename over it. A direct write truncates first, so a failure part-way
// through would leave the existing definition destroyed rather than untouched.
function writeDefinition(key, definition) {
	const file = definitionPath(key);
	// Preserve whatever else nDB owns in this file — version, created, buckets, schemas. We add one
	// namespaced key and touch nothing else.
	const existing = fs.existsSync(file)
		? JSON.parse(fs.readFileSync(file, 'utf8'))
		: { version: 1, created: Math.floor(Date.now() / 1000) };
	const body = JSON.stringify({ ...existing, [DEFINITION_KEY]: definition }, null, 2) + '\n';
	const temporary = `${file}.tmp`;
	try {
		fs.writeFileSync(temporary, body);
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
	return definition;
}

function applyDefinition(key, input) {
	collectionMeta(key); // the collection must exist before it can be described
	const before = readDefinition(key) ?? EMPTY_DEFINITION;
	const after = normalizeDefinition(input);
	const conflicts = definitionConflicts(before, after, collectionDb(key).iter());
	if (conflicts.length) {
		// Refused **in whole**: nothing is written, so the definition on disk is unchanged. The
		// payload is the interface a later conversion feature consumes, which is why it carries
		// entry ids and codes rather than prose.
		throw new HttpError(409, 'definition_conflict',
			`${conflicts.length} existing value(s) would become unreadable under this definition.`,
			{ conflicts });
	}
	return writeDefinition(key, after);
}

function setCollectionDefinition(key, input) {
	return applyDefinition(key, input);
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
	// The definition is validated **before anything is written**. A bad definition must not leave a
	// collection behind that exists in the registry with no usable description.
	const definition = input.definition === undefined ? null : normalizeDefinition(input.definition);
	if (listCollections().some((c) => c.key === key)) {
		throw new HttpError(409, 'collection_exists', `A collection "${key}" already exists.`, { key });
	}

	// With a definition, `cms.languages` is the authority and the registry carries no language list
	// at all — one authority, not two (D1). Legacy collections, which have only the registry, keep
	// theirs and are otherwise untouched.
	const translatability = definition ? undefined : normalizeLanguages(input.translatability);
	const record = { key, name, c_date: Date.now() };
	if (translatability !== undefined) record.translatability = translatability;

	const metaDb = open(META_FILE);
	const _id = metaDb.insert(record);
	metaDb.flush();

	// Materialise the folder so the collection is a real database from the moment it is declared.
	open(path.join(DATA_ROOT, key, 'data.jsonl')).flush();
	if (definition) writeDefinition(key, definition);

	return { _id, key, name, ...(translatability === undefined ? {} : { translatability }), c_date: record.c_date };
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
// By design, for restore semantics: the two stages mean different things and neither is a filesystem
// operation, so deletion must not depend on whether a move is possible. A purge is a separate later
// step with an order — finish outstanding work, `close()` the database, drop it from the handle cache,
// then remove the files. `close()` releases the OS lock but does not drain pending async operations,
// and it is not in the pinned nDB revision this project uses (plan §5).
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

function summary(doc, definition) {
	return {
		_id: doc._id,
		// A defined collection's label comes from its declared display field, never from a guess; a
		// legacy collection keeps the old heuristic, unchanged.
		title: definition ? (labelOf(doc, definition) ?? doc.name ?? null) : titleOf(doc),
		snippet: snippetOf(doc),
		c_date: doc.c_date === undefined ? null : doc.c_date,
		m_date: doc.m_date === undefined ? null : doc.m_date
	};
}

// The *field* is declared, so nothing is guessed; only the language needs a rule, and the first
// declared language that holds a value is it.
function labelOf(doc, definition) {
	const field = definition.display;
	if (!field) return null;
	const value = (doc.facts ?? {})[field];
	if (value === undefined || value === null) return null;
	if (definition.fields[field]?.kind === 'per-language') {
		if (typeof value !== 'object' || Array.isArray(value)) return null;
		for (const language of definition.languages) {
			if (value[language] !== undefined) return String(value[language]);
		}
		return null;
	}
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function listEntries(key) {
	const definition = readDefinition(key);
	return collectionDb(key).iter().map((doc) => summary(doc, definition));
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

// The declared structure, enforced on entry writes. It is **not** a typed schema: it checks the
// shape the definition declares — which languages a per-language value and a document variant may
// use, and the body policy — and says nothing about the types inside a value. A shared field may
// hold arbitrary JSON, and a missing translation is always allowed: a variant that does not exist
// is "no URL" (B2), not an error.
function validateEntry(key, doc) {
	const definition = readDefinition(key);
	if (!definition) return; // a collection with no definition accepts anything, as legacy ones do

	const languages = new Set(definition.languages);
	const problems = [];
	const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

	if (doc.facts !== undefined && !isPlainObject(doc.facts)) {
		problems.push({ field: 'facts', code: 'not_an_object' });
	}
	for (const [field, spec] of Object.entries(definition.fields)) {
		const value = (doc.facts ?? {})[field];
		if (value === undefined) continue;          // absent is always allowed
		if (spec.kind !== 'per-language') continue; // shared values are arbitrary JSON, unchecked
		if (!isPlainObject(value)) {
			problems.push({ field, code: 'not_a_language_map' });
			continue;
		}
		for (const language of Object.keys(value)) {
			if (!languages.has(language)) problems.push({ field, code: 'undeclared_language', language });
		}
	}

	if (doc.docs !== undefined && !isPlainObject(doc.docs)) {
		problems.push({ field: 'docs', code: 'not_an_object' });
	} else {
		const variants = Object.keys(doc.docs ?? {});
		for (const language of variants) {
			if (!languages.has(language)) problems.push({ field: 'docs', code: 'undeclared_language', language });
		}
		if (definition.body === 'none' && variants.length) problems.push({ field: 'docs', code: 'body_not_allowed' });
		if (definition.body === 'required' && !variants.length) problems.push({ field: 'docs', code: 'body_required' });
	}

	if (problems.length) {
		throw new HttpError(400, 'invalid_entry',
			`${problems.length} value(s) do not fit the collection definition.`, { problems });
	}
}

function createEntry(key, doc) {
	assertDocument(doc);
	validateEntry(key, doc);
	const db = collectionDb(key);
	const id = db.insert({ ...doc, c_date: Date.now() });
	db.flush();
	return id;
}

function putEntry(key, id, doc) {
	assertDocument(doc);
	validateEntry(key, doc);
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
	readDefinition,
	setCollectionDefinition,
	listEntries,
	getEntry,
	createEntry,
	putEntry,
	deleteEntry
};
