'use strict';

// One-shot import: the old n000b CMS's block tree → MD-Blocks entries in nCMS.
//
//   node tools/import-n000b.js --from <oldCollection.json> --to <key> [options]
//
//     --from <file>        the old neDB collection: one document per line, first line `_meta`
//     --to <key>           the target collection key in nCMS
//     --name <label>       its display name (default: the key)
//     --categories <file>  the old categories collection, for resolving tag ids (optional)
//     --languages en,de    the target collection's translatability (default: en)
//     --limit <n>          stop after n documents
//     --dry-run            print the MD-Blocks source of one document and write nothing
//     --out <dir>          write one .md preview per document instead of importing, so the
//                          output can be run through `modules/md-blocks/tools/validate.js`
//
// It writes through the HTTP API (`POST /api/collections`, `POST /api/collections/:key/entries`)
// rather than to `data.jsonl` directly. The importer is a client of the same contract the admin
// SPA and the Chat app use — that is the point of "one API, two clients" (plan §7); a second write
// path would be a second set of rules about what an entry is.
//
// Nothing is dropped silently. Every block type is either mapped or the import throws, and the
// things the old system carries that MD-Blocks cannot express (`class`, `parent_name`) are counted
// and reported. The mapping itself is what `docs/reference/n000b_cms/n000b_cms_spec.md` §2
// describes, read in reverse.

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.NCMS_API || 'http://localhost:3300/api';

// The old editor's palette names. A label equal to the type's own palette name carries no
// information, so it is not written; anything else is the author's, and is.
const PALETTE_LABEL = { media: 'Media', text: 'Text', input: 'Input', vars: 'Variables', richtext: 'Richtext' };
const SECTION_DEFAULT_LABEL = 'Section';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'svg']);

const warnings = [];
let droppedClasses = 0;
let droppedParentNames = 0;
let titleMismatches = 0;

// ─── Arguments ────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = { languages: 'en', limit: Infinity, name: null, categories: null, dryRun: false, out: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--from') args.from = argv[++i];
		else if (flag === '--to') args.to = argv[++i];
		else if (flag === '--name') args.name = argv[++i];
		else if (flag === '--categories') args.categories = argv[++i];
		else if (flag === '--languages') args.languages = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
		else if (flag === '--limit') args.limit = Number(argv[++i]);
		else if (flag === '--out') args.out = argv[++i];
		else if (flag === '--dry-run') args.dryRun = true;
		else throw new Error(`Unknown argument "${flag}".`);
	}
	if (!args.from) throw new Error('--from <oldCollection.json> is required.');
	if (!args.dryRun && !args.out && !args.to) throw new Error('--to <collectionKey> is required.');
	return args;
}

// ─── The old side ─────────────────────────────────────────────────────────────────────────────

// neDB JSONL: one document per line, and line 1 is nDB's own `_meta` header rather than content.
function readOldCollection(file) {
	return fs.readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line.trim())
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(`${file} line ${index + 1} is not JSON: ${error.message}`);
			}
		})
		.filter((doc) => !doc._meta);
}

function readCategoryNames(file) {
	const names = new Map();
	for (const doc of readOldCollection(file)) names.set(doc._id, doc.name);
	return names;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────────────────────

function slugify(text) {
	return String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
	return text.replace(/&(#\d+|[a-z]+);/gi, (whole, body) => {
		if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
		const decoded = ENTITIES[body.toLowerCase()];
		if (decoded === undefined) throw new Error(`Unknown HTML entity "${whole}".`);
		return decoded;
	});
}

// The old editor only ever produced h1, h2, p and br. Measured across every richtext block in the
// 142-document works collection: 416 h1, 22 p, 4 h2, 1 br — no attributes and no entities. That is
// why this is a tag pass and not an HTML parser.
//
// It walks tags rather than matching pairs because the blocks are not always well formed: the
// editor could emit `<p><h1>…</h1><p>…</p></p>`, and a heading cannot nest inside a paragraph. A
// pair-matching replace leaves a stray `<p>` behind; walking tags reproduces what a browser does
// with that input — the open block closes when the next one opens. Anything outside h1–h4/p/br
// throws, because it would be markup from a source nobody has measured.
function htmlToMarkdown(html) {
	const HEADING = { h1: '#', h2: '##', h3: '###', h4: '####' };
	const source = String(html);
	const blocks = [];
	let open = null;
	let buffer = '';

	const flush = () => {
		const text = decodeEntities(buffer).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
		if (text) blocks.push(open && HEADING[open] ? `${HEADING[open]} ${text}` : text);
		buffer = '';
	};

	let cursor = 0;
	for (const match of source.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\s*\/?>/g)) {
		const [whole, closing, rawTag] = match;
		const tag = rawTag.toLowerCase();
		if (!(tag in HEADING) && tag !== 'p' && tag !== 'br') {
			throw new Error(`Unconverted HTML in a richtext block: ${whole}`);
		}

		const between = source.slice(cursor, match.index);
		if (open) buffer += between;
		else if (between.trim()) blocks.push(decodeEntities(between).trim());
		cursor = match.index + whole.length;

		if (tag === 'br') {
			buffer += '\n';
		} else if (closing) {
			flush();
			open = null;
		} else {
			flush(); // an open block closes where the next one opens
			open = tag;
		}
	}

	const tail = source.slice(cursor);
	if (open) {
		buffer += tail;
		flush();
	} else if (tail.trim()) {
		blocks.push(decodeEntities(tail).trim());
	}

	const markdown = blocks.join('\n\n');
	const leftover = markdown.match(/<\/?[a-zA-Z][^>]*>/);
	if (leftover) throw new Error(`Unconverted HTML in a richtext block: ${leftover[0]}`);
	return markdown;
}

// ─── YAML frontmatter ─────────────────────────────────────────────────────────────────────────

function yamlScalar(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	const text = String(value);
	const plain = /^[A-Za-z0-9][A-Za-z0-9 ._/+,()-]*$/.test(text)
		&& !/:\s/.test(text) && text === text.trim();
	return plain ? text : JSON.stringify(text);
}

const numericIfNumeric = (text) => (/^-?\d+(\.\d+)?$/.test(String(text).trim()) ? Number(text) : text);

// Attribute values are double-quoted in MB-Blocks, so a double quote in a label cannot be carried
// across without inventing an escaping rule the format does not define.
function quoted(text) {
	if (String(text).includes('"')) throw new Error(`A label contains a double quote: ${text}`);
	return `"${text}"`;
}

// ─── The old document, read ───────────────────────────────────────────────────────────────────

function headerOf(doc) {
	const fixed = (doc.sections || []).filter((section) => section.type === 'fixed');
	if (fixed.length > 1) throw new Error(`"${doc.name}" has ${fixed.length} fixed sections.`);
	return fixed[0] || null;
}

function readHeader(doc, categoryNames) {
	const header = headerOf(doc);
	const out = { customer: '', agency: '', year: undefined, location: '', categories: [], cover: null, involvement: [] };
	if (!header) return out;

	for (const group of header.groups || []) {
		if (group.type === 'media') {
			if (!group.data?.length) continue;
			if (out.cover) throw new Error(`"${doc.name}" has more than one media block in its header.`);
			out.cover = group.data[0];
			continue;
		}
		if (group.type !== 'vars') throw new Error(`"${doc.name}" has a "${group.type}" block in its header.`);

		for (const field of group.data || []) {
			if (field.type === 'tags') {
				out.categories = (field.data || []).map((id) => {
					const name = categoryNames.get(id);
					if (name === undefined) throw new Error(`Unknown category id "${id}" in "${doc.name}".`);
					return name;
				});
				continue;
			}
			if (field.type !== 'input') throw new Error(`Unmapped header field type "${field.type}".`);
			if (field.numeric) {
				const value = Number(field.data);
				if (!Number.isFinite(value)) throw new Error(`"${doc.name}" field "${field.label}" is not numeric: ${field.data}`);
				out.involvement.push([field.label, value]);
				continue;
			}
			switch (field.id) {
				case 'vars_project':
					if (String(field.data).trim() !== String(doc.name).trim()) titleMismatches++;
					break;
				case 'vars_customer': out.customer = field.data; break;
				case 'vars_agency': out.agency = field.data; break;
				case 'vars_date': out.year = field.data; break;
				case 'vars_location': out.location = field.data; break;
				default: throw new Error(`Unmapped header field id "${field.id}" (${field.label}).`);
			}
		}
	}
	return out;
}

// ─── Media ────────────────────────────────────────────────────────────────────────────────────

const extOf = (media) => String(media.filename).split('.').pop().toLowerCase();
const isImage = (media) => IMAGE_EXT.has(extOf(media));
const stemOf = (media) => String(media.filename).replace(/\.[^.]+$/, '');

// A reference, never bytes — and by pool `_id`, which is the convention the step-2 fixture already
// uses and what spec §3 means by "reference media by `_id`/path". Variants resolve at render.
const refOf = (media) => encodeURI(`media/${media._id}/${media.filename}`);

function mediaMarkdown(items) {
	if (items.length === 1) return `${isImage(items[0]) ? '!' : ''}[${stemOf(items[0])}](${refOf(items[0])})`;
	const marker = items.every(isImage) ? '!' : '';
	return items.map((item) => `- ${marker}[${stemOf(item)}](${refOf(item)})`).join('\n');
}

// ─── The block tree, rendered ─────────────────────────────────────────────────────────────────

function labelAttr(label, type) {
	if (!label || label === PALETTE_LABEL[type]) return '';
	return ` label=${quoted(label)}`;
}

function trace(block) {
	if (block.class) droppedClasses++;
	if (block.parent_name) droppedParentNames++;
}

// The block's content, without a wrapper — what goes inside a block, or inside a column whose
// single block has been hoisted onto the `mb:col` marker itself.
function blockBody(block) {
	switch (block.type) {
		case 'richtext': return htmlToMarkdown(block.data);
		case 'text': return String(block.data).trim();
		case 'media': return mediaMarkdown(block.data || []);
		case 'files': return (block.data || []).map((file) => `- [${file.filename}](${refOf(file)})`).join('\n');
		case 'input': throw new Error('An input block is section-level data — it cannot live inside a column.');
		default: throw new Error(`Unmapped block type "${block.type}" (label: ${block.label}).`);
	}
}

function blockMarkdown(block) {
	trace(block);
	const preset = block.type === 'files' ? ' preset=link:download' : '';
	const open = `<!-- mb:block${preset}${labelAttr(block.label, block.type)} -->`;
	return `${open}\n\n${blockBody(block)}\n\n<!-- mb:/block -->`;
}

function groupMarkdown(group) {
	if (group.type === 'columns') {
		if (group.class) droppedClasses++;
		const heading = `<!-- mb:columns${labelAttr(group.label, 'columns')} -->`;
		const columns = (group.columns || []).map((column) => {
			// A column is itself the presentable unit: the demo corpus carries the preset on
			// `mb:col` and puts plain Markdown inside. A column holding exactly one block maps
			// straight onto that shape, and 248 of the 251 columns in this corpus hold one. The
			// explicit form is kept only where a column genuinely holds several blocks.
			if (column.length === 1) {
				const block = column[0];
				trace(block);
				return `<!-- mb:col${labelAttr(block.label, block.type)} -->\n\n${blockBody(block)}`;
			}
			return `<!-- mb:col -->\n\n${column.map(blockMarkdown).join('\n\n')}`;
		});
		return [heading, ...columns, '<!-- mb:/columns -->'].join('\n\n');
	}
	// `input` is a *variable*, not content (spec §2), so it becomes section-scoped named data
	// rather than a block — the one place the old model has no block-shaped equivalent.
	if (group.type === 'input') return `<!-- mb:var name="${slugify(group.label || 'value')}" -->\n\n\`\`\`text\n${String(group.data).trim()}\n\`\`\``;
	if (group.type === 'vars') throw new Error('A vars block appeared outside the header.');
	return blockMarkdown(group);
}

function sectionMarkdown(section) {
	const body = (section.groups || []).map(groupMarkdown).join('\n\n');
	const heading = section.label && section.label !== SECTION_DEFAULT_LABEL
		? `<!-- mb:section label=${quoted(section.label)} -->\n\n`
		: '';
	return heading + body;
}

function frontmatterOf(doc, header) {
	const lines = [`title: ${yamlScalar(doc.name)}`];
	if (header.customer) lines.push(`customer: ${yamlScalar(header.customer)}`);
	if (header.agency) lines.push(`agency: ${yamlScalar(header.agency)}`);
	if (header.year !== undefined && String(header.year).trim() !== '') {
		lines.push(`year: ${yamlScalar(numericIfNumeric(header.year))}`);
	}
	if (header.location) lines.push(`location: ${yamlScalar(header.location)}`);
	if (header.categories.length) {
		lines.push(`categories: [${header.categories.map(yamlScalar).join(', ')}]`);
	}
	if (header.cover) lines.push(`cover: ${yamlScalar(refOf(header.cover))}`);
	if (header.involvement.length) {
		// The discipline names carry spaces and slashes ("Video Production / Editing"), so the keys
		// are quoted rather than left as plain flow scalars.
		const pairs = header.involvement.map(([label, value]) => `${quoted(label)}: ${value}`);
		lines.push(`involvement: { ${pairs.join(', ')} }`);
	}
	return lines.join('\n');
}

function documentToMarkdown(doc, categoryNames) {
	// Any failure names the document it happened in. An import that stops at document 68 without
	// saying which one is a bug report nobody can act on.
	try {
		const header = readHeader(doc, categoryNames);
		// A root-level `---` opens the next section, so the sections are separated by one and the
		// document starts inside the first (spec: "The file starts inside section 1").
		const sections = (doc.sections || [])
			.filter((section) => section.type !== 'fixed')
			.map(sectionMarkdown);

		const parts = [
			`---\n${frontmatterOf(doc, header)}\n---`,
			`<!-- mb:main label=${quoted(doc.name)} -->`,
			sections.join('\n\n---\n\n')
		];
		return parts.filter(Boolean).join('\n\n') + '\n';
	} catch (error) {
		throw new Error(`"${doc.name}" (${doc._id}): ${error.message}`);
	}
}

// ─── The new side: the same API the admin uses ────────────────────────────────────────────────

async function api(method, path, body) {
	const response = await fetch(API + path, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const payload = await response.json();
	if (!payload.status) {
		throw new Error(`${method} ${path} → ${payload.error}: ${payload.message}`);
	}
	return payload.data;
}

async function ensureCollection(key, name, languages) {
	const existing = (await api('GET', '/collections')).find((collection) => collection.key === key);
	if (existing) return existing;
	return api('POST', '/collections', { key, name, translatability: languages });
}

// ─── Run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const categoryNames = args.categories ? readCategoryNames(args.categories) : new Map();
	const docs = readOldCollection(args.from);
	if (!docs.length) throw new Error(`${args.from} contains no documents.`);

	if (args.dryRun) {
		const markdown = documentToMarkdown(docs[0], categoryNames);
		process.stdout.write(markdown);
		console.log(`\n\n--- dry run: 1 of ${docs.length} documents, nothing written ---`);
		return;
	}

	if (args.out) {
		fs.mkdirSync(args.out, { recursive: true });
		let written = 0;
		for (const doc of docs.slice(0, args.limit)) {
			// Previews are numbered so colliding slugs cannot overwrite one another and the file
			// names stay in source order.
			const name = `${String(written + 1).padStart(3, '0')}-${slugify(doc.name)}.md`;
			fs.writeFileSync(path.join(args.out, name), documentToMarkdown(doc, categoryNames));
			written++;
		}
		console.log(`[import] wrote ${written} preview(s) to ${args.out}`);
		console.log(`[import] dropped: ${droppedClasses} class values, ${droppedParentNames} parent_name values.`);
		if (titleMismatches) console.log(`[import] ${titleMismatches} documents where vars_project differed from the name field.`);
		return;
	}

	await ensureCollection(args.to, args.name || args.to, args.languages);
	console.log(`[import] ${docs.length} documents → collection "${args.to}"`);

	let imported = 0;
	for (const doc of docs.slice(0, args.limit)) {
		const markdown = documentToMarkdown(doc, categoryNames);
		const languages = {};
		for (const language of args.languages) languages[language] = markdown;
		try {
			await api('POST', `/collections/${encodeURIComponent(args.to)}/entries`, {
				name: doc.name,
				slug: slugify(doc.name),
				n000b_id: doc._id,
				docs: languages
			});
			imported++;
		} catch (error) {
			warnings.push(`"${doc.name}" (${doc._id}) failed: ${error.message}`);
		}
	}

	console.log(`[import] wrote ${imported} of ${docs.length} documents.`);
	console.log(`[import] dropped: ${droppedClasses} class values, ${droppedParentNames} parent_name values `
		+ '(MD-Blocks has no class attribute — presentation lives in presets).');
	if (titleMismatches) console.log(`[import] ${titleMismatches} documents where vars_project differed from the name field.`);
	for (const warning of warnings) console.log(`[import] warn: ${warning}`);
	if (warnings.length) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`[import] failed: ${error.message}`);
	process.exitCode = 1;
});
