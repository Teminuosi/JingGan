import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrevisServer } from '../worker/previs/server.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-helper-api-'));
let prepared = 0;
const runtime = { detect: async () => {}, blender: () => undefined, status: () => ({ ready: false, phase: 'missing', message: 'test' }), prepare: async () => { prepared++; }, cancel: () => {} };
const server = await createPrevisServer({ directory, runtime });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(base+'/runtime/prepare', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base+'/runtime/prepare', { method: 'POST', headers: { Origin: base } })).status, 403);
  const html = await fetch(base+'/setup?site=%22%3E%3Cscript%3Eevil%3C%2Fscript%3E').then(r => r.text());
  assert.ok(!html.includes('value=""><script>evil'));
  const token = /const token="([a-f0-9]+)"/.exec(html)[1];
  const headers = { Origin: base, 'X-Mirror-Setup': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base+'/runtime/prepare', { method: 'POST', headers })).status, 202); assert.equal(prepared, 1);
  assert.equal((await fetch(base+'/runtime/origin', { method: 'POST', headers, body: JSON.stringify({ site: 'http://evil.example' }) })).status, 400);
  assert.equal((await fetch(base+'/health', { headers: { Origin: 'https://studio.example' } })).status, 403);
  assert.equal((await fetch(base+'/runtime/origin', { method: 'POST', headers, body: JSON.stringify({ site: 'https://studio.example/path' }) })).status, 200);
  assert.equal((await fetch(base+'/health', { headers: { Origin: 'https://studio.example' } })).status, 200);
  assert.equal((await fetch(base+'/runtime/status', { headers: { Origin: 'https://studio.example' } })).status, 403);
  const preflight = await fetch(base+'/jobs', { method: 'OPTIONS', headers: { Origin: 'https://studio.example' } });
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'allowed-origins.json'))), ['https://studio.example']);
  console.log('Helper API: local setup token, hostile Origin, HTML escaping, explicit HTTPS approval and private-network preflight passed.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
