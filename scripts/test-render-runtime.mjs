import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRenderRuntime } from '../worker/previs/runtime.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-runtime-'));
const bytes = Buffer.from('test official archive');
let downloadCount = 0, failTest = false;
const options = {
  directory, candidates: [], platform: 'win32', arch: 'x64',
  manifest: { version: '4.5.3', url: 'https://download.blender.org/release/Blender4.5/test.zip', sha256: createHash('sha256').update(bytes).digest('hex'), folder: 'blender-4.5.3-windows-x64' },
  fetchImpl: async () => { downloadCount++; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); },
  extract: async (archive, folder) => { assert.equal(path.extname(archive), '.zip', 'Windows Expand-Archive requires .zip'); await fs.mkdir(path.join(folder, 'blender-4.5.3-windows-x64'), { recursive: true }); await fs.writeFile(path.join(folder, 'blender-4.5.3-windows-x64', 'blender.exe'), 'mock'); },
  test: async () => { if (failTest) throw new Error('test render failed'); },
};
try {
  const runtime = createRenderRuntime(options);
  assert.equal(runtime.status().ready, false);
  await runtime.prepare();
  assert.equal(runtime.status().ready, true);
  assert.match(runtime.blender(), /blender.exe$/);
  await runtime.prepare(); assert.equal(downloadCount, 1);
  const bad = createRenderRuntime({ ...options, directory: path.join(directory, 'bad'), manifest: { ...options.manifest, sha256: '0'.repeat(64) } });
  await assert.rejects(bad.prepare(), /校验/); assert.equal(bad.status().ready, false);
  failTest = true;
  const failed = createRenderRuntime({ ...options, directory: path.join(directory, 'failed') });
  await assert.rejects(failed.prepare(), /test render failed/); assert.equal(failed.status().ready, false);
  assert.equal(failed.status().phase, 'error');
  failTest = false;
  const offlineZip = path.join(directory, 'offline.zip'); await fs.writeFile(offlineZip, bytes);
  const countBefore = downloadCount;
  const offline = createRenderRuntime({ ...options, directory: path.join(directory, 'offline') });
  await offline.prepare(offlineZip); assert.equal(offline.status().ready, true); assert.equal(downloadCount, countBefore);
  const restored = createRenderRuntime({ ...options }); await restored.detect(); assert.equal(restored.status().ready, true);
  let release;
  const busy = createRenderRuntime({ ...options, directory: path.join(directory, 'busy'), fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => { release = () => resolve(new Response(bytes)); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const installing = busy.prepare();
  assert.equal(busy.status().phase, 'preparing', 'lock upload UI before asynchronous disk checks');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(busy.prepare(), /正在/); busy.cancel(); await assert.rejects(installing); assert.equal(busy.status().ready, false);
  console.log('Render environment: verified install, idempotence, checksum failure, render failure, restore and cancellation passed; no network/model calls.');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
