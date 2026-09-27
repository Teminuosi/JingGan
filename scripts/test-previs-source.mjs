import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPrevisServer } from '../worker/previs/server.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'previs-source-'));
const projectId = randomUUID();
const good = randomUUID();
const broken = randomUUID();
await fs.mkdir(path.join(directory, good));
await fs.mkdir(path.join(directory, broken));
const video = path.join(directory, good, 'source');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16:rate=2:duration=1', '-c:v', 'libx264', '-f', 'mp4', video], { windowsHide: true });
for (const [id, at] of [[good, 1], [broken, 2]]) {
  await fs.writeFile(path.join(directory, id, 'job.json'), JSON.stringify({ id, projectId, status: 'failed', createdAt: at }));
  await fs.writeFile(path.join(directory, id, 'input.json'), JSON.stringify({ analysis: { source: { duration_seconds: 1 } } }));
}
await fs.writeFile(path.join(directory, broken, 'source'), 'partial upload');
let modelCalls = 0;
const server = await createPrevisServer({ directory, blenderPath: 'unused', createModel() { modelCalls++; throw new Error('Forbidden'); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const endpoint = `${base}/projects/${projectId}/source`;
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const headers = { Origin: 'http://localhost:3000' };
  assert.equal((await fetch(`${base}/projects/${randomUUID()}/source`, { headers })).status, 404);
  const response = await fetch(endpoint, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(video));
  assert.equal(modelCalls, 0);
  console.log('Source reuse passed: exact bytes, project isolation, origin restriction, partial-upload fallback, zero model calls.');
} finally { await new Promise(resolve => server.close(resolve)); }
