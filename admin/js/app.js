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
import { connectFeed } from './events.js';

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

// Failures only. The axis and the list are the feedback for everything else — a banner is reserved for what
// the DOM cannot show on its own. It closes itself, because a notification that has to be dismissed is a
// modal in disguise.
//
// Since the notification store arrived, a banner is no longer *only* transient: `banner.show()` logs to the
// store by default, so every failure we show also becomes recoverable from the header bell. That is the whole
// reason to have both. `log: false` is for the echoes whose effect the screen already shows — a sweep's result
// is visible in the report it just changed — because logging those turns the store into a transcript of the
// reader's own clicks and the badge stops meaning anything.
const notify = (message, priority = 'alert', options = {}) =>
	nui.components.banner.show({ content: message, placement: 'bottom', priority, autoClose: 8000, ...options });

const entryUrl = (key, id) =>
	`/api/collections/${encodeURIComponent(key)}/entries/${encodeURIComponent(id)}`;

const stamp = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

// The collection the current route points at — `#col=<key>` — or null.
const routeKey = () => (location.hash.match(/^#col=(.+)$/) || [])[1] ?? null;

// What the current route is showing, as `{ scope, id }` — the same vocabulary the feed publishes. It is
// what lets an incoming message be matched against what is on screen instead of every message reloading
// everything.
function currentScope() {
	const collection = location.hash.match(/^#col=([^&]+)/);
	if (collection) return { scope: 'entries', id: decodeURIComponent(collection[1]) };
	const bucket = location.hash.match(/^#bucket=([^&]+)/);
	if (bucket) return { scope: 'media', id: decodeURIComponent(bucket[1]) };
	return null;
}

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
let buckets = [];

// The router CACHES a wrapper per route, so re-navigating to the same hash is a no-op and
// cannot be used to refresh. The active view therefore exposes its own reload, and every
// mutation calls it.
let activeView = null;

// ─── The feed ────────────────────────────────────────────────────────────────────────────────
// The UI is kept current by the event feed rather than by polling. This is the property the old CMS was
// built on (behaviour-inventory.md §1–§3) and it is what makes a second client — another browser, or the
// Chat app — correct without anyone refetching.
//
// `apply` decides *whether* a message concerns what is on screen; nothing else reloads. A change to the
// axis (a collection or bucket appearing, disappearing or being renamed) always matters, because the
// sidebar is always visible.
//
// Reloads are debounced. A message per file in a ten-file upload would otherwise mean ten full refetches,
// and the burst is the normal case rather than the exception.
let reloadTimer = null;
function scheduleReload(work, delay = 150) {
	clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => work().catch((error) => notify(error.message, 'alert')), delay);
}

function applyFeedMessage(message) {
	const onScreen = currentScope();

	switch (message.scope) {
		case 'collections':
		case 'buckets':
			// The sidebar is the axis, so anything that can add, remove or rename a node is applied there.
			scheduleReload(async () => {
				await loadNav();
				// A rename of the scope you are in changes the label but not the key; a delete leaves the route
				// pointing at something gone, and reloading is what surfaces that honestly.
				if (activeView) await activeView.reload();
			});
			return;
		case 'entries':
			if (onScreen?.scope === 'entries' && onScreen.id === message.collection) scheduleReload(() => activeView.reload());
			return;
		case 'media':
			// `postproc` is the one feed event worth *telling* someone about rather than silently applying, and it is
			// the pattern the store documents: the feed keeps the view correct, the store carries what you would want
			// to be told. A stable id per asset means repeated updates replace in place instead of flooding the log.
			if (message.type === 'postproc') {
				// The message is the asset's own fields — the same shape the reprocess route publishes.
				const failed = Object.values(message.jobs ?? {}).filter((job) => job.status === 'failed').length;
				const name = message.filename ?? message._id;
				nui.notify({
					id: `media:${message._id}`,
					content: failed
						? `${name} — ${failed} variant${failed === 1 ? '' : 's'} failed`
						: `${name} is ready`,
					priority: failed ? 'alert' : 'info',
					// A notification names a thing, and the thing has a home. Clicking the entry goes there rather
					// than leaving the reader to find it. The log renders an entry with an `action` as a button.
					action: message.bucket ? `goto-bucket:${message.bucket}` : null
				});
			}
			// `postproc` lands here — the variant finished with no request outstanding, which is exactly the case
			// the polling loop used to cover.
			if (onScreen?.scope === 'media' && onScreen.id === message.bucket) scheduleReload(() => activeView.reload());
			return;
		default:
			// An unknown scope is not an error: the vocabulary is shared with other clients and may grow. Ignored
			// loudly enough to be findable, quiet enough not to interrupt.
			console.warn('[nCMS] feed: no handler for scope', message.scope, message.type);
	}
}

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
	// An empty selection is not a failure — the footer reports the count, so the state is already on screen.
	if (!selected.length) return;

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
// ─── Files: buckets, the pool, and processing state ──────────────────────────────────────────
// nMedia computes; the CMS owns the pool, the jobs and the reporting (plan §6). A bucket is a label on an
// asset, so this screen's actions move no bytes and change no reference.

const mediaUrl = (id) => `/api/media/${encodeURIComponent(id)}`;
const fileUrl = (id, name) => `${mediaUrl(id)}/file/${encodeURIComponent(name)}`;

// Jobs are the only source of truth about processing: a variant is usable when its job completed, and a
// failure names itself rather than looking like an empty slot.
function mediaStatus(asset) {
	// No bytes at all. Two different states, so two labels: the reservation is live and its bytes are on their
	// way, or the upload was abandoned and this is a record with nothing in it. Calling the second one a failure
	// would be crying wolf — nothing failed; it was simply never finished, and the row is deletable.
	if (asset.original === null || asset.original === undefined) {
		return asset.ticket ? { text: 'receiving', tone: 'busy' } : { text: 'no bytes', tone: 'dim' };
	}

	const jobs = Object.values(asset.jobs ?? {});
	const failed = jobs.filter((job) => job.status === 'failed');
	// A file the pool stores but does not process has no menu, so there is no state to report — "not processed"
	// would describe work that was never queued. Only an image can be waiting on jobs.
	if (!jobs.length) return asset.kind === 'image' ? { text: 'not processed', tone: 'dim' } : null;
	if (failed.length) return { text: `${failed.length} of ${jobs.length} failed`, tone: 'bad' };
	if (jobs.some((job) => job.status === 'queued' || job.status === 'processing')) {
		return { text: 'processing', tone: 'busy' };
	}
	return { text: `${Object.keys(asset.variants ?? {}).length} versions`, tone: 'ok' };
}

const bytes = (size) => (size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} kB` : `${(size / 1048576).toFixed(1)} MB`);

// A row is the shared ListView shape: a leading preview, the label over its state, and the dates right-
// aligned. An image previews; any other file the pool stores shows the file-type icon instead.
function buildMediaRow(asset) {
	const row = document.createElement('div');
	row.className = 'cms-row';

	const slot = document.createElement('div');
	slot.className = 'cms-thumb-slot';
	if (asset.kind === 'image') {
		const thumb = document.createElement('img');
		thumb.className = 'cms-thumb';
		thumb.loading = 'lazy';
		thumb.alt = '';
		// The smallest variant if there is one, else the original — an image, so a preview always has a source.
		thumb.src = asset.variants?.thumb_cms ? fileUrl(asset._id, 'thumb_cms') : fileUrl(asset._id, 'original');
		thumb.addEventListener('error', () => { thumb.classList.add('cms-thumb-broken'); });
		slot.append(thumb);
	} else {
		const icon = document.createElement('nui-file-icon');
		icon.setAttribute('size', 'small');
		icon.setAttribute('name', asset.filename);
		slot.append(icon);
	}

	const main = document.createElement('div');
	main.className = 'cms-row-main';
	const title = document.createElement('div');
	title.className = 'cms-row-title';
	title.textContent = asset.filename;
	const status = mediaStatus(asset);
	const snippet = document.createElement('div');
	snippet.className = `cms-row-snippet${status ? ` cms-status-${status.tone}` : ''}`;
	snippet.textContent = [status?.text, bytes(asset.size ?? asset.original?.size ?? 0)].filter(Boolean).join(' · ');
	main.append(title, snippet);

	// Created over modified, right-aligned — the date pair every list row in the old CMS carries.
	const dates = document.createElement('div');
	dates.className = 'cms-row-meta cms-row-dates';
	const created = document.createElement('span');
	created.textContent = stamp(asset.c_date);
	const modified = document.createElement('span');
	modified.textContent = stamp(asset.m_date ?? asset.c_date);
	dates.append(created, modified);

	row.append(slot, main, dates);
	row.addEventListener('dblclick', () => openMediaEditor(asset._id));
	return row;
}

async function loadMedia(bucketId, pane) {
	const assets = await api('GET', `/api/media?bucket=${encodeURIComponent(bucketId)}`);
	pane.querySelector('nui-list')?.remove();

	const list = document.createElement('nui-list');
	pane.append(list);
	list.loadData({
		data: assets,
		render: buildMediaRow,
		search: [{ prop: 'filename' }, { prop: '_id' }],
		sort: [
			{ label: 'Added — newest', prop: 'c_date', numeric: true, dir: 'desc' },
			{ label: 'Name — A to Z', prop: 'filename' }
		],
		sort_default: 0,
		footer: {
			buttons_left: [{ label: 'Delete', type: 'danger', fnc: () => deleteMedia(list, bucketId) }],
			buttons_right: [
				{ label: 'Reprocess', type: 'outline', fnc: () => reprocessSelected(list) },
				{ label: 'Upload files', type: 'primary', fnc: () => uploadInto(bucketId) }
			]
		}
	});

	// Nothing polls. Processing finishes when it finishes, and the feed says so — see `applyFeedMessage`.
	// The old CMS worked the same way, and its polling loop is what this replaces.
}

// ─── Uploads — reserve, send, report ─────────────────────────────────────────────────────────
// Three acts, which is what the old CMS does and the only order that lets anything be reported
// (upload-and-events-plan.md §A):
//
//   1. reserve — the record exists before its bytes do, so the row appears immediately;
//   2. send    — the bytes travel in their own request, which is what makes progress reportable;
//   3. process — follows the bytes, on the server. Nothing here waits on nMedia.
//
// The queue is **serial**: one file at a time. Parallel uploads would make "N of M" meaningless and put an
// arbitrary number of 4 GiB streams in flight at once.
//
// The progress region is fed by the request's own progress event, not by the feed. The feed carries changes to
// *records* — the row appearing, a variant finishing — and a byte counter is not a record.

const uploads = { queue: [], active: null, total: 0, done: 0 };
let uploadTimer = null;
let uploading = false;

function renderUploads() {
	const box = document.getElementById('uploads');
	if (!box) return;
	const { active, queue, total, done } = uploads;

	// Idle means hidden, not "showing a full bar". A permanently visible progress area is a notification
	// surface that never has anything to say.
	if (!active && !queue.length) {
		if (!total) { box.hidden = true; return; }
		// Just finished: the last state stays visible briefly, so the completion is actually seen.
		box.hidden = false;
		document.getElementById('uploads-label').textContent = `Uploaded ${done} of ${total}`;
		document.getElementById('uploads-stats').textContent = '';
		document.getElementById('uploads-bar').setAttribute('value', '100');
		return;
	}

	box.hidden = false;
	const fraction = active?.size ? (active.loaded ?? 0) / active.size : 0;
	const percent = total ? Math.round(((done + fraction) / total) * 100) : 0;
	document.getElementById('uploads-label').textContent = `Uploading ${Math.min(done + 1, total)} of ${total}`;
	document.getElementById('uploads-stats').textContent = active
		? `${active.file.name} · ${bytes(active.loaded ?? 0)} / ${bytes(active.size ?? active.file.size)}`
		: '';
	// `nui-progress` re-renders on an attribute change, so the bar is driven by the value rather than rebuilt.
	document.getElementById('uploads-bar').setAttribute('value', String(percent));
}

function uploadInto(bucketId) {
	const picker = document.createElement('input');
	picker.type = 'file';
	// No accept filter: the pool stores any file. Only images have a variant menu, and that is the processor's
	// business, not the picker's.
	picker.multiple = true;
	picker.addEventListener('change', async () => {
		clearTimeout(uploadTimer);
		uploads.queue.push(...[...picker.files].map((file) => ({ file, bucketId, loaded: 0, size: file.size })));
		uploads.total += picker.files.length;
		renderUploads();
		await drainUploads();
	});
	picker.click();
}

async function drainUploads() {
	if (uploading) return; // a second selection joins the running batch rather than racing it
	uploading = true;
	try {
		while (uploads.queue.length) {
			const item = uploads.queue.shift();
			uploads.active = item;
			renderUploads();
			try {
				await uploadFile(item.bucketId, item.file, (loaded, size) => {
					item.loaded = loaded;
					item.size = size;
					renderUploads();
				});
			} catch (error) {
				// A failure is the one thing that gets a banner — the progress area reports, it never warns.
				notify(`${item.file.name} — ${error.message}`, 'alert');
			}
			uploads.done += 1;
			uploads.active = null;
			renderUploads();
		}
	} finally {
		uploading = false;
		// The actor reloads; the feed carries the tail (plan §C). Without this the row for a file this client
		// just added would only appear when the feed's own message arrived — correct, but a beat late.
		await activeView?.reload();
		uploadTimer = setTimeout(() => {
			uploads.total = 0;
			uploads.done = 0;
			renderUploads();
		}, 2000);
	}
}

async function uploadFile(bucketId, file, onProgress) {
	// Act one. From here the record exists, so a failure while sending the bytes leaves something visible and
	// deletable rather than nothing at all — which is exactly what the old CMS's create-first order buys.
	const reserved = await api('POST', '/api/media', {
		filename: file.name,
		size: file.size,
		mime: file.type || undefined,
		bucket: bucketId
	});
	return sendBytes(reserved, file, onProgress);
}

// Act two. `XMLHttpRequest`, not `fetch`: `fetch` still cannot report upload progress, and this is the one
// place the older API is simply better (plan §D). The ticket goes in a header — it is a capability for this
// one record, which is why the server never broadcasts it.
function sendBytes(reserved, file, onProgress) {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('PUT', `/api/media/${encodeURIComponent(reserved._id)}/file`);
		request.setRequestHeader('x-ticket', reserved.ticket);
		request.setRequestHeader('content-type', file.type || 'application/octet-stream');

		request.upload.addEventListener('progress', (event) => {
			if (event.lengthComputable) onProgress(event.loaded, event.total);
		});

		request.addEventListener('load', () => {
			let payload;
			try {
				payload = JSON.parse(request.responseText);
			} catch {
				// A proxy or a crash produced HTML; the status is the only fact left, so it is the message.
				reject(new Error(`Upload failed (${request.status}).`));
				return;
			}
			if (!payload.status) {
				reject(Object.assign(new Error(payload.message), { code: payload.error, detail: payload.detail }));
				return;
			}
			resolve(payload.data);
		});
		request.addEventListener('error', () => reject(new Error('Upload failed — the connection was lost.')));
		request.addEventListener('abort', () => reject(new Error('Upload cancelled.')));
		request.send(file);
	});
}

async function deleteMedia(list, bucketId) {
	const selected = list.getSelection(true);
	if (!selected.length) return;
	const confirmed = await nui.components.dialog.confirm(
		`Delete ${selected.length} item(s)?`,
		'They move to the trash. Nothing is destroyed until the trash is emptied.'
	);
	if (!confirmed) return;
	for (const row of selected) await api('DELETE', mediaUrl(row.data._id));
	await activeView?.reload();
}

async function reprocessSelected(list) {
	const selected = list.getSelection(true);
	if (!selected.length) return;
	for (const row of selected) await api('POST', `${mediaUrl(row.data._id)}/reprocess`);
	await activeView?.reload();
}

// A media entry is opened and edited exactly like a database entry: double-click the row and the record's
// JSON opens in the same editor. The record carries derived fields (`variants`, `jobs`, `original`) that the
// API refuses to change, so the editor shows the whole record without pretending they are editable.
async function openMediaEditor(id, source) {
	const text = source === undefined
		? JSON.stringify(await api('GET', mediaUrl(id)), null, '\t')
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

	let record;
	try {
		record = JSON.parse(editor.value);
	} catch (error) {
		// Reopened with the author's text rather than refetching — a rejected save must not cost the edit.
		notify(`Not valid JSON — ${error.message}`, 'alert');
		return openMediaEditor(id, editor.value);
	}

	try {
		await api('PATCH', mediaUrl(id), record);
	} catch (error) {
		notify(`Not saved — ${error.message}`, 'alert');
		return openMediaEditor(id, editor.value);
	}
	await activeView?.reload();
}

// Buckets are editable from the axis itself, like collections — the set editor the old CMS has.
function buildBucketRow(bucket) {
	const row = document.createElement('div');
	row.className = 'cms-collection-row';
	row.dataset.key = bucket?._id ?? '';

	const name = document.createElement('input');
	name.type = 'text';
	name.className = 'cms-field cms-field-name';
	name.value = bucket?.name ?? '';
	name.placeholder = bucket ? '' : 'New bucket name';
	name.setAttribute('aria-label', 'Bucket name');
	row.append(name);
	if (!bucket) return row;

	const control = document.createElement('nui-button');
	control.setAttribute('variant', 'icon');
	const button = document.createElement('button');
	button.type = 'button';
	button.setAttribute('aria-label', `Delete ${bucket.name}`);
	button.innerHTML = '<nui-icon name="delete"></nui-icon>';
	button.addEventListener('click', async () => {
		const confirmed = await nui.components.dialog.confirm(
			`Delete bucket "${bucket.name}"?`,
			'The label is removed; the media keeps its id and its reference. Nothing is destroyed.'
		);
		if (confirmed) row.remove();
	});
	control.append(button);
	row.append(control);
	return row;
}

async function openBucketsEditor(state) {
	const original = state?.original ?? await api('GET', '/api/buckets');
	const rowsState = state?.rows ?? original.map((bucket) => ({ key: bucket._id, name: bucket.name }));

	const { main, result } = await nui.components.dialog.page('Buckets', '', {
		contentScroll: true,
		buttons: [
			{ label: 'Cancel', type: 'outline', value: 'cancel' },
			{ label: 'Save', type: 'primary', value: 'save' }
		]
	});

	const rows = document.createElement('div');
	rows.className = 'cms-collections';
	for (const bucket of rowsState) rows.append(buildBucketRow(bucket));
	rows.append(buildBucketRow(null));
	main.append(rows);

	if ((await result) !== 'save') return;

	const rowsNow = [...rows.querySelectorAll('.cms-collection-row')].map((row) => ({
		key: row.dataset.key || null,
		name: row.querySelector('.cms-field-name').value.trim()
	}));

	try {
		for (const bucket of original) {
			if (!rowsNow.some((row) => row.key === bucket._id)) await api('DELETE', `/api/buckets/${encodeURIComponent(bucket._id)}`);
		}
		for (const row of rowsNow) {
			if (!row.key && row.name) await api('POST', '/api/buckets', { name: row.name });
		}
		for (const row of rowsNow) {
			const before = original.find((bucket) => bucket._id === row.key);
			if (before && before.name !== row.name && row.name) {
				await api('PATCH', `/api/buckets/${encodeURIComponent(row.key)}`, { name: row.name });
			}
		}
	} catch (error) {
		notify(`Not saved — ${error.message}`, 'alert');
		return openBucketsEditor({ rows: rowsNow, original });
	}

	await loadNav();
	await activeView?.reload();
}

// ─── Route type: a bucket ────────────────────────────────────────────────────────────────────
// A TYPE handler is called `(id, params, wrapper)` — the wrapper comes LAST.

nui.registerType('bucket', (id, params, wrapper) => {
	wrapper.innerHTML = '';
	const pane = document.createElement('div');
	pane.className = 'cms-pane';
	wrapper.append(pane);

	activeView = { reload: () => loadMedia(id, pane) };
	activeView.reload().catch((error) => {
		pane.textContent = `Could not load bucket "${id}": ${error.message}`;
	});
});
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

// ─── Route: the request log ──────────────────────────────────────────────────────────────────
// The server's record of what was asked of it — every request, successes and failures alike. It is NOT the
// feed: the feed carries *changes* so a second client's view stays correct, and keeping reads off it is what
// makes it worth subscribing to. A log wants the opposite, so it is read on demand with a cursor, which makes
// the read incremental.
//
// This is the one screen that polls, and the reason is that nothing is waiting on it — the media poll was
// different, because it existed to *notice* work finishing, and the feed announces that now.
//
// The interval is created once and lives for the session, doing nothing unless the log is on screen. Stopping
// and restarting it on navigation would be tidier, but it would have to be ordered against the router's own
// render (which is scheduled inside a double `requestAnimationFrame`), and a tick that returns early is a far
// smaller thing to get right than that ordering.

const LOG_POLL_MS = 2000;
const LOG_LIMIT = 200;
// The table stays small on purpose: `nui-table` is documented for small-to-medium datasets, and a log is a
// *tail* — the oldest rows leave as new ones arrive, rather than accumulating scrollback nobody reads.
const LOG_ROWS = 200;
// One source for the column list: it builds the header row, labels each cell, and sizes the gap row's colspan.
const LOG_COLUMNS = ['Status', 'Time', 'Action', 'IP', 'Result'];
let logPoll = null;
let logCursor = 0;
let logBody = null;   // the <tbody>, so an arriving row has somewhere to go
let logScroll = null; // the scrolling wrapper — a table cannot scroll itself

const logUrl = (since) => `/api/log?since=${since}&limit=${LOG_LIMIT}`;

// One entry, as a table row. The status is a `nui-badge` rather than a coloured row: the component already
// carries the meaning, so colouring the row would duplicate it *and* fight `nui-table`'s own responsive mode,
// which restyles cells into cards on narrow screens.
function buildLogRow(entry) {
	const tr = document.createElement('tr');

	const status = document.createElement('td');
	const badge = document.createElement('nui-badge');
	badge.setAttribute('variant', entry.status ? 'success' : 'danger');
	badge.textContent = entry.status ? 'ok' : 'failed';
	status.append(badge);

	const values = [
		new Date(entry.timestamp).toLocaleTimeString(),
		entry.action,
		// `::1` and `::ffff:127.0.0.1` are both "this machine", and printing either is noise on a local tool.
		/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(entry.ip ?? '') ? 'local' : (entry.ip ?? '—'),
		entry.error ? `${entry.error}${entry.detail ? ` — ${entry.detail}` : ''}` : `${entry.ms} ms`
	];

	const cells = [status, ...values.map((text) => {
		const td = document.createElement('td');
		td.textContent = text;
		return td;
	})];

	// `nui-table` decorates the rows present when it upgrades — a single pass, and no mutation observer — and a
	// log's rows arrive long after that. So the `data-label` its responsive card mode reads is set here, or every
	// column loses its label on a narrow screen. (The pool's tables are assembled complete before insertion, so
	// the component labels those itself.)
	cells.forEach((td, index) => td.setAttribute('data-label', LOG_COLUMNS[index]));
	tr.append(...cells);
	return tr;
}

function paintLog(page) {
	if (!logBody) return;
	if (page.gap) {
		// The ring buffer dropped entries this cursor never saw. Admitting it is the point: a log with an
		// invisible hole in it is worse than one that says where the hole is. As a full-width row, because a
		// table cannot hold anything that is not one.
		const gap = document.createElement('tr');
		const cell = document.createElement('td');
		cell.colSpan = LOG_COLUMNS.length;
		cell.textContent = `… entries were dropped here — the server keeps the ${LOG_LIMIT} most recent`;
		gap.append(cell);
		logBody.append(gap);
	}
	for (const entry of page.entries) logBody.append(buildLogRow(entry));
	logCursor = Math.max(logCursor, page.seq);

	while (logBody.children.length > LOG_ROWS) logBody.firstElementChild.remove();

	const note = document.getElementById('log-note');
	if (note) note.textContent = `${logBody.children.length} entries · newest last`;
	// A log follows its own end.
	if (logScroll) logScroll.scrollTop = logScroll.scrollHeight;
}

nui.registerFeature('log', (wrapper) => {
	wrapper.innerHTML = '';
	const pane = document.createElement('div');
	pane.className = 'cms-page';

	const head = document.createElement('div');
	head.className = 'cms-page-head';
	const title = document.createElement('h2');
	title.textContent = 'Log';
	const note = document.createElement('p');
	note.id = 'log-note';
	note.className = 'cms-page-meta';
	head.append(title, note);

	const scroll = document.createElement('div');
	scroll.className = 'cms-table-scroll';
	// A log is a live region by nature, but it must not be shouted: `polite` announces new rows when the reader
	// is idle rather than interrupting them. On the scroll wrapper rather than the `<tbody>` — a `tbody`'s role
	// is a rowgroup, and putting a live-region role there would be invalid markup.
	scroll.setAttribute('role', 'log');
	scroll.setAttribute('aria-live', 'polite');

	// `nui-table` wraps a real `<table>` with a `<thead>` and `<tbody>`, and decorates the cells for its
	// responsive card mode from the header text. The markup is a standard table; the component supplies the
	// behaviour and the styling.
	const table = document.createElement('nui-table');
	const inner = document.createElement('table');
	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	for (const label of LOG_COLUMNS) {
		const th = document.createElement('th');
		th.textContent = label;
		headRow.append(th);
	}
	thead.append(headRow);
	const body = document.createElement('tbody');
	inner.append(thead, body);
	table.append(inner);
	scroll.append(table);

	pane.append(head, scroll);
	wrapper.append(pane);

	logBody = body;
	logScroll = scroll;
	logCursor = 0;

	(async () => {
		try {
			paintLog(await api('GET', logUrl(0)));
		} catch (error) {
			const failed = document.createElement('p');
			failed.className = 'cms-empty';
			failed.textContent = `Could not read the log: ${error.message}`;
			pane.append(failed);
		}
	})();

	if (!logPoll) {
		logPoll = setInterval(async () => {
			// Nothing to do unless the log is the screen you are looking at. The wrapper is cached by the
			// router, so this node outlives the visit and comes back with it.
			if (!logBody?.isConnected || !location.hash.startsWith('#feature=log')) return;
			try {
				const next = await api('GET', logUrl(logCursor));
				// A gap is reported even with no entries, because that is exactly when it matters.
				if (next.entries.length || next.gap) paintLog(next);
			} catch {
				// A dropped poll is covered by the next one, and a banner for it would be noise on a screen whose
				// whole job is to show what happened.
			}
		}, LOG_POLL_MS);
	}
});

// ─── Route: pool integrity ───────────────────────────────────────────────────────────────────
// The old CMS's `files_check`, as a screen. It is read-only: the sweep is a separate button, because a
// maintenance screen is the one place you open to look before you act, and the original deletes inside what
// reads like a check.
//
// The five findings are not five kinds of error — they have different answers, and showing them as one list
// would invite the wrong one:
//
//   unreferenced    bytes nothing claims. The only thing the sweep removes.
//   restorable      bytes a deleted record still claims. **Kept** — sweeping them would destroy what the
//                   tombstone exists to preserve.
//   missingBytes    a live record whose bytes are gone. Usually an abandoned reservation, which just needs
//                   deleting. An in-flight upload is never listed.
//   deletedBucket   a live record under a *deleted* bucket. Expected: deleting a bucket is a tombstone, and its
//                   assets keep their label on purpose so that restoring it brings the organisation back.
//   noBucket        a live record naming a bucket id nothing knows about. This one is real.

nui.registerFeature('maintenance', (wrapper) => {
	wrapper.innerHTML = '';
	const pane = document.createElement('div');
	pane.className = 'cms-page';

	const head = document.createElement('div');
	head.className = 'cms-page-head';
	const title = document.createElement('h2');
	title.textContent = 'Pool';
	const note = document.createElement('p');
	note.className = 'cms-page-meta';
	const actions = document.createElement('nui-button-container');
	actions.setAttribute('align', 'end');
	head.append(title, note, actions);

	const body = document.createElement('div');
	body.className = 'cms-report-list';
	pane.append(head, body);
	wrapper.append(pane);

	// A finding group is a card — the library's surface, a `nui-badge` for the count rather than a number
	// welded into a heading, and the items in a real table so the columns line up and the responsive card mode
	// takes over on a narrow screen.
	function section(label, items, describe, variant) {
		const card = document.createElement('nui-card');

		const heading = document.createElement('h3');
		heading.textContent = `${label} `;
		const badge = document.createElement('nui-badge');
		// A count is only a warning when it *is* one. Painting `danger` on a group the design expects would
		// train the reader to ignore the colour — and one of these groups is non-empty in normal operation.
		if (items.length && variant) badge.setAttribute('variant', variant);
		badge.textContent = String(items.length);
		heading.append(badge);

		const explain = document.createElement('p');
		explain.className = 'cms-page-meta';
		explain.textContent = describe;

		card.append(heading, explain);
		if (items.length) card.append(reportTable(items));
		return card;
	}

	function reportTable(items) {
		const table = document.createElement('nui-table');
		const inner = document.createElement('table');
		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const label of ['Asset', 'File', 'Bucket', 'Size']) {
			const th = document.createElement('th');
			th.textContent = label;
			headRow.append(th);
		}
		thead.append(headRow);

		const tbody = document.createElement('tbody');
		for (const item of items) {
			const tr = document.createElement('tr');
			for (const text of [
				item._id ?? '—',
				item.filename ?? '—',
				item.bucket ?? '—',
				item.size === undefined ? '—' : bytes(item.size)
			]) {
				const td = document.createElement('td');
				td.textContent = text;
				tr.append(td);
			}
			tbody.append(tr);
		}
		inner.append(thead, tbody);
		table.append(inner);
		return table;
	}

	async function refresh() {
		body.replaceChildren();
		actions.replaceChildren();
		let report;
		try {
			// `/api/pool` — the report. It used to ask for `/api/pool/integrity`, which only answered because the
			// router ignores a trailing segment on GET: an undocumented path that works by accident breaks the day
			// the router gets strict, and the failure lands here as "could not read the pool" with nothing wrong.
			report = await api('GET', '/api/pool');
		} catch (error) {
			const failed = document.createElement('p');
			failed.className = 'cms-empty';
			failed.textContent = `Could not read the pool: ${error.message}`;
			body.append(failed);
			return;
		}

		const { unreferenced, restorable, missingBytes, noBucket, deletedBucket, counts } = report;
		note.textContent = `${counts.assets} assets · ${counts.directories} directories · ${counts.buckets} buckets`;

		const reclaimable = unreferenced.reduce((sum, item) => sum + item.size, 0);
		if (unreferenced.length) {
			const sweep = document.createElement('nui-button');
			sweep.setAttribute('variant', 'danger');
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = `Remove ${unreferenced.length} unreferenced (${bytes(reclaimable)})`;
			sweep.append(button);
			button.addEventListener('click', async () => {
				const yes = await nui.components.dialog.confirm(
					`Remove ${unreferenced.length} unreferenced director${unreferenced.length === 1 ? 'y' : 'ies'}?`,
					`${bytes(reclaimable)} of bytes that no record — live or deleted — refers to. This cannot be undone.`);
				if (!yes) return;
				try {
					const result = await api('POST', '/api/pool');
					// A success, and one the report below already shows — so `info`, and not logged.
					notify(`Removed ${result.removed.length} (${bytes(result.bytes)}).`, 'info', { log: false });
				} catch (error) {
					notify(`Sweep failed — ${error.message}`, 'alert');
				}
				await refresh();
			});
			actions.append(sweep);
		}

		body.append(
			section('Unreferenced', unreferenced,
				'Bytes no record claims, live or deleted. These are the only thing the sweep removes.', 'danger'),
			section('Restorable', restorable,
				'Bytes belonging to a deleted record. Kept — removing them would destroy what the tombstone preserves.', null),
			section('Records with no bytes', missingBytes,
				'A live record whose original is gone — usually a reservation whose upload was abandoned, which just needs deleting. An in-flight upload is never listed here.', 'danger'),
			section('Filed under a deleted bucket', deletedBucket ?? [],
				'Expected after a bucket is deleted: the assets keep their label so that restoring the bucket brings the organisation back. Nothing is broken.', null),
			section('Filed under an unknown bucket', noBucket,
				'A live record naming a bucket id nothing knows about — not even a deleted one. This one is real.', 'danger')
		);
	}

	refresh().catch((error) => notify(error.message, 'alert'));
});

// ─── Startup ─────────────────────────────────────────────────────────────────────────────────

async function loadNav() {
	// Two axes: collections and buckets. Both come from the API, and neither keeps a second copy.
	[collections, buckets] = await Promise.all([
		api('GET', '/api/collections'),
		api('GET', '/api/buckets')
	]);

	// No `mode` on the list: nui-sidebar forces "fold" on its navigation list, and a sidebar's
	// list IS the navigation. (Setting "tree" here was the one real mistake in the first attempt.)
	const list = document.getElementById('main-navigation');
	// Icons belong to GROUP HEADERS only. In fold mode the child row's indent is applied to its
	// label span (`.group-items > li a span { padding-left: 2.7rem }`) while the anchor itself is
	// `position: absolute; inset: 0` with no left padding — so a child `icon` renders flush at the
	// row's left edge, i.e. left of the group's icon, clipped by the sidebar. The child's label
	// alone is indented to sit under the group's label; that is the whole visual contract.
	list.loadData([
		{
			label: 'Database',
			icon: 'database',
			rowAction: { action: 'edit-collections', icon: 'settings', label: 'Edit collections' },
			items: collections.map((collection) => ({
				label: collection.name,
				href: '#col=' + collection.key
			}))
		},
		{
			label: 'Files',
			icon: 'media_folder',
			rowAction: { action: 'edit-buckets', icon: 'settings', label: 'Edit buckets' },
			items: buckets.map((bucket) => ({
				label: bucket.name,
				href: '#bucket=' + bucket._id
			}))
		},
		{
			// The server's own screens. They are not scopes — nothing about them is an axis you edit — so they sit
			// in their own group rather than in the two content axes. `#feature=` is the router's form for a
			// singleton view (a `#type=id` route is for content that has an identity).
			label: 'Server',
			icon: 'article',
			items: [
				{ label: 'Log', href: '#feature=log' },
				{ label: 'Pool', href: '#feature=maintenance' }
			]
		}
	]);

	// The row actions are icon-only, and the library asks for a tooltip alongside each. The tooltip host is
	// position: fixed, so injecting it adds nothing to the row's layout.
	for (const button of list.querySelectorAll('button.action')) {
		const tooltip = document.createElement('nui-tooltip');
		tooltip.textContent = button.dataset.action === 'edit-buckets' ? 'Edit buckets' : 'Edit collections';
		button.after(tooltip);
	}
}

nui.registerAction('edit-collections', () => openCollectionsEditor());
nui.registerAction('edit-buckets', () => openBucketsEditor());

// A notification's `action` is a pointer back at the thing it names. Media entries carry the asset's bucket,
// so the entry is clickable and lands on that scope — the panel closes first, because leaving it open over
// the view you just navigated to hides the thing you went to look at.
//
// Setting the hash rather than router.go() for the same reason the initial route does: go() pushes state and
// does not fire hashchange. Already being on that bucket is a no-op the reader cannot tell from success —
// the content they want is on screen either way.
nui.registerAction('goto-bucket', (target, element, event, bucketId) => {
	document.getElementById('notifications')?.hide();
	location.hash = '#bucket=' + bucketId;
	return true;
});

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

// ─── The feed ────────────────────────────────────────────────────────────────────────────────
// Connected last, once the axis and the router exist — the first message may legitimately want to reload
// both. `onRecovery` means the stream told us we missed something it cannot replay: the honest response is
// a full re-read, not a partial application that leaves the view subtly wrong.
connectFeed({
	onMessage: applyFeedMessage,
	onRecovery: () => scheduleReload(async () => {
		await loadNav();
		if (activeView) await activeView.reload();
	}, 0)
});
