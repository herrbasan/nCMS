'use strict';

// Proves the nDB adapter holds the old CMS's database seam.
//
// The assertions below are not invented — each one is a shape measured from the old tree's real
// call sites, written as a test so the port cannot drift from them. The `index.js:NNN` notes are
// the evidence; when one of these fails, the port has diverged from the old CMS, not the test.
//
//   node tools/test-legacy-ndb.js

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('../lib/legacy-ndb.js');

const ROOT = path.join(__dirname, '..', 'data', 'legacy-test');

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

// Async because every method on the seam returns a promise: a synchronous `throws()` would pass a
// broken guard, since rejecting and throwing synchronously look identical from outside.
async function rejects(label, fn) {
	try {
		await fn();
		check(label, false, 'did not reject');
	} catch {
		check(label, true);
	}
}

async function main() {
	fs.rmSync(ROOT, { recursive: true, force: true });
	const db = createClient(ROOT);

	// ── The seam itself ────────────────────────────────────────────────────────────────────
	console.log('\nseam');
	const users = db.collection('admin', 'users_db');
	check('collection() exposes exactly the five methods',
		['getDocs', 'getDoc', 'add', 'update', 'delete'].every((m) => typeof users[m] === 'function'),
		Object.keys(users).join(','));
	check('module-level getDocs/getDoc/add/update/delete exist',
		['getDocs', 'getDoc', 'add', 'update', 'delete', 'getCollection', 'compactAll', 'destroy', 'loadAll', 'listDbs']
			.every((m) => typeof db[m] === 'function'));

	// ── Reads against an unseen collection ─────────────────────────────────────────────────
	// `colList` reads a collection folder before anything is written to it and treats an empty list
	// as "exists but empty" (index.js:509).
	console.log('\nempty collection');
	check('getDocs on an unseen collection resolves []',
		Array.isArray(await db.getDocs({ db: 'admin', collection: 'users_db' })));
	check('getDoc on an unseen collection resolves undefined (falsy — colList branches on it, index.js:507)',
		await db.getDoc({ db: 'admin', collection: 'users_db', query: { _id: 'nosuchid' } }) === undefined);

	// ── add ────────────────────────────────────────────────────────────────────────────────
	console.log('\nadd');
	const inserted = await db.add({ db: 'admin', collection: 'users_db' },
		{ email: 'a@b.c', password: 'secret', rights: 'admin', c_date: 1000, m_date: 1000 });
	check('add resolves the stored document with an _id', typeof inserted._id === 'string' && inserted._id.length > 0, JSON.stringify(inserted));
	check('the _id is the old CMS\'s shape — a 16-char alphanumeric (dbs_db sample, index.js:524-526)',
		/^[A-Za-z0-9]{16}$/.test(inserted._id), inserted._id);
	check('add keeps the document\'s own fields', inserted.email === 'a@b.c' && inserted.rights === 'admin');
	check('the collection is created implicitly — no explicit create step (dbsDelete writes collections/trash, index.js:482)',
		fs.existsSync(path.join(ROOT, 'admin', 'users_db', 'data.jsonl')));

	const second = await db.add({ db: 'admin', collection: 'users_db' },
		{ email: 'd@e.f', password: 'other', rights: 'user', c_date: 2000, m_date: 2000 });

	// The array branch is real — dbsDelete hands a whole fetched collection to the trash in one call
	// (index.js:482), and mongo.js has the same branch.
	console.log('\nadd — array');
	const batch = await db.add({ db: 'collections', collection: 'trash' },
		[{ name: 'one', c_date: 1 }, { name: 'two', c_date: 2 }]);
	check('add resolves an array of documents', Array.isArray(batch) && batch.length === 2, JSON.stringify(batch));
	check('each batched document carries an _id', batch.every((doc) => typeof doc._id === 'string' && doc._id));
	check('add([]) is a no-op, not an error (an empty collection may legitimately be trashed)',
		(await db.add({ db: 'collections', collection: 'trash' }, [])).length === 0);

	// ── getDoc by the two fields the tree queries on ───────────────────────────────────────
	console.log('\ngetDoc');
	const byEmail = await db.getDoc({ db: 'admin', collection: 'users_db', query: { email: 'a@b.c' } });
	check('getDoc finds by a non-id field (login does this, index.js:346)', byEmail?._id === inserted._id);
	const byId = await db.getDoc({ db: 'admin', collection: 'users_db', query: { _id: inserted._id } });
	check('getDoc finds by _id', byId?.email === 'a@b.c');
	check('a soft-deleted or absent id resolves undefined rather than throwing (index.js:561 guards on it)',
		await db.getDoc({ db: 'admin', collection: 'users_db', query: { _id: 'Y2o8D7cx1B0PROp9' } }) === undefined);

	// ── getDocs: the six query shapes, the two sorts, the two projections ──────────────────
	console.log('\ngetDocs — query, sort, projection');
	const all = await db.getDocs({ db: 'admin', collection: 'users_db' });
	check('{} is a query for everything (index.js:333)', all.length === 2);

	const sorted = await db.getDocs({ db: 'admin', collection: 'users_db', sort: { c_date: -1 } });
	check('sort {c_date:-1} orders newest first (index.js:389, :445, :501, :543, :766)',
		sorted.length === 2 && sorted[0].c_date === 2000, sorted.map((d) => d.c_date).join(','));

	const byBucket = await db.getDocs({ db: 'collections', collection: 'trash', query: { name: 'one' } });
	check('a single-field query filters (files_db is queried by `bucket`, index.js:431/991)', byBucket.length === 1);

	// `idQuery` — a list of ids becomes an `$or` (nedb.js:39-51). Used to fetch a set in one round trip.
	const byIds = await db.getDocs({ db: 'admin', collection: 'users_db', query: { _id: [inserted._id, second._id] } });
	check('{_id:[…]} becomes an $or over the ids (nedb.js idQuery)', byIds.length === 2, JSON.stringify(byIds.map((d) => d._id)));

	const incl = await db.getDocs({ db: 'admin', collection: 'users_db', projection: { email: 1 } });
	check('projection {email:1} keeps email and _id only (settings.users, index.js:730)',
		incl.every((doc) => Object.keys(doc).sort().join(',') === '_id,email'), JSON.stringify(incl[0]));
	const excl = await db.getDocs({ db: 'admin', collection: 'users_db', projection: { password: 0 } });
	check('projection {password:0} drops only password (the admin query route)',
		excl.every((doc) => doc.password === undefined && doc.email !== undefined));

	// ── update ─────────────────────────────────────────────────────────────────────────────
	console.log('\nupdate — $set');
	const renamed = await db.update(
		{ db: 'admin', collection: 'users_db', query: { _id: inserted._id } },
		{ $set: { email: 'new@b.c', m_date: Date.now() } });
	check('update resolves the updated document (nedb.js forces returnUpdatedDocs; index.js:1086 reads doc._id off it)',
		renamed?._id === inserted._id, JSON.stringify(renamed));
	check('$set changed the named fields', renamed.email === 'new@b.c');
	check('$set MERGES — fields it does not name survive', renamed.password === 'secret');
	check('_id is preserved across an update', renamed._id === inserted._id);

	// Dot-path `$set` is the one modifier form neDB and nDB express differently: neDB treats the key
	// as a path, nDB needs the path passed to `set`.
	const nested = await db.add({ db: 'collections', collection: 'x' }, { a: { b: 1, c: 2 } });
	await db.update({ db: 'collections', collection: 'x', query: { _id: nested._id } }, { $set: { 'a.b': 9 } });
	const afterPath = await db.getDoc({ db: 'collections', collection: 'x', query: { _id: nested._id } });
	check('a dot-path $set writes the leaf and leaves its sibling (neDB path semantics)',
		afterPath?.a?.b === 9 && afterPath?.a?.c === 2, JSON.stringify(afterPath));

	console.log('\nupdate — whole document');
	// A bare document is a replacement, not a merge — `{replace:true}` (index.js:588) and the two
	// whole-document calls (:1086 files_db, :1210 users_db).
	const replaced = await db.update(
		{ db: 'collections', collection: 'x', query: { _id: nested._id }, update_options: { replace: true } },
		{ a: { b: 9 } });
	check('a bare document replaces the document (replace:true, index.js:588)',
		replaced?.a?.c === undefined, JSON.stringify(replaced));
	check('replacement preserves _id', replaced?._id === nested._id);
	check('replacement does not resurrect dropped fields',
		(await db.getDoc({ db: 'collections', collection: 'x', query: { _id: nested._id } })).a.c === undefined);

	// ── update with {multi:true} — the one non-id write in the tree ────────────────────────
	// `deleteBucket` (index.js:423-437) deletes the bucket, then re-files every file that pointed at
	// it: `op.query = {bucket:id}`, `op.update_options = {multi:true}`, and it maps the resolved value
	// as an ARRAY. My first reading of the tree missed this and claimed every write was id-keyed —
	// this is the test that keeps that mistake from becoming a port.
	console.log('\nupdate — multi');
	const moved = await db.add({ db: 'admin', collection: 'files_db' },
		[{ bucket: 'b1', name: 'one', ext: '.jpg', c_date: 1 },
		 { bucket: 'b1', name: 'two', ext: '.jpg', c_date: 2 },
		 { bucket: 'b2', name: 'three', ext: '.jpg', c_date: 3 }]);
	const refiled = await db.update(
		{ db: 'admin', collection: 'files_db', query: { bucket: 'b1' }, update_options: { multi: true } },
		{ $set: { bucket: 'trash', m_date: Date.now() } });
	check('a field query with multi resolves an ARRAY of updated documents', Array.isArray(refiled) && refiled.length === 2,
		JSON.stringify(refiled));
	check('multi $set touched every match', refiled.every((doc) => doc.bucket === 'trash'));
	check('documents outside the query are untouched',
		(await db.getDoc({ db: 'admin', collection: 'files_db', query: { _id: moved[2]._id } })).bucket === 'b2');
	check('unchanged fields survive a multi $set', refiled.every((doc) => doc.name && doc.ext === '.jpg'));
	check('the multi result carries _id, so the handler can map it (index.js:430)',
		refiled.every((doc) => typeof doc._id === 'string'));

	// ── A write that matches nothing ───────────────────────────────────────────────────────
	// neDB resolved `null` / `[]` and the routes pass that back as a *success* (`dbsEdit` on a stale
	// id answers `message:null`). Refusing would turn the old CMS's tolerated no-op into an error.
	console.log('\nwrites that match nothing');
	check('a single update against an absent id resolves null, not an error',
		await db.update({ db: 'admin', collection: 'files_db', query: { _id: 'Y2o8D7cx1B0PROp9' } }, { $set: { x: 1 } }) === null);
	check('a multi update that matches nothing resolves []',
		(await db.update({ db: 'admin', collection: 'files_db', query: { bucket: 'nosuch' }, update_options: { multi: true } },
			{ $set: { x: 1 } })).length === 0);

	// ── delete ─────────────────────────────────────────────────────────────────────────────
	console.log('\ndelete');
	const deleted = await db.delete({ db: 'admin', collection: 'users_db' }, second._id);
	check('delete resolves a string, as the neDB client did', deleted === `${second._id} deleted`, deleted);
	check('a deleted document is no longer readable (nDB tombstone)',
		await db.getDoc({ db: 'admin', collection: 'users_db', query: { _id: second._id } }) === undefined);
	check('its sibling is untouched',
		(await db.getDocs({ db: 'admin', collection: 'users_db' })).length === 1);

	// ── Persistence ────────────────────────────────────────────────────────────────────────
	// A second client over the same root must see everything, including a delta `set` — the whole
	// point of writing through nDB rather than in memory.
	console.log('\npersistence');
	const reopened = createClient(ROOT);
	const seen = await reopened.getDoc({ db: 'admin', collection: 'users_db', query: { _id: inserted._id } });
	check('a fresh client reads the renamed document back from disk', seen?.email === 'new@b.c', JSON.stringify(seen));
	check('a delta `set` survives a reopen (dot-path write is durable)',
		(await reopened.getDoc({ db: 'collections', collection: 'x', query: { _id: nested._id } })).a.b === 9);
	check('the tombstone survives a reopen',
		await reopened.getDoc({ db: 'admin', collection: 'users_db', query: { _id: second._id } }) === undefined);

	// ── destroy / loadAll — the bootstrap and backup paths ─────────────────────────────────
	console.log('\ndestroy / loadAll');
	const listed = await db.loadAll();
	check('loadAll reports each db with its collections, named `<collection>.json` (nedb.js:227)',
		Array.isArray(listed.admin) && listed.admin.includes('users_db.json'), JSON.stringify(listed));
	const destroyed = await db.destroy('collections', 'x');
	check('destroy removes the documents', destroyed === 1, String(destroyed));
	check('destroy removes the collection folder from disk (neDB unlinked the file; index.js:484)',
		!fs.existsSync(path.join(ROOT, 'collections', 'x')));
	check('destroy evicts the handle, so a later write re-creates the collection',
		typeof (await db.add({ db: 'collections', collection: 'x' }, { fresh: true }))._id === 'string');

	// ── Refusals ───────────────────────────────────────────────────────────────────────────
	// The point of these is that a shape the old CMS never used must not be silently accepted: the
	// alternative to an error is a wrong result that looks right.
	console.log('\nrefusals');
	await rejects('a non-$set update operator is refused',
		() => db.update({ db: 'admin', collection: 'users_db', query: { _id: inserted._id } }, { $inc: { n: 1 } }));
	await rejects('an update with neither an _id nor multi is refused — neDB widened it and reported nothing',
		() => db.update({ db: 'admin', collection: 'users_db', query: { email: 'new@b.c' } }, { $set: { x: 1 } }));
	await rejects('an `_id` array mixed with other conditions is refused (idQuery silently dropped them)',
		() => db.getDocs({ db: 'admin', collection: 'users_db', query: { _id: [inserted._id], email: 'new@b.c' } }));
	await rejects('a multi-key sort is refused rather than silently ignored (nDB sorts by one field)',
		() => db.getDocs({ db: 'admin', collection: 'users_db', sort: { c_date: -1, name: 1 } }));
	await rejects('a projection mixing inclusion and exclusion is refused (an error in neDB too)',
		() => db.getDocs({ db: 'admin', collection: 'users_db', projection: { email: 1, password: 0 } }));

	// ── Report ─────────────────────────────────────────────────────────────────────────────
	console.log(`\n${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log(failures.map((f) => `  - ${f}`).join('\n'));
	}
	fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(1);
});
