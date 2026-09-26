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
		data: entries.map((entry) => ({ ...entry, label: entry.title || entry._id })),
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
	notify(`Deleted ${selected.length}.`);
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
	notify(`Saved ${id}.`);
	await activeView?.reload();
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

collections = await api('GET', '/api/collections');

// No `mode` on the list: nui-sidebar forces "fold" on its navigation list, and a sidebar's
// list IS the navigation. (Setting "tree" here was the one real mistake in the first attempt.)
document.getElementById('main-navigation').loadData(collections.map((collection) => ({
	label: collection.name,
	href: '#col=' + collection.key,
	icon: 'folder'
})));

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
