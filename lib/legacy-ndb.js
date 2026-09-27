'use strict';

// The nDB port of the old CMS's database seam.
//
// The old CMS reached its database through exactly one seam. `Server/js/nedb.js` exported a
// singleton whose `collection(db, name)` returns an object with **five methods** —
// `getDocs`, `getDoc`, `add`, `update`, `delete` — and `Server/index.js` (~1620 lines) never
// sees the engine, only those collection objects. A second implementation of the same seam
// already exists in the old tree (`Server/js/mongo.js`), which is what makes this cut safe:
// the seam has been re-implemented once before without touching `index.js`.
//
// So this file is the whole of the database substitution. `index.js` is not edited.
//
// ── The contract, as measured from the call sites ────────────────────────────────────────────
//
// Every query the 1620 lines issue is one of six shapes: `{}`, `{_id}`, `{_id: [ … ]}`,
// `{bucket}`, `{name}`, `{email}`. No `$regex`, `$in`, `$gt`, `$elemMatch` anywhere. Sorts are
// `{c_date: -1}` or absent. Projections are `{email: 1}`, `{password: 0}` or absent. Writes are
// `{$set: { … }}` on dot-paths, one `{replace: true}`, and two whole-document `update()` calls.
// This adapter implements that closed set and refuses everything outside it, loudly — a silent
// "handled" for a shape that was never tested is how a port produces wrong data instead of an
// error.
//
// Semantic decisions, each pinned to evidence rather than convenience:
//
//   * `getDoc` resolves `undefined` for no match. neDB's error path resolves with no argument
//     (`nedb.js` getDoc) and call sites branch on the falsy result (`colList` → "Collection does
//     not exist"), so this is load-bearing, not leniency.
//   * `add` accepts an ARRAY. `dbsDelete` backfills a whole collection to trash in one call
//     (`index.js:482`). The array branch is also present in `mongo.js`, so it is real.
//   * `add` resolves the inserted document(s) **with `_id`**. nDB's `insert` returns only the id
//     string; the document is re-read so the caller gets what neDB gave it.
//   * `update` resolves the updated document. `nedb.js` forces `returnUpdatedDocs`; `mongo.js`
//     resolves a *count* instead. Two implementations disagreeing means no caller can depend on
//     the value — so the richer of the two is safe, and the two call sites that read `doc._id`
//     off an update result (`index.js:1086`, `:1210`) keep working.
//   * `update` has two shapes, both real: keyed by `_id` (seven sites) and a field query carrying
//     `update_options:{multi:true}` (exactly one — `deleteBucket` re-filing a bucket's files to trash,
//     `index.js:428`, which maps the result as an array). `mongo.js` branches on the same distinction.
//     An update with neither an `_id` nor `multi` is refused: neDB would have updated every match and
//     reported nothing, and no call site asks for that.
//   * A write that matches nothing is tolerated, not refused: neDB resolved `null` (single) or `[]`
//     (multi), and the routes return that as a success. The caller's log entry is the trace.
//   * `delete` resolves `${id} deleted` — neDB's string, which no caller reads (`mongo.js` returns
//     a count for the same call).
//
// ── On-disk layout ───────────────────────────────────────────────────────────────────────────
//
// neDB: one JSON file per collection, inside a folder per db — `<DB_PATH>/<db>/<collection>.json`.
// nDB: one database per folder, the database *being* the `data.jsonl` file inside it. So
// `(db, collection)` maps to `<root>/<db>/<collection>/data.jsonl`, and `('admin', 'files_db')`
// lands at `data/legacy/admin/files_db/data.jsonl`.
//
// Collections are created implicitly on first touch. That is the old CMS's behaviour and it must
// survive the port: `dbsDelete` creates `collections/trash` by writing to it, and a created db's
// own collection folder is never explicitly made. The registry (`admin/dbs_db`) is what decides
// whether a collection *exists* to a user, exactly as before — the engine is deliberately not the
// authority here. (This is the opposite of the new CMS's `store.js`, where meta is the authority
// and an undeclared key is refused. Both are correct for their own system.)

const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('../modules/nDB/napi/index.js');

const DEFAULT_ROOT = path.join(__dirname, '..', 'data', 'legacy');

const EXT = '.json'; // the old collector's extension; not a real file here, only a name to strip

// ── Query translation ───────────────────────────────────────────────────────────────────────

// `{}` is a query for everything. nDB distinguishes `iter()` (all documents, no AST) from
// `query(ast)`, and `null` here means "everything" so `getDocs` can take the cheaper path.
function toAst(query) {
	if (query === undefined || query === null) return null;
	if (typeof query !== 'object' || Array.isArray(query)) {
		throw new TypeError(`A query must be an object, got ${JSON.stringify(query)}.`);
	}
	const keys = Object.keys(query);
	if (!keys.length) return null;

	if (query._id !== undefined && Array.isArray(query._id)) {
		// `idQuery` in the old `nedb.js` *replaces* the whole query with an `$or` of ids, discarding
		// any sibling condition. If a sibling were present the filter would silently vanish and the
		// query would return more than it asked for — so that combination is refused instead of
		// reproduced. No call site in the old tree builds it.
		const extra = keys.filter((key) => key !== '_id');
		if (extra.length) {
			throw new TypeError(
				`A query mixing an \`_id\` array with ${extra.map((k) => `\`${k}\``).join(', ')} ` +
				'has no defined meaning in the old seam — the id list replaced the query wholesale. ' +
				'Issue the id query and filter in the caller.');
		}
		return { $or: query._id.map((id) => ({ _id: id })) };
	}

	return query;
}

// `{c_date: -1}` → nDB's `{ sortBy, sortDir }`. Only the two sort shapes the tree uses are
// accepted; anything else would be quietly ignored otherwise, which changes result order.
function toSortDir(sort) {
	if (sort === undefined || sort === null) return null;
	if (typeof sort !== 'object' || Array.isArray(sort)) {
		throw new TypeError(`A sort must be an object, got ${JSON.stringify(sort)}.`);
	}
	const entries = Object.entries(sort);
	if (!entries.length) return null;
	if (entries.length > 1) {
		throw new TypeError(`A multi-key sort (${JSON.stringify(sort)}) is not used by the old CMS ` +
			'and is not implemented — nDB sorts by one field.');
	}
	const [field, direction] = entries[0];
	if (direction !== 1 && direction !== -1) {
		throw new TypeError(`Sort direction for \`${field}\` must be 1 or -1, got ${JSON.stringify(direction)}.`);
	}
	return { sortBy: field, sortDir: direction === -1 ? 'desc' : 'asc' };
}

// neDB's projection is either inclusive (`{email: 1}` — the named fields plus `_id`) or exclusive
// (`{password: 0}` — everything but). Mixing them is an error there too, so it is an error here.
function project(doc, projection) {
	if (!projection) return doc;
	const entries = Object.entries(projection);
	if (!entries.length) return doc;

	const inclusions = entries.filter(([, keep]) => keep);
	if (inclusions.length && inclusions.length !== entries.length) {
		throw new TypeError(`A projection may not mix inclusion and exclusion: ${JSON.stringify(projection)}.`);
	}

	if (inclusions.length) {
		const out = {};
		for (const [field] of inclusions) if (doc[field] !== undefined) out[field] = doc[field];
		if (doc._id !== undefined) out._id = doc._id;
		return out;
	}

	const out = { ...doc };
	for (const [field] of entries) delete out[field];
	return out;
}

// ── Client ──────────────────────────────────────────────────────────────────────────────────

function createClient(root = DEFAULT_ROOT) {
	const handles = new Map();      // collection path → Database
	const byDb = {};                // db name → { [collection]: Database } — the shape `listDbs` reports

	function open(db, collection) {
		if (typeof db !== 'string' || !db) throw new TypeError('A db name is required.');
		if (typeof collection !== 'string' || !collection) throw new TypeError('A collection name is required.');

		const dir = path.join(root, db, collection);
		const file = path.join(dir, 'data.jsonl');

		let handle = handles.get(file);
		if (!handle) {
			// nDB's `Database.open()` creates a database it cannot find — implicit creation is the
			// old CMS's behaviour, so no existence check is made here.
			handle = Database.open(file, { persistence: 'immediate' });
			handles.set(file, handle);
			(byDb[db] ??= {})[collection] = handle;
		}
		return handle;
	}

	// The old client's cache, keyed the same way, so an eviction is visible to `listDbs` too.
	function evict(db, collection) {
		const file = path.join(root, db, collection, 'data.jsonl');
		handles.delete(file);
		if (byDb[db]) delete byDb[db][collection];
	}

	async function getDocs(options) {
		const { db, collection } = options;
		const ast = toAst(options.query);
		const sort = toSortDir(options.sort);

		const handle = open(db, collection);
		const docs = sort
			? await handle.queryWith(ast ?? {}, { sortBy: sort.sortBy, sortDir: sort.sortDir })
			: (ast ? await handle.query(ast) : handle.iter());

		return docs.map((doc) => project(doc, options.projection));
	}

	async function getDoc(options) {
		const { db, collection } = options;
		const handle = open(db, collection);
		const query = options.query ?? {};

		// The by-id path is the common one; `get` also tells us a soft-deleted document is gone.
		if (typeof query._id === 'string') {
			try {
				return project(handle.get(query._id), options.projection);
			} catch {
				return undefined; // `not found` — the old seam resolves undefined, callers branch on it
			}
		}

		const ast = toAst(query);
		const docs = ast ? await handle.query(ast) : handle.iter();
		return docs.length ? project(docs[0], options.projection) : undefined;
	}

	async function add(options, data) {
		const handle = open(options.db, options.collection);

		if (Array.isArray(data)) {
			// neDB's `insert([])` is a no-op rather than an error; `dbsDelete` relies on the array
			// branch but can legitimately hand it an empty collection to trash.
			if (!data.length) return [];
			return data.map((doc) => {
				const id = handle.insert(doc);
				return handle.get(id);
			});
		}

		if (data === null || typeof data !== 'object') {
			throw new TypeError(`A document must be an object, got ${JSON.stringify(data)}.`);
		}
		const id = handle.insert(data);
		return handle.get(id); // read back so the caller gets the stored document, as neDB gave it
	}

	async function update(options, data) {
		const handle = open(options.db, options.collection);
		const query = options.query ?? {};
		const id = typeof query._id === 'string' ? query._id : null;
		const multi = options.update_options?.multi === true;

		// Two update shapes exist, and they are both real:
		//   * keyed by `_id` — seven call sites, the ordinary edit;
		//   * a field query with `{multi:true}` — exactly one, `deleteBucket` re-filing every file in
		//     a bucket to trash (`index.js:428`), which then maps the result as an **array**.
		// `mongo.js` branches on precisely this distinction (`options.query._id` → `update`, else
		// `updateMany`), which is what confirms the multi form rather than a guess at a safety net.
		if (!id && !multi) {
			throw new TypeError(
				`An update must either be keyed by \`_id\` or carry \`update_options:{multi:true}\`; ` +
				`got ${JSON.stringify(query)}. Without either, neDB updated every match and reported ` +
				'nothing — the shape has no call site and no defined result.');
		}

		const isModifier = data !== null && typeof data === 'object' && Object.keys(data).some((k) => k.startsWith('$'));

		if (isModifier) {
			for (const operator of Object.keys(data)) {
				if (operator !== '$set') {
					throw new TypeError(
						`Unsupported update operator \`${operator}\` at ${options.db}/${options.collection}. ` +
						'Only `$set` is used by the old CMS; the others were measured absent.');
				}
			}
		}

		// Resolve the targets. A query that matches nothing is **not** an error: neDB resolved `null`
		// for a single no-match and `[]` for a multi no-match, and the routes send that straight back
		// as a success (`dbsEdit` on a stale id reports `message:null`). Tolerating it at this boundary
		// is the old contract — the caller's own log entry is the trace.
		let targets;
		if (id) {
			if (!handle.contains(id)) return multi ? [] : null;
			targets = [id];
		} else {
			targets = (await handle.query(toAst(query))).map((doc) => doc._id);
		}

		for (const target of targets) {
			if (isModifier) {
				// `$set` maps to nDB's delta `set`, which is path-addressed — so a dot-path key writes
				// exactly the leaf neDB would have written, without a whole-document rewrite.
				for (const [field, value] of Object.entries(data.$set ?? {})) {
					handle.set(target, field, value);
				}
			} else {
				// A bare document is a whole-document replacement — neDB's plain-object update form, and
				// what `mongo.js` maps to `replaceOne`. nDB's `update` replaces and preserves `_id`.
				handle.update(target, data);
			}
		}

		handle.flush();
		const updated = targets.map((target) => handle.get(target));
		return multi ? updated : updated[0];
	}

	async function remove(options, id) {
		const handle = open(options.db, options.collection);
		handle.delete(id);
		handle.flush();
		return `${id} deleted`;
	}

	// ── Module-level surface, matching the old export exactly ────────────────────────────────

	const client = {
		collection(db, collection) {
			return {
				getDocs: (options) => getDocs({ ...(options ?? {}), db, collection }),
				getDoc: (options) => getDoc({ ...options, db, collection }),
				add: (data) => add({ db, collection }, data),
				update: (options, data) => update({ ...options, db, collection }, data),
				delete: (id) => remove({ db, collection }, id)
			};
		},

		getDocs,
		getDoc,
		add,
		update,
		delete: remove,

		// The old client returned a cached handle; callers await it and never inspect the type.
		getCollection: async (db, collection, force = false) => {
			if (force) evict(db, collection); // `loadAll` and the bootstrap path force a re-read
			return open(db, collection);
		},

		compactCollection: async (db, collection) => {
			open(db, collection).compact();
		},

		compactAll: async () => {
			for (const [, handle] of handles) handle.compact();
		},

		// Removes every document and the collection's own folder, then drops the handle so a later
		// write re-creates it — which is what the neDB original did, minus its bug: it unlinked
		// `path.join(base_path, _db, _collection)`, a path with **no `.json` extension**, so the
		// unlink always failed and `dbsDelete` reported an error after a delete that had in fact
		// exported every document to trash (`index.js:484`). The behaviour is reproduced; the bug
		// is not.
		destroy: async (db, collection) => {
			const handle = open(db, collection);
			const ids = handle.iter().map((doc) => doc._id);
			for (const id of ids) handle.delete(id);
			handle.flush();
			handle.close?.();
			evict(db, collection);
			fs.rmSync(path.join(root, db, collection), { recursive: true, force: true });
			return ids.length;
		},

		// Walks the root and re-opens everything, evicting stale handles. Used after a backup
		// restore, so the eviction is the point: a cached handle would still point at the file the
		// restore replaced.
		loadAll: async () => {
			handles.clear();
			for (const key of Object.keys(byDb)) delete byDb[key];

			const out = {};
			if (!fs.existsSync(root)) return out;

			for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				out[entry.name] = [];
				const dbDir = path.join(root, entry.name);
				for (const child of fs.readdirSync(dbDir, { withFileTypes: true })) {
					if (!child.isDirectory()) continue;
					if (!fs.existsSync(path.join(dbDir, child.name, 'data.jsonl'))) continue;
					open(entry.name, child.name);
					out[entry.name].push(child.name + EXT);
				}
			}
			return out;
		},

		listDbs: () => byDb
	};

	return client;
}

module.exports = { createClient, DEFAULT_ROOT };
