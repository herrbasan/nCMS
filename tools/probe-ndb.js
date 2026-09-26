'use strict';

// Checks the nDB behaviour this project's decisions rest on. Not a test suite — a **drift detector**.
//
//   node tools/probe-ndb.js
//
// It exists because several decisions in `docs/soft-schema-decision-brief.md` depend on facts that nDB's
// documentation states but nobody had run: that `meta.json`'s `schemas` block is inert, that a bucket is a
// directory inside one database, that a cross-database file read cannot work, and that there is no `close()`.
// Asserting those in prose makes them claims. Running them makes them evidence — and if nDB implements
// opt-in schema validation (`docs/database_evolution_plan.md` §2.3) this starts failing, which is exactly
// when nCMS should stop enforcing the schema itself.
//
// Touches nothing in the repository: everything happens in a fresh temp folder, which it prints and leaves
// in place for inspection.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Database } = require(path.join(__dirname, '..', 'modules', 'nDB', 'napi', 'index.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ndb-probe-'));
const checks = [];
const check = (name, expected, actual) => checks.push({ name, expected, actual, ok: expected === actual });

// ── 1. Is `meta.json`'s schema enforced? ──────────────────────────────────────────────────────
const alpha = path.join(root, 'alpha');
fs.mkdirSync(alpha, { recursive: true });
fs.writeFileSync(path.join(alpha, 'meta.json'), JSON.stringify({
	engine: 'ndb',
	version: 1,
	buckets: { avatars: { onDocumentDelete: 'restrict' } },
	schemas: { doc: { fields: { title: { type: 'string' }, avatar: { type: 'link' } } } }
}, null, 2));

const db = Database.open(path.join(alpha, 'data.jsonl'), { persistence: 'immediate' });

// Every declared constraint is violated: title is a number, avatar is not an nURI, extrafield is undeclared.
let wroteDespiteSchema = true;
try {
	const id = db.insert({ _type: 'doc', title: 12345, avatar: 'not a link at all', extra: 'undeclared' });
	wroteDespiteSchema = db.get(id).title === 12345;
} catch (error) {
	wroteDespiteSchema = false;
}
check('meta.json "schemas" block is inert (a violating write is accepted)'.padEnd(56), 'accepted', wroteDespiteSchema ? 'accepted' : 'rejected');

// ── 2. Buckets: where do the bytes go, and is dedup real? ────────────────────────────────────
const first = db.storeFile('avatars', 'face.png', Buffer.from('same-bytes'), 'image/png');
const second = db.storeFile('avatars', 'copy.png', Buffer.from('same-bytes'), 'image/png');
const insideDatabase = fs.existsSync(path.join(alpha, '_files', 'avatars', `${first._file.id}.${first._file.ext}`));
check('a bucket is a directory INSIDE the database folder', 'inside', insideDatabase ? 'inside' : 'elsewhere');
check('identical bytes deduplicate to one file', 'yes', second._file.id === first._file.id ? 'yes' : 'no');

// ── 3. Can another database resolve a reference into the first? ──────────────────────────────
const beta = path.join(root, 'beta');
fs.mkdirSync(beta, { recursive: true });
const other = Database.open(path.join(beta, 'data.jsonl'), { persistence: 'immediate' });
let crossDatabase = 'read';
try {
	other.getFile('avatars', first._file.id, first._file.ext);
} catch (error) {
	crossDatabase = 'threw';
}
check('a second database cannot read the first\'s file', 'threw', crossDatabase);

// ── 4. Does a database need meta.json to open? ───────────────────────────────────────────────
const gamma = path.join(root, 'gamma');
Database.open(path.join(gamma, 'data.jsonl'), { persistence: 'immediate' }).insert({ hello: 'no meta.json' });
check('open() works without meta.json and does not create one', 'no meta.json',
	fs.existsSync(path.join(gamma, 'meta.json')) ? 'created one' : 'no meta.json');

// ── 5. Is there a lifecycle method? ──────────────────────────────────────────────────────────
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(db));
const lifecycle = methods.filter((name) => /^(close|destroy|dispose)$/.test(name));
check('Database exposes no close()/destroy()/dispose()', 'none', lifecycle.length ? lifecycle.join(', ') : 'none');

// ── Report ───────────────────────────────────────────────────────────────────────────────────
console.log(`nDB behaviour probe — ${methods.length} Database methods on the pinned build\n`);
for (const { name, expected, actual, ok } of checks) {
	console.log(`${ok ? ' ok ' : 'DRIFT'}  ${name}  →  ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const drifted = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - drifted.length}/${checks.length} as the brief assumes.`);
if (drifted.length) {
	console.log('nDB behaviour has changed — the decisions that rest on these facts need revisiting,');
	console.log('and any schema nCMS enforces itself may now belong to nDB.');
}
console.log(`\ntemp folder left for inspection: ${root}`);
process.exitCode = drifted.length ? 1 : 0;
