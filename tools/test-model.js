'use strict';

// Proves the proposed data model end to end, over the real HTTP API, in its **own** collection.
// It touches no existing collection, migrates nothing, uses no media bytes and changes no dependency.
//
//   node server.js            # in one terminal
//   node tools/test-model.js
//
// What it proves, in order:
//   1. a collection can carry a definition — languages, body policy, display field, field kinds —
//      stored in the collection's own `meta.json` next to nDB's keys, not in the registry (D1);
//   2. one bilingual entry with shared facts, per-language facts and whole MD-Blocks documents
//      saves, reopens and raw-edits through the existing API;
//   3. a definition change that would make an existing value unreadable is refused **in whole**, and
//      neither the definition nor the entry data changes (D3a);
//   4. changes that leave every value readable apply;
//   5. re-declaring a retired field is refused when the values left behind are unreadable under the
//      new declaration — the same rule, applied to free JSON.
//
// Re-runnable. It manages its own entry by name and never deletes the collection.

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.NCMS_API || 'http://localhost:3300/api';
const COLLECTION = 'model-test';
const COLLECTION_NAME = 'Model test';
const ENTRY_NAME = 'Westenergie Web APP';

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

const collectionRoute = () => `/collections/${encodeURIComponent(COLLECTION)}`;
const entryRoute = (id) => `${collectionRoute()}/entries/${encodeURIComponent(id)}`;

const definitionFile = () => path.join(__dirname, '..', 'data', COLLECTION, 'meta.json');

async function definition() {
	return (await call('GET', `${collectionRoute()}/definition`)).payload.data;
}

async function putDefinition(next) {
	const response = await call('PUT', `${collectionRoute()}/definition`, next);
	return { status: response.status, payload: response.payload };
}

/** A refusal must leave both the definition and the entry exactly as they were. */
async function refuses(label, next, entryBefore, code) {
	const definitionBefore = show(await definition());
	const result = await putDefinition(next);
	const detail = result.payload.detail ?? {};
	const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : [];
	const unchangedDefinition = show(await definition()) === definitionBefore;
	const unchangedEntry = show((await call('GET', entryRoute(ENTRY_ID))).payload.data) === entryBefore;

	check(`${label} → refused`, result.status === 409 && result.payload.error === code,
		`${result.status} ${result.payload.error ?? ''}`);
	check(`${label} → names the conflicts`, conflicts.length > 0 && conflicts.every((c) => c.entry && c.field && c.code),
		show(conflicts.slice(0, 2)));
	check(`${label} → definition unchanged`, unchangedDefinition);
	check(`${label} → entry data unchanged`, unchangedEntry);
}

let ENTRY_ID = null;

// ─── Run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
	const ping = await fetch(`${API}/collections`).catch(() => null);
	if (!ping) {
		console.error(`Cannot reach ${API}. Start the server first: node server.js`);
		process.exitCode = 1;
		return;
	}

	// 1. The collection, with its definition.
	const existing = (await call('GET', '/collections')).payload.data.find((c) => c.key === COLLECTION);
	if (!existing) {
		const created = await call('POST', '/collections', {
			key: COLLECTION, name: COLLECTION_NAME, definition: DEFINITION
		});
		check('collection created with a definition', created.payload.status === true, show(created.payload));
	} else {
		console.log(` ok   collection "${COLLECTION}" already exists`);
	}

	// Start from a known state: our own entries only, so the baseline definition always applies.
	for (const entry of (await call('GET', `${collectionRoute()}/entries`)).payload.data) {
		if (entry.title === ENTRY_NAME) await call('DELETE', entryRoute(entry._id));
	}
	const baseline = await putDefinition(DEFINITION);
	check('baseline definition applies', baseline.status === 200, show(baseline.payload));

	const onDisk = JSON.parse(fs.readFileSync(definitionFile(), 'utf8'));
	check('definition lives in the collection\'s own meta.json', onDisk.cms?.languages?.join() === 'en,de');
	check('nDB\'s own keys are preserved beside it',
		Object.prototype.hasOwnProperty.call(onDisk, 'version'), Object.keys(onDisk).join(', '));

	// 2. Save one bilingual entry.
	const createdEntry = await call('POST', `${collectionRoute()}/entries`, ENTRY);
	ENTRY_ID = createdEntry.payload.data?._id;
	check('bilingual entry created', typeof ENTRY_ID === 'string', show(createdEntry.payload));

	// 3. Reopen it.
	const reopened = (await call('GET', entryRoute(ENTRY_ID))).payload.data;
	check('shared facts round-trip', show(reopened.facts.customer) === '"Westenergie"'
		&& reopened.facts.cover === ENTRY.facts.cover && reopened.facts.year === 2021);
	check('per-language title round-trips',
		reopened.facts.title.en === 'Westenergie Web APP' && reopened.facts.title.de === 'Westenergie Web-App');
	check('per-language audio references round-trip',
		reopened.facts.audio.en.startsWith('media/') && reopened.facts.audio.de.startsWith('media/'));
	check('both whole documents round-trip',
		reopened.docs.en === ENTRY.docs.en && reopened.docs.de === ENTRY.docs.de);
	check('the documents are whole MD-Blocks sources',
		reopened.docs.en.startsWith('<!-- mb:main -->') && reopened.docs.en.includes('<!-- mb:/columns -->'));

	// 4. Raw-edit the whole entry, as the universal floor does.
	const rawEdited = {
		...reopened,
		facts: { ...reopened.facts, title: { ...reopened.facts.title, de: 'Westenergie Web-App (überarbeitet)' } },
		docs: { ...reopened.docs, de: reopened.docs.de.replace('# Ansichten', '# Ansichten (neu)') }
	};
	const saved = await call('PUT', entryRoute(ENTRY_ID), rawEdited);
	check('raw edit saves', saved.payload.status === true, show(saved.payload));
	const afterEdit = (await call('GET', entryRoute(ENTRY_ID))).payload.data;
	check('raw edit landed in the German values',
		afterEdit.facts.title.de === 'Westenergie Web-App (überarbeitet)' && afterEdit.docs.de.includes('# Ansichten (neu)'));
	check('raw edit left the shared and English values untouched',
		afterEdit.facts.title.en === 'Westenergie Web APP' && afterEdit.docs.en === ENTRY.docs.en
		&& afterEdit.facts.customer === 'Westenergie');

	const entryBefore = show(afterEdit);

	// 5. Conflicting definition changes are refused, and change nothing.
	const held = await definition();
	const withField = (fields) => ({ ...held, fields });

	await refuses('title → shared (the value is a language map)',
		withField({ ...held.fields, title: { kind: 'shared' } }), entryBefore, 'definition_conflict');
	await refuses('customer → per-language (the value is a scalar)',
		withField({ ...held.fields, customer: { kind: 'per-language' } }), entryBefore, 'definition_conflict');
	await refuses('removing German (entries hold German content)',
		{ ...held, languages: ['en'] }, entryBefore, 'definition_conflict');

	// 6. Non-conflicting changes apply.
	const displayChange = await putDefinition({ ...held, display: 'title' });
	check('display field change applies (a projection, not a reinterpretation)', displayChange.status === 200);

	const addedField = await putDefinition({ ...held, display: 'title', fields: { ...held.fields, subtitle: { kind: 'per-language' } } });
	check('adding a field with no existing values applies', addedField.status === 200);

	const addedLanguage = await putDefinition({ ...addedField.payload.data, languages: ['en', 'de', 'fr'] });
	check('adding a language applies', addedLanguage.status === 200 && addedLanguage.payload.data.languages.includes('fr'));

	const { customer, ...withoutCustomer } = addedLanguage.payload.data.fields;
	const retired = await putDefinition({ ...addedLanguage.payload.data, fields: withoutCustomer });
	check('retiring a declared field applies and touches no data', retired.status === 200);
	check('the retired field\'s value is still there as free JSON',
		(await call('GET', entryRoute(ENTRY_ID))).payload.data.facts.customer === 'Westenergie');

	// 7. Re-declaring it is judged by the same rule.
	await refuses('re-declaring the retired field as per-language (string ≠ map)',
		{ ...retired.payload.data, fields: { ...withoutCustomer, customer: { kind: 'per-language' } } },
		entryBefore, 'definition_conflict');

	// 8. And it applies when declared to match what is already there.
	const restored = await putDefinition({ ...retired.payload.data, fields: { ...withoutCustomer, customer: { kind: 'shared' } } });
	check('re-declaring it as shared applies (the value is readable)', restored.status === 200);

	console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}  `
		+ `(collection "${COLLECTION}", entry ${ENTRY_ID})`);
	process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
	console.error(`\ntest-model failed: ${error.stack ?? error.message}`);
	process.exitCode = 1;
});
