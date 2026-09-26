'use strict';

// Proves the proposed data model end to end, over the real HTTP API, in its **own** collection.
// It touches no existing collection, migrates nothing, uses no media bytes and changes no dependency.
//
//   node server.js            # in one terminal
//   node tools/test-model.js
//
// What it proves, in order:
//   1. for a collection **with a definition**, `cms.languages` in its own `meta.json` is the single
//      authority — the registry carries no language list for it. Legacy collections are untouched.
//   2. one bilingual entry with shared facts, per-language facts and whole MD-Blocks documents
//      saves, reopens and raw-edits through the existing API;
//   3. the declared structure is enforced on entry **saves**, without a typed schema, and a missing
//      translation is always allowed;
//   4. the declared display field drives the list label;
//   5. a definition change is refused, in whole, whenever it would reinterpret values already there —
//      judged by what the definition *declares*, never by inspecting a value's shape;
//   6. the body policy is checked against existing entries, and a document variant must be text;
//   7. an invalid definition is rejected *before* a collection is created for it;
//   8. writing the definition is atomic, so a failure cannot leave it truncated; and a configured
//      display field with no value is reported as missing rather than masked by the entry's name.
//
// Re-runnable. It manages its own entries by name and never deletes its collection.

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.NCMS_API || 'http://localhost:3300/api';
const COLLECTION = 'model-test';
const COLLECTION_NAME = 'Model test';
const ENTRY_NAME = 'Westenergie Web APP';
const INVALID_KEY = 'model-test-invalid';

const DEFINITION = {
	languages: ['en', 'de'],
	body: 'optional',
	display: 'name',
	fields: {
		customer: { kind: 'shared' },
		year: { kind: 'shared' },
		cover: { kind: 'shared' },
		title: { kind: 'per-language' },
		audio: { kind: 'per-language' }
	}
};

const COLUMNS = [
	'<!-- mb:columns label="3 Media Columns" -->',
	'<!-- mb:col -->',
	'![Screenshot 01](media/IsFI4SLnOrI8npka/westenergie_webapp.mp4_snap_00001.png)',
	'<!-- mb:col -->',
	'![Screenshot 08](media/DLWtawgF6PCBlBfs/westenergie_webapp.mp4_snap_00008.png)',
	'<!-- mb:col -->',
	'![Screenshot 09](media/smxH2cuKzlur008C/westenergie_webapp.mp4_snap_00009.png)',
	'<!-- mb:/columns -->'
].join('\n');

const ENTRY = {
	name: ENTRY_NAME,
	slug: 'westenergie-web-app',
	facts: {
		customer: 'Westenergie',
		year: 2021,
		cover: 'media/znLiGMaZF3pvwS8t/westenergie_webapp.mp4_snap_00007.png',
		title: { en: 'Westenergie Web APP', de: 'Westenergie Web-App' },
		audio: {
			en: 'media/aa11bb22ccddeeff/westenergie-en.mp3',
			de: 'media/ff11ee22ddccbbaa/westenergie-de.mp3'
		}
	},
	docs: {
		en: `<!-- mb:main -->\n\n<!-- mb:block label="Headline" -->\n# Screenshots\n<!-- mb:/block -->\n\n${COLUMNS}\n`,
		de: `<!-- mb:main -->\n\n<!-- mb:block label="Headline" -->\n# Ansichten\n<!-- mb:/block -->\n\n${COLUMNS}\n`
	}
};

// ─── Harness ─────────────────────────────────────────────────────────────────────────────────

let failures = 0;
function check(label, ok, detail) {
	console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  — ${detail}`}`);
	if (!ok) failures++;
}
const show = (value) => JSON.stringify(value);

async function call(method, route, body) {
	const response = await fetch(API + route, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, payload: await response.json() };
}

const collectionUrl = (key) => `/collections/${encodeURIComponent(key)}`;
const collectionRoute = () => collectionUrl(COLLECTION);
const entryRoute = (id) => `${collectionRoute()}/entries/${encodeURIComponent(id)}`;
const definitionFile = (key = COLLECTION) => path.join(__dirname, '..', 'data', key, 'meta.json');

const definition = async () => (await call('GET', `${collectionRoute()}/definition`)).payload.data;
const putDefinition = async (next) => {
	const response = await call('PUT', `${collectionRoute()}/definition`, next);
	return { status: response.status, payload: response.payload };
};
const readEntry = async () => (await call('GET', entryRoute(ENTRY_ID))).payload.data;
const saveEntry = async (doc) => call('PUT', entryRoute(ENTRY_ID), doc);

/** A refusal must leave both the definition and the entry exactly as they were. */
async function refuses(label, next, entryBefore, expected) {
	const definitionBefore = show(await definition());
	const result = await putDefinition(next);
	const conflicts = result.payload.detail?.conflicts ?? [];

	check(`${label} → refused`, result.status === 409 && result.payload.error === 'definition_conflict',
		`${result.status} ${result.payload.error ?? ''}`);
	check(`${label} → names the conflicts`,
		conflicts.length > 0 && conflicts.every((c) => c.entry && c.field && c.code), show(conflicts.slice(0, 2)));
	if (expected) check(`${label} → conflict code "${expected}"`, conflicts.some((c) => c.code === expected),
		show(conflicts.map((c) => c.code)));
	check(`${label} → definition unchanged`, show(await definition()) === definitionBefore);
	check(`${label} → entry data unchanged`, show(await readEntry()) === entryBefore);
}

/** A rejected entry save must change nothing either. */
async function rejectsEntry(label, doc, expected) {
	const before = show(await readEntry());
	const result = await saveEntry(doc);
	const problems = result.payload.detail?.problems ?? [];

	check(`${label} → rejected`, result.status === 400 && result.payload.error === 'invalid_entry',
		`${result.status} ${result.payload.error ?? ''}`);
	check(`${label} → problem code "${expected}"`, problems.some((p) => p.code === expected), show(problems));
	check(`${label} → entry unchanged`, show(await readEntry()) === before);
}

let ENTRY_ID = null;

// ─── Run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
	if (!(await fetch(`${API}/collections`).catch(() => null))) {
		console.error(`Cannot reach ${API}. Start the server first: node server.js`);
		process.exitCode = 1;
		return;
	}

	// 1. The collection, created **with** a definition, so its languages live in one place.
	const listed = async () => (await call('GET', '/collections')).payload.data;
	if ((await listed()).some((c) => c.key === COLLECTION)) {
		// The test owns this collection and starts it empty. Re-creating the declaration also clears a
		// `translatability` record left by an implementation that kept a second language list in the
		// registry — residue that would otherwise make the next check untestable. Nothing is destroyed:
		// deletion is a tombstone and the folder is untouched.
		//
		// Entries are matched by nothing, not by their label: a previous run can leave the display
		// field pointing at a different field, so a label-based cleanup silently misses them.
		for (const entry of (await call('GET', `${collectionRoute()}/entries`)).payload.data) {
			await call('DELETE', entryRoute(entry._id));
		}
		await call('DELETE', collectionUrl(COLLECTION));
	}
	const created = await call('POST', '/collections', {
		key: COLLECTION, name: COLLECTION_NAME, definition: DEFINITION
	});
	check('collection created with a definition', created.payload.status === true, show(created.payload));
	check('the registry carries no language list for a defined collection',
		(await listed()).find((c) => c.key === COLLECTION)?.translatability === undefined);
	check('baseline definition applies', (await putDefinition(DEFINITION)).status === 200);

	const onDisk = JSON.parse(fs.readFileSync(definitionFile(), 'utf8'));
	check('the definition lives in the collection\'s own meta.json', onDisk.cms?.languages?.join() === 'en,de');
	check('nDB\'s own keys are preserved beside it', Object.prototype.hasOwnProperty.call(onDisk, 'version'),
		Object.keys(onDisk).join(', '));

	// 2. An invalid definition is rejected before a collection exists for it.
	const stale = (await listed()).find((c) => c.key === INVALID_KEY);
	if (stale) await call('DELETE', collectionUrl(INVALID_KEY));
	const bad = await call('POST', '/collections', {
		key: INVALID_KEY, name: 'Bad', definition: { languages: ['en'], body: 'sometimes' }
	});
	check('an invalid definition is rejected', bad.status === 400 && bad.payload.error === 'invalid_definition',
		show(bad.payload));
	check('and no collection is created for it', !(await listed()).some((c) => c.key === INVALID_KEY));

	// 3. Save one bilingual entry.
	ENTRY_ID = (await call('POST', `${collectionRoute()}/entries`, ENTRY)).payload.data?._id;
	check('bilingual entry created', typeof ENTRY_ID === 'string', ENTRY_ID);

	// 4. Reopen it.
	const reopened = await readEntry();
	check('shared facts round-trip', reopened.facts.customer === 'Westenergie' && reopened.facts.year === 2021
		&& reopened.facts.cover === ENTRY.facts.cover);
	check('per-language title round-trips',
		reopened.facts.title.en === 'Westenergie Web APP' && reopened.facts.title.de === 'Westenergie Web-App');
	check('per-language audio references round-trip',
		reopened.facts.audio.en.startsWith('media/') && reopened.facts.audio.de.startsWith('media/'));
	check('both whole documents round-trip', reopened.docs.en === ENTRY.docs.en && reopened.docs.de === ENTRY.docs.de);
	check('a missing translation is allowed', !('fr' in reopened.docs) && !('fr' in reopened.facts.title));

	// 5. Raw-edit the whole entry, as the universal floor does.
	await saveEntry({
		...reopened,
		facts: { ...reopened.facts, title: { ...reopened.facts.title, de: 'Westenergie Web-App (überarbeitet)' } },
		docs: { ...reopened.docs, de: reopened.docs.de.replace('# Ansichten', '# Ansichten (neu)') }
	});
	const edited = await readEntry();
	check('raw edit landed in the German values',
		edited.facts.title.de === 'Westenergie Web-App (überarbeitet)' && edited.docs.de.includes('# Ansichten (neu)'));
	check('raw edit left the shared and English values untouched',
		edited.facts.title.en === 'Westenergie Web APP' && edited.docs.en === ENTRY.docs.en
		&& edited.facts.customer === 'Westenergie');

	let held = await definition();
	// A builder, not a caller: `refuses` sends this *as the definition*, so it must be the definition
	// object — passing an awaited `putDefinition(...)` result here would send `{status, payload}`.
	const withKind = (field, kind) => ({ ...held, fields: { ...held.fields, [field]: { kind } } });
	const entryBefore = show(await readEntry());

	// 6. Refusals — judged from the declaration, never by inspecting a value.
	await refuses('title → shared (values already exist)', withKind('title', 'shared'), entryBefore,
		'declaration_over_values');
	await refuses('customer → per-language (values already exist)', withKind('customer', 'per-language'),
		entryBefore, 'declaration_over_values');
	await refuses('removing German (entries hold German content)',
		{ ...held, languages: ['en'] }, entryBefore, 'language_in_use');

	// 7. Applies.
	const displayChange = await putDefinition({ ...held, display: 'customer' });
	check('changing the display field applies (a projection)', displayChange.status === 200);
	held = await definition();

	const added = await putDefinition({ ...held, fields: { ...held.fields, credit: { kind: 'shared' } } });
	check('adding a field with no values applies', added.status === 200);
	held = await definition();

	const withFrench = await putDefinition({ ...held, languages: ['en', 'de', 'fr'] });
	check('adding a language applies', withFrench.status === 200 && withFrench.payload.data.languages.includes('fr'));
	held = await definition();

	// 8. The declared display field drives the list label.
	const label = (await call('GET', `${collectionRoute()}/entries`)).payload.data.find((e) => e._id === ENTRY_ID)?.title;
	check('the display field drives the list label', label === 'Westenergie',
		`title = ${show(label)} (name is ${show(ENTRY_NAME)})`);

	// 8b. A configured display field with no value is reported as missing, never masked by the name.
	const missing = await putDefinition({ ...held, display: 'credit' });
	check('pointing the display field at a field with no value applies', missing.status === 200, show(missing.payload));
	const row = (await call('GET', `${collectionRoute()}/entries`)).payload.data.find((e) => e._id === ENTRY_ID);
	check('the missing label is explicit, not the entry name',
		row.title === null && row.displayMissing === 'credit', show(row));
	check('and the entry id is still available', row._id === ENTRY_ID);
	check('the display field restores', (await putDefinition({ ...missing.payload.data, display: 'customer' })).status === 200);
	held = await definition();

	// 9. A shared field may hold arbitrary JSON — including an object keyed by language codes, which
	// is exactly what key-name guessing would have misread as a language map.
	const withCredit = await readEntry();
	withCredit.facts = { ...withCredit.facts, credit: { en: 'Sound Design', de: 'Klangdesign' } };
	const creditSave = await saveEntry(withCredit);
	check('a shared object with en/de keys saves', creditSave.payload.status === true, show(creditSave.payload));
	// Compared by value: nDB stores object keys sorted, so `en`/`de` come back in a different order
	// than they were written and a string comparison would fail on an intact value.
	const credit = (await readEntry()).facts.credit;
	check('and comes back uninterpreted',
		credit?.en === 'Sound Design' && credit?.de === 'Klangdesign' && Object.keys(credit).length === 2,
		show(credit));
	await refuses('credit → per-language (the declared kind cannot change over values)',
		withKind('credit', 'per-language'), show(await readEntry()), 'declaration_over_values');

	// 10. Undeclared free JSON is allowed, and declaring it later is refused rather than guessed at.
	const withUndeclared = await readEntry();
	withUndeclared.facts = { ...withUndeclared.facts, unofficial: 'written before any declaration' };
	await saveEntry(withUndeclared);
	check('undeclared free JSON is preserved',
		(await readEntry()).facts.unofficial === 'written before any declaration');
	const declaredNow = await definition();
	await refuses('declaring a field that already holds undeclared values',
		{ ...declaredNow, fields: { ...declaredNow.fields, unofficial: { kind: 'shared' } } },
		show(await readEntry()), 'declaration_over_values');

	// 11. The declared structure is enforced on saves.
	held = await definition();
	await rejectsEntry('docs."it" (a language the definition does not declare)',
		{ ...(await readEntry()), docs: { ...(await readEntry()).docs, it: '<!-- mb:main -->\n' } }, 'undeclared_language');
	await rejectsEntry('facts.title as a string (declared per-language)',
		{ ...(await readEntry()), facts: { ...(await readEntry()).facts, title: 'a plain string' } }, 'not_a_language_map');
	await rejectsEntry('facts.audio keyed by an undeclared language',
		{ ...(await readEntry()), facts: { ...(await readEntry()).facts, audio: { en: 'media/x.mp3', it: 'media/y.mp3' } } },
		'undeclared_language');

	// A document variant is text. A number, object or null is never a Markdown document, and saying so
	// needs no parser.
	await rejectsEntry('docs.en as a number',
		{ ...(await readEntry()), docs: { ...(await readEntry()).docs, en: 42 } }, 'not_a_document');
	await rejectsEntry('docs.en as null',
		{ ...(await readEntry()), docs: { ...(await readEntry()).docs, en: null } }, 'not_a_document');
	await rejectsEntry('docs.de as an object',
		{ ...(await readEntry()), docs: { ...(await readEntry()).docs, de: { text: 'not a document' } } }, 'not_a_document');

	// 12. Retiring a field touches no data, and re-declaring it is the same rule as adding one.
	const { customer, ...withoutCustomer } = held.fields;
	const retired = await putDefinition({ ...held, fields: withoutCustomer });
	check('retiring a declared field applies and touches no data',
		retired.status === 200 && (await readEntry()).facts.customer === 'Westenergie');
	check('the retired field\'s value is still the display label',
		(await call('GET', `${collectionRoute()}/entries`)).payload.data.find((e) => e._id === ENTRY_ID)?.title === 'Westenergie');
	await refuses('re-declaring the retired field (its values still exist)',
		{ ...retired.payload.data, fields: { ...withoutCustomer, customer: { kind: 'shared' } } },
		show(await readEntry()), 'declaration_over_values');

	// 13. The body policy is checked against existing entries before it is applied.
	held = await definition();
	await refuses('body → none while a document exists', { ...held, body: 'none' },
		show(await readEntry()), 'body_not_allowed');

	// An entry with no document is legal while the policy is `optional`…
	const noBody = await call('POST', `${collectionRoute()}/entries`, {
		name: 'No document', slug: 'no-document', facts: { customer: 'Nobody' }
	});
	check('an entry without a document is legal under "optional"', noBody.payload.status === true, show(noBody.payload));

	// …so requiring one now would invalidate it the moment it landed.
	await refuses('body → required while an entry has no document', { ...held, body: 'required' },
		show(await readEntry()), 'body_required');

	// With nothing lacking a document, it applies — and applies again in reverse.
	await call('DELETE', entryRoute(noBody.payload.data._id));
	const required = await putDefinition({ ...held, body: 'required' });
	check('body → required applies once every entry has one', required.status === 200, show(required.payload));
	const optionalAgain = await putDefinition({ ...required.payload.data, body: 'optional' });
	check('and back to optional applies', optionalAgain.status === 200, show(optionalAgain.payload));

	// 14. The definition file is always parseable and no temporary is left behind.
	let parses = true;
	try {
		JSON.parse(fs.readFileSync(definitionFile(), 'utf8'));
	} catch {
		parses = false;
	}
	check('the definition file parses', parses);
	check('no temporary definition file is left behind', !fs.existsSync(definitionFile() + '.tmp'));

	// 15. Legacy collections are untouched: registry languages, no definition, old label heuristic.
	const registry = await listed();
	const writing = registry.find((c) => c.key === 'writing');
	check('a legacy collection keeps its registry language list', Array.isArray(writing?.translatability),
		show(writing?.translatability));
	check('a legacy collection has no definition file', !fs.existsSync(definitionFile('writing')));
	check('a legacy collection\'s label still comes from the old heuristic',
		(await call('GET', '/collections/writing/entries')).payload.data.some((e) => e.title === 'Hello nCMS'));

	console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}  `
		+ `(collection "${COLLECTION}", entry ${ENTRY_ID})`);
	process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
	console.error(`\ntest-model failed: ${error.stack ?? error.message}`);
	process.exitCode = 1;
});
