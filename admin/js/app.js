// nCMS admin — the shell and one screen, end to end.
//
// One interaction, everywhere: a scope axis on the left (nui-link-list) and the WHOLE of that
// scope in a single virtualized list on the right (nui-list). Sorting, filtering and search
// operate on data already in the client, so there is no paging anywhere — narrowing replaces
// navigating. The screen is a composition of two library components, not a new design.

const nui = window.nui;

await nui.ready();

const axis = document.querySelector('#axis');
const pane = document.querySelector('#pane');
const scope = document.querySelector('#scope');
const count = document.querySelector('#count');

let collections = [];
let current = null;
let list = null;

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

function notify(message, priority = 'info') {
	nui.components.banner.show({ content: message, placement: 'bottom', priority });
}

const entryUrl = (id) =>
	`/api/collections/${encodeURIComponent(current)}/entries/${encodeURIComponent(id)}`;

const keyOf = (href) =>
	typeof href === 'string' && href.startsWith('#col=') ? href.slice('#col='.length) : null;

const stamp = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// Single click selects, double click opens — the same gesture the old admin used, kept
// because it reads naturally in a virtualized list where each row is also a selection target.
function renderRow(entry) {
	const row = document.createElement('div');
	row.className = 'admin-row';

	const main = document.createElement('div');
	main.className = 'admin-row-main';

	const title = document.createElement('div');
	title.className = 'admin-row-title';
	title.textContent = entry.label;

	const snippet = document.createElement('div');
	snippet.className = 'admin-row-snippet';
	snippet.textContent = entry.snippet || '—';

	main.append(title, snippet);

	const meta = document.createElement('div');
	meta.className = 'admin-row-meta';
	meta.textContent = `${entry._id} · ${stamp(entry.m_date || entry.c_date)}`;

	row.append(main, meta);
	row.addEventListener('dblclick', () => openEditor(entry._id));
	return row;
}

async function selectCollection(key) {
	current = key;
	const meta = collections.find((c) => c.key === key);
	scope.textContent = meta ? meta.name : key;

	const entries = await api('GET', `/api/collections/${encodeURIComponent(key)}/entries`);
	count.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;

	if (list) {
		// Disconnecting runs cleanUp() in disconnectedCallback, so calling it here too would
		// clean an already-emptied component and throw. One teardown, and the component owns it.
		list.remove();
	}

	list = document.createElement('nui-list');
	pane.append(list);
	list.loadData({
		// The API keeps `title` nullable; the row label is a display concern, resolved here.
		data: entries.map((entry) => ({ ...entry, label: entry.title || entry._id })),
		render: renderRow,
		search: [{ prop: 'label' }, { prop: '_id' }],
		sort: [
			{ label: 'Created — newest', prop: 'c_date', numeric: true, dir: 'desc' },
			{ label: 'Modified — newest', prop: 'm_date', numeric: true, dir: 'desc' },
			{ label: 'Title — A to Z', prop: 'label' }
		],
		sort_default: 0,
		footer: {
			buttons_left: [{ label: 'Delete', type: 'danger', fnc: deleteSelected }],
			buttons_right: [{ label: 'New entry', type: 'primary', fnc: createEntry }]
		}
	});
}

// The raw editor is the universal one: it edits any document as text, so a collection is
// usable the moment its database exists. A specialised editor is an addition on top of this,
// never the only way in.
async function openEditor(id, source) {
	const text = source === undefined
		? JSON.stringify(await api('GET', entryUrl(id)), null, '\t')
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
	} catch (err) {
		// Reopen with the author's text rather than refetching — a rejected save must not
		// cost them the edit.
		notify(`Not valid JSON — ${err.message}`, 'alert');
		return openEditor(id, editor.value);
	}

	await api('PUT', entryUrl(id), doc);
	notify(`Saved ${id}.`);
	await selectCollection(current);
}

async function createEntry() {
	const { _id } = await api('POST', `/api/collections/${encodeURIComponent(current)}/entries`, {});
	await selectCollection(current);
	await openEditor(_id);
}

async function deleteSelected() {
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
		await api('DELETE', entryUrl(row.data._id));
	}
	notify(`Deleted ${selected.length}.`);
	await selectCollection(current);
}

collections = await api('GET', '/api/collections');

axis.loadData([{
	label: 'Collections',
	icon: 'folder',
	items: collections.map((c) => ({ label: c.name, href: '#col=' + c.key, icon: 'folder' }))
}]);

axis.addEventListener('nui-active-change', (event) => {
	const key = keyOf(event.detail && event.detail.href);
	if (key) selectCollection(key);
});

// The first collection is opened through the same path as a click, so there is one way in.
if (collections.length) {
	axis.setActive(axis.querySelector(`a[href="#col=${collections[0].key}"]`));
}
