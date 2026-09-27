import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const source = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Pass a built lightweight helper directory');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-launch-'));
const directory = path.join(temp, "with spaces'中文");
await fs.cp(source, directory, { recursive: true });
const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, PREVIS_PORT: String(port), LOCALAPPDATA: path.join(temp, 'data'), MIRROR_HELPER_TEST: '1', MIRROR_HELPER_PACKAGE_TEST_PATH: directory };
try {
  const result = await exec('cmd.exe', ['/d', '/c', path.join(directory, '启动镜感助手.bat')], { env, cwd: directory, windowsHide: true, timeout: 120000 });
  assert.ok(result.stdout.includes('HELPER_READY'), result.stdout + result.stderr);
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()); assert.equal(health.setup, true);
  console.log('Actual BAT launcher passed in a path containing spaces, apostrophe and Chinese; no browser opened.');
} finally {
  await exec('powershell.exe', ['-NoProfile', '-Command', '$ownedPid=(Get-NetTCPConnection -LocalPort ([int]$env:PREVIS_PORT) -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($ownedPid){$p=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"; if($p.CommandLine.Contains($env:MIRROR_HELPER_PACKAGE_TEST_PATH)){Stop-Process -Id $ownedPid}}'], { env, windowsHide: true });
  await fs.rm(temp, { recursive: true, force: true });
}
