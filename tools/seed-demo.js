'use strict';

// Seeds a data root with enough content to look at in a browser: two collections with a few entries, and
// two buckets. Used to exercise the admin against a throwaway root.
//
//   node tools/seed-demo.js [port]

const http = require('node:http');

const PORT = Number(process.argv[2] || process.env.NCMS_TEST_PORT || 3400);

function request(method, route, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = http.request({
			port: PORT, method, path: route,
			headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}
		}, (res) => {
			const chunks = [];
			res.setEncoding('utf8');
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				const raw = chunks.join('');
				try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
				catch { reject(new Error(`${method} ${route}: ${raw.slice(0, 200)}`)); }
			});
		});
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

async function main() {
	for (const name of ['Work', 'Writing']) {
		const created = await request('POST', '/api/collections', { name });
		console.log(`collection ${name}: ${created.status}`);
	}
	for (const [key, titles] of [['work', ['Rain study', 'Field notes']], ['writing', ['On the seam', 'Two channels']]]) {
		for (const title of titles) {
			const created = await request('POST', `/api/collections/${key}/entries`,
				{ name: title, docs: { en: `---\ntitle: ${title}\n---\n\nA paragraph.\n` } });
			console.log(`  entry ${key}/${title}: ${created.status}`);
		}
	}
	const listed = await request('GET', '/api/collections');
	console.log('collections now:', listed.body.data.map((c) => c.key).join(', '));

	for (const name of ['Assets', 'Older files']) {
		const created = await request('POST', '/api/buckets', { name });
		console.log(`bucket ${name}: ${created.status}`);
	}
	const buckets = await request('GET', '/api/buckets');
	console.log('buckets now:', buckets.body.data.map((b) => b.name).join(', '));
}

main().catch((error) => {
	console.error(error.message ?? error);
	process.exit(1);
});
