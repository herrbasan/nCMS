// nCMS admin.
//
// Base: modules/nui_wc2/nui-boilerplate (copied, then adapted). The shell, the router wiring,
// the action delegation and the navigation data shape are the boilerplate's. Two deliberate
// differences:
//
//   1. The navigation comes from the API (collections) rather than a hard-coded array.
//   2. Content is produced by a registered route TYPE — `#col=<key>` — not a fragment page,
//      because a collection view is generated in JavaScript rather than fetched as HTML.

import { nui } from '/nui/nui.js';
import '/nui/lib/modules/nui-list.js';
import '/nui/lib/modules/nui-code-editor.js';

// ─── API ─────────────────────────────────────────────────────────────────────────────────────

async function api(method, url, body) {
	const response = await fetch(url, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const payload = await response.json();
	if (!payload.status) {
		throw Object.assign(new Error(payload.message), { code: payload.error, detail: payload.detail });
	}
	return payload.data;
}

const notify = (message, priority = 'info') =>
	nui.components.banner.show({ content: message, placement: 'bottom', priority });

const entryUrl = (key, id) =>
	`/api/collections/${encodeURIComponent(key)}/entries/${encodeURIComponent(id)}`;

const stamp = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// The collection the current route points at — `#col=<key>` — or null.
const routeKey = () => (location.hash.match(/^#col=(.+)$/) || [])[1] ?? null;

// ─── App actions ─────────────────────────────────────────────────────────────────────────────
// Only actions NUI does NOT already handle. `toggle-sidebar` is a built-in data-action handler;
// the boilerplate ALSO handles it in its own document-level switch, so it fires twice and
// cancels itself out. Everything NUI's table covers is left alone here.

document.addEventListener('click', (event) => {
	const actionEl = event.target.closest('[data-action]');
	if (!actionEl) return;

	const [name] = actionEl.dataset.action.split('@')[0].split(':');

	if (name === 'toggle-theme') {
		const root = document.documentElement;
		root.style.colorScheme = root.style.colorScheme === 'dark' ? 'light' : 'dark';
	}
});

// ─── State ───────────────────────────────────────────────────────────────────────────────────

let collections = [];

// The router CACHES a wrapper per route, so re-navigating to the same hash is a no-op and
// cannot be used to refresh. The active view therefore exposes its own reload, and every
// mutation calls it.
let activeView = null;

// ─── Rows ────────────────────────────────────────────────────────────────────────────────────
// Built with DOM calls rather than an HTML string: titles and snippets are content, so they
// must never be parsed as markup.

function buildRow(entry, key) {
	const row = document.createElement('div');
	row.className = 'cms-row';

	const main = document.createElement('div');
	main.className = 'cms-row-main';

	const title = document.createElement('div');
	title.className = 'cms-row-title';
	// A configured display field with no value is shown as such, not masked by the entry's name. The id
	// is still in the row's meta line, so the entry stays identifiable.
	if (entry.displayMissing) title.classList.add('cms-row-missing');
	title.textContent = entry.label;

	const snippet = document.createElement('div');
	snippet.className = 'cms-row-snippet';
	snippet.textContent = entry.snippet || '—';

	main.append(title, snippet);

	const meta = document.createElement('div');
	meta.className = 'cms-row-meta';
	meta.textContent = `${entry._id} · ${stamp(entry.m_date || entry.c_date)}`;

	row.append(main, meta);
	row.addEventListener('dblclick', () => openEditor(key, entry._id));
	return row;
}

// ─── The collection view ─────────────────────────────────────────────────────────────────────

async function loadEntries(key, pane) {
	const entries = await api('GET', `/api/collections/${encodeURIComponent(key)}/entries`);

	// Disconnecting runs cleanUp() in disconnectedCallback, so removing is the whole teardown —
	// calling cleanUp() here as well would clean an already-emptied component and throw.
	pane.querySelector('nui-list')?.remove();

	const list = document.createElement('nui-list');
	pane.append(list);

	list.loadData({
		// The label is what the row *shows*, so a missing display value reads as missing in the list and
		// is searchable by the same text rather than by a hidden fallback.
		data: entries.map((entry) => ({
			...entry,
			label: entry.displayMissing ? `no ${entry.displayMissing}` : (entry.title || entry._id)
		})),
		render: (entry) => buildRow(entry, key),
		search: [{ prop: 'label' }, { prop: '_id' }],
		sort: [
			{ label: 'Created — newest', prop: 'c_date', numeric: true, dir: 'desc' },
			{ label: 'Modified — newest', prop: 'm_date', numeric: true, dir: 'desc' },
			{ label: 'Title — A to Z', prop: 'label' }
		],
		sort_default: 0,
		footer: {
			buttons_left: [{ label: 'Delete', type: 'danger', fnc: () => deleteSelected(list, key) }],
			buttons_right: [{ label: 'New entry', type: 'primary', fnc: () => createEntry(key) }]
		}
	});
}

async function createEntry(key) {
	const { _id } = await api('POST', `/api/collections/${encodeURIComponent(key)}/entries`, {});
	await activeView?.reload();
	await openEditor(key, _id);
}

async function deleteSelected(list, key) {
	const selected = list.getSelection(true);
	if (!selected.length) {
		notify('Select an entry first — click a row.');
		return;
	}

	const confirmed = await nui.components.dialog.confirm(
		`Delete ${selected.length} ${selected.length === 1 ? 'entry' : 'entries'}?`,
		'They move to the trash. Nothing is destroyed until the trash is emptied.'
	);
	if (!confirmed) return;

	for (const row of selected) {
		await api('DELETE', entryUrl(key, row.data._id));
	}
	await activeView?.reload();
}

// ─── The raw editor ──────────────────────────────────────────────────────────────────────────
// Universal by design: it edits any document as text, so a collection is editable the moment
// its database exists. A specialised editor is an addition on top, never the only way in.

async function openEditor(key, id, source) {
	const text = source === undefined
		? JSON.stringify(await api('GET', entryUrl(key, id)), null, '\t')
		: source;

	const { main, result } = await nui.components.dialog.page(`Edit ${id}`, '', {
		contentScroll: true,
		buttons: [
			{ label: 'Cancel', type: 'outline', value: 'cancel' },
			{ label: 'Save', type: 'primary', value: 'save' }
		]
	});

	main.innerHTML = '<nui-code-editor data-lang="json"></nui-code-editor>';
	const editor = main.querySelector('nui-code-editor');
	editor.value = text;

	if ((await result) !== 'save') return;

	let doc;
	try {
		doc = JSON.parse(editor.value);
	} catch (error) {
		// Reopen with the author's text rather than refetching — a rejected save must not cost
		// them the edit.
		notify(`Not valid JSON — ${error.message}`, 'alert');
		return openEditor(key, id, editor.value);
	}

	await api('PUT', entryUrl(key, id), doc);
	await activeView?.reload();
}

// ─── Collections — the axis actions ─────────────────────────────────────────────────────────
// The plan calls for create / edit / delete on the Database axis, and the library's rowAction
// is the control for it — it was shipped for exactly this. The dialog is the old CMS's
// set-level editor: one row per collection, plus a blank row that adds one.

function parseLanguages(text) {
	return [...new Set(text.split(/[,\s]+/).map((code) => code.toLowerCase().trim()).filter(Boolean))];
}

function buildCollectionRow(collection) {
	const row = document.createElement('div');
	row.className = 'cms-collection-row';
	row.dataset.key = collection?.key ?? '';

	const name = document.createElement('input');
	name.type = 'text';
	name.className = 'cms-field cms-field-name';
	name.value = collection?.name ?? '';
	name.placeholder = collection ? '' : 'New collection name';
	name.setAttribute('aria-label', 'Collection name');

	const languages = document.createElement('input');
	languages.type = 'text';
	languages.className = 'cms-field cms-field-langs';
	languages.value = (collection?.languages ?? []).join(', ');
	languages.placeholder = 'en';
	languages.setAttribute('aria-label', 'Languages, comma separated');
	languages.title = 'Languages this collection is translatable into, comma separated';

	row.append(name, languages);

	// Only a collection that exists can be deleted. A row carried back after a rejected save has
	// no key yet — it is an uncommitted addition, and clearing its name is how you cancel it.
	if (!collection?.key) return row;

	const control = document.createElement('nui-button');
	control.setAttribute('variant', 'icon');
	const button = document.createElement('button');
	button.type = 'button';
	button.setAttribute('aria-label', `Delete ${collection.name}`);
	button.innerHTML = '<nui-icon name="delete"></nui-icon>';
	button.addEventListener('click', async () => {
		const confirmed = await nui.components.dialog.confirm(
			`Delete collection "${collection.name}"?`,
			'Its declaration is tombstoned and it leaves the axis. The folder and every document stay '
			+ 'on disk — nothing is destroyed, and the trash restores it.'
		);
		if (confirmed) row.remove();
	});
	control.append(button);
	row.append(control);
	return row;
}

const collectionUrl = (key) => `/api/collections/${encodeURIComponent(key)}`;

// A defined collection keeps its language set in `cms.languages`; only legacy collections keep one in
// the registry. The editor reads whichever is authoritative and never holds a second copy of it.
// One request per collection: the list endpoint deliberately does not carry definitions, because
// most screens do not need them.
async function readCollections() {
	const collections = await api('GET', '/api/collections');
	return Promise.all(collections.map(async (collection) => {
		const definition = await api('GET', `${collectionUrl(collection.key)}/definition`);
		return {
			...collection,
			definition,
			languages: definition ? definition.languages : (collection.translatability ?? [])
		};
	}));
}

// `state` carries the form across a rejected save, the same way the raw editor carries the
// author's text — a validation failure must never cost them the edit.
async function openCollectionsEditor(state) {
	const original = state?.original ?? await readCollections();
	const rowsState = state?.rows ?? original.map((c) => ({
		key: c.key, name: c.name, languages: c.languages
	}));

	const { main, result } = await nui.components.dialog.page('Collections', '', {
		contentScroll: true,
		buttons: [
			{ label: 'Cancel', type: 'outline', value: 'cancel' },
			{ label: 'Save', type: 'primary', value: 'save' }
		]
	});

	const rows = document.createElement('div');
	rows.className = 'cms-collections';
	for (const collection of rowsState) rows.append(buildCollectionRow(collection));
	rows.append(buildCollectionRow(null)); // the add row
	main.append(rows);

	if ((await result) !== 'save') return;

	const rowsNow = [...rows.querySelectorAll('.cms-collection-row')].map((row) => ({
		key: row.dataset.key || null,
		name: row.querySelector('.cms-field-name').value.trim(),
		languages: parseLanguages(row.querySelector('.cms-field-langs').value)
	}));

	for (const row of rowsNow) {
		if (!row.name) {
			if (row.key || row.languages.length) {
				notify('Every collection needs a name.', 'alert');
				return openCollectionsEditor({ rows: rowsNow, original });
			}
			continue; // a fully blank add row is simply not an addition
		}
		if (row.key && !row.languages.length) {
			notify(`"${row.name}" needs at least one language.`, 'alert');
			return openCollectionsEditor({ rows: rowsNow, original });
		}
	}

	// Only the differences are sent. The key is the identity, so a row's key never changes —
	// a rename is a change to `name`.
	const kept = new Map(rowsNow.filter((row) => row.key).map((row) => [row.key, row]));
	const deletions = original.filter((c) => !kept.has(c.key));
	const additions = rowsNow.filter((row) => !row.key && row.name);
	const renames = rowsNow.filter((row) => {
		const before = original.find((c) => c.key === row.key);
		return before && (before.name !== row.name
			|| JSON.stringify(before.languages) !== JSON.stringify(row.languages));
	});

	try {
		for (const collection of deletions) {
			await api('DELETE', collectionUrl(collection.key));
		}
		for (const row of additions) {
			// A collection created here carries a definition, so its languages live in one place from
			// the start rather than being copied into the registry as well.
			await api('POST', '/api/collections', { name: row.name, definition: { languages: row.languages } });
		}
		for (const row of renames) {
			const before = original.find((c) => c.key === row.key);
			// The definition is written first: it is the change that can be refused, and a refusal must
			// not leave a rename already applied.
			if (JSON.stringify(before.languages) !== JSON.stringify(row.languages)) {
				if (before.definition) {
					await api('PUT', `${collectionUrl(row.key)}/definition`,
						{ ...before.definition, languages: row.languages });
				} else {
					await api('PATCH', collectionUrl(row.key), { translatability: row.languages });
				}
			}
			if (before.name !== row.name) await api('PATCH', collectionUrl(row.key), { name: row.name });
		}
	} catch (error) {
		// A boundary failure (a colliding key, the server down) or a **refused definition change**.
		// Surface it and keep the form, so the edit is not lost.
		notify(`Not saved — ${error.message}`, 'alert');
		return openCollectionsEditor({ rows: rowsNow, original });
	}

	// The axis is derived from the collections, so it is rebuilt rather than patched.
	await loadNav();

	if (collections.some((c) => c.key === routeKey())) {
		await activeView?.reload();
	} else if (collections.length) {
		// The route pointed at a collection that is now gone. Moving the hash (not router.go)
		// is what makes the router see the navigation.
		location.hash = '#col=' + collections[0].key;
	} else {
		const empty = document.createElement('p');
		empty.className = 'cms-empty';
		empty.textContent = 'No collections. Use the gear on the Database row to add one.';
		document.querySelector('.cms-pane')?.replaceChildren(empty);
		activeView = null;
	}
}

// ─── Route type: a collection ────────────────────────────────────────────────────────────────
// ⚠️ A registered TYPE handler is called `(id, params, wrapper)` — the wrapper comes LAST,
// unlike a feature handler, which is `(wrapper, params)`.

nui.registerType('col', (id, params, wrapper) => {
	wrapper.innerHTML = '';

	// No page header: the collection IS the scope, and the scope already has a home on the
	// axis. The pane is the whole content region.
	const pane = document.createElement('div');
	pane.className = 'cms-pane';
	wrapper.append(pane);

	activeView = { reload: () => loadEntries(id, pane) };

	// The pane exists before the fetch, so a failure has somewhere visible to land instead of
	// vanishing into an unhandled promise.
	activeView.reload().catch((error) => {
		pane.textContent = `Could not load "${id}": ${error.message}`;
	});
});

// ─── Startup ─────────────────────────────────────────────────────────────────────────────────

async function loadNav() {
	collections = await api('GET', '/api/collections');

	// No `mode` on the list: nui-sidebar forces "fold" on its navigation list, and a sidebar's
	// list IS the navigation. (Setting "tree" here was the one real mistake in the first attempt.)
	const list = document.getElementById('main-navigation');
	list.loadData([
		{
			label: 'Database',
			icon: 'database',
			rowAction: { action: 'edit-collections', icon: 'settings', label: 'Edit collections' },
			items: collections.map((collection) => ({
				label: collection.name,
				href: '#col=' + collection.key,
				icon: 'folder'
			}))
		}
	]);

	// The row action is icon-only, and the library asks for a tooltip alongside it. The tooltip
	// host is position: fixed, so injecting it here adds nothing to the row's layout.
	const gear = list.querySelector('button.action');
	if (gear) {
		const tooltip = document.createElement('nui-tooltip');
		tooltip.textContent = 'Edit collections';
		gear.after(tooltip);
	}
}

nui.registerAction('edit-collections', () => openCollectionsEditor());

await loadNav();

// The navigation must exist before the router starts: on the initial route the router calls
// setActive() with an href, and there would be nothing to match.
nui.setupRouter({
	container: 'nui-content nui-main',
	navigation: 'nui-sidebar#nav-sidebar'
});

// No defaultPage — content is a route type, so the first collection is chosen explicitly.
// Setting the hash (rather than calling router.go) is deliberate: go() pushes state and does
// NOT fire hashchange, so the router would never see the navigation.
if (!location.hash.includes('=') && collections.length) {
	location.hash = '#col=' + collections[0].key;
}
