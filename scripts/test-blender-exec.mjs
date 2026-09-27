// 验证跑 Blender 的进程包装。
//
// 真 Blender 只有在场景够大时才会渲完不退出，靠"跑一次真渲染"碰运气验不出来，
// 所以这里用假 Blender 把三条路径逐个逼出来：干净退出 / 渲完装死 / 什么都没产出就卡住。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBlenderExec } from '../worker/blender-exec.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-exec-'));
const fake = path.join(tmp, 'fake-blender.mjs');

// 假 Blender：argv[2] 决定它怎么表现，argv[3] 是 result.json 要写去哪个目录。
fs.writeFileSync(fake, `
import fs from 'node:fs';
import path from 'node:path';
const [mode, dir] = process.argv.slice(2);
if (mode !== 'never-finish') {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ artifacts: ['frames/'] }));
}
if (mode === 'clean') { console.log('渲完，正常退出'); process.exit(0); }
setInterval(() => {}, 1000);          // 装死，永不退出
`);

const cases = [];
const check = (name, ok, detail) => {
  cases.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const run = async (mode, opts) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'run-'));
  const exec = makeBlenderExec({ onWarn: () => {}, pollMs: 100, ...opts });
  const t0 = Date.now();
  const r = await exec(process.execPath, [fake, mode, dir], dir);
  return { ...r, ms: Date.now() - t0, dir };
};

console.log('== Blender 进程包装 ==');

// 1. 正常退出：不该被宽限期拖慢。
{
  const r = await run('clean', { graceMs: 5000 });
  check('干净退出时立刻返回', r.code === 0 && r.ms < 2000, `${r.ms}ms`);
  check('正常退出走进程自己的 stdout', r.stdout.includes('渲完，正常退出'));
}

// 2. 渲完却不退出 —— 这次实测栽过两回的那条路。
{
  const r = await run('hang', { graceMs: 400 });
  check('渲完装死会被主动结束', r.code === 0 && r.stdout.includes('BLENDER_DONE'), `${r.ms}ms`);
  check('产出的 result.json 保住了', fs.existsSync(path.join(r.dir, 'result.json')));
  check('不会一直吊着调用方', r.ms < 4000, `${r.ms}ms`);
}

// 3. 什么都没产出就卡住 —— 这是真失败，不能当成功放过去。
{
  const r = await run('never-finish', { graceMs: 5000, hardTimeoutMs: 400 });
  check('没有产出就卡住 = 失败', r.code !== 0, `退出码 ${r.code}`);
  check('失败原因写清楚了', /未产出 result\.json/.test(r.stderr), r.stderr.slice(0, 60));
}

// 收尾：确认没留下野进程（Windows 上 kill 不带 /T 会漏子进程）。
if (process.platform === 'win32') {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*fake-blender*' }).Count`],
  { encoding: 'utf8' }).trim();
  check('假 Blender 没有残留进程', out === '0' || out === '', `残留 ${out || 0} 个`);
}

fs.rmSync(tmp, { recursive: true, force: true });

const failed = cases.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n❌ ${failed.length} 项没过：${failed.map((f) => f.name).join('、')}`);
  process.exit(1);
}
console.log(`\n✅ ${cases.length} 项全过`);
