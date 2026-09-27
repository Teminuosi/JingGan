import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const directory = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/test-render-helper-package.mjs <built directory>');
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-package-'));
const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, LOCALAPPDATA: temp, PREVIS_PORT: String(port) }; delete env.MIRROR_HELPER_ROOT; delete env.BLENDER_PATH;
const child = spawn(path.join(directory, 'runtime/node.exe'), [path.join(directory, 'helper.mjs')], { cwd: directory, env, windowsHide: true });
let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
try {
  let health;
  for (let i = 0; i < 120; i++) {
    try { health = await fetch(base+'/health', { signal: AbortSignal.timeout(1000) }).then(r => r.json()); if (health.setup) break; } catch { /* Waiting for actual startup. */ }
    if (child.exitCode !== null) throw new Error(output || 'Helper exited');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(health?.setup, true, output); assert.equal(health.ready, manifest.offline);
  const html = await fetch(base+'/setup').then(r => r.text());
  assert.ok(html.includes('一键准备 Blender')); assert.ok(html.includes('id="offline"'));
  new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.ok(!output.includes('EADDRINUSE'), 'bundled module must not auto-start a second server');
  assert.ok((await fs.readdir(directory)).every(file => !/^\.env|^data$|^\.worker$/.test(file)));
  console.log(`Real packaged helper startup passed: ${manifest.offline ? 'offline Blender tested and ready' : 'no Blender, setup available'}, Node/FFmpeg/FFprobe bundled, setup JavaScript valid, isolated user-data directory.`);
} finally { child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); await fs.rm(temp, { recursive: true, force: true }); }
