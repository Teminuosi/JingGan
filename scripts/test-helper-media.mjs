import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ensureMediaRuntime } from '../worker/previs/media-runtime.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-media-'));
const bytes = Buffer.from('verified archive');
const manifest = { version: 'test', folder: 'ffmpeg-test', url: 'https://github.com/GyanD/codexffmpeg/releases/download/test/test.zip', sha256: createHash('sha256').update(bytes).digest('hex') };
let downloads = 0, extracts = 0;
const download = async (_, target) => { downloads++; await fs.writeFile(target, bytes); };
const extract = async (_, target) => { extracts++; await fs.mkdir(path.join(target, manifest.folder, 'bin'), { recursive: true }); for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await fs.writeFile(path.join(target, manifest.folder, 'bin', name), 'binary'); };
const test = async binary => { await fs.access(binary); };
try {
  await assert.rejects(ensureMediaRuntime({ directory: path.join(root, 'bad'), manifest: { ...manifest, sha256: '0'.repeat(64) }, download, extract, test }), /checksum/i);
  assert.equal(extracts, 0, 'unverified archive must never be extracted');
  const value = await ensureMediaRuntime({ directory: path.join(root, 'good'), manifest, download, extract, test });
  assert.ok(value.ffprobe.endsWith('ffprobe.exe'));
  const count = downloads;
  await ensureMediaRuntime({ directory: path.join(root, 'good'), manifest, download, extract, test });
  assert.equal(downloads, count, 'restart must reuse verified runtime');
  console.log('Media setup: checksum failure blocks extraction; verified install and restart reuse passed.');
} finally { await fs.rm(root, { recursive: true, force: true }); }
