// 真浏览器验证后期包装层（app/lib/post/compose.ts）：
// 用 esbuild 把 compose/timeline 打成浏览器包，起一个只监听 127.0.0.1 的临时静态服务，
// 用本机 Chrome（无头、独立用户目录，不碰已开着的浏览器）跑 composeFilm，产物交回 node 用 ffprobe/ffmpeg 核对。
// 不调用任何模型或中转，不进生产构建。
//
// 用法：node scripts/verify-post-compose.mjs <工作目录>
//   工作目录/in/ 需要 seg1.mp4 … segN.mp4（可选 bgm.m4a）；没有就从 POST_VERIFY_SOURCE 指向的三花猫原片和预演片自动切出来。
//   CHROME_PATH 覆盖 Chrome 路径。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const WORK = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'jinggan-post-verify'));
const IN = path.join(WORK, 'in');
const OUT = path.join(WORK, 'out');
fs.mkdirSync(IN, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const SOURCE = process.env.POST_VERIFY_SOURCE ?? 'F:/claude-project/视频复刻/jinggan-tutorial/素材';
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
if (!fs.existsSync(path.join(IN, 'seg1.mp4'))) {
  const cat = path.join(SOURCE, '原片-三花猫偷玩手机.mp4');
  const previs = path.join(SOURCE, '预演-Blender本机-v2.mp4');
  ffmpeg('-i', cat, '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', path.join(IN, 'seg1.mp4'));
  ffmpeg('-ss', '5', '-i', cat, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', path.join(IN, 'seg2.mp4'));
  fs.copyFileSync(previs, path.join(IN, 'seg3.mp4'));
  fs.copyFileSync(cat, path.join(IN, 'seg4.mp4'));
  // 横屏 16:9 段：验证比例不同时加黑边。
  ffmpeg('-ss', '2', '-t', '2.5', '-i', cat, '-vf', 'crop=720:405:0:420', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', path.join(IN, 'seg5.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=495:duration=8', '-filter_complex', '[0][1]amix=inputs=2,volume=0.5', '-c:a', 'aac', path.join(IN, 'bgm.m4a'));
}
const SEGMENTS = fs.readdirSync(IN).filter(name => /^seg\d+\.mp4$/.test(name)).sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)));

const bundle = await build({
  stdin: { contents: "import { buildTimeline } from './app/lib/post/timeline.ts'; import { composeFilm, measureSegments } from './app/lib/post/compose.ts'; window.__post = { buildTimeline, composeFilm, measureSegments };", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'chrome120',
});
const bundleJs = bundle.outputFiles[0].text;
const page = '<!doctype html><meta charset="utf-8"><title>post verify</title><script type="module" src="/bundle.js"></script><body>post verify</body>';

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(page); }
  if (url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundleJs); }
  if (url.startsWith('/in/') && req.method === 'GET') {
    const file = path.join(IN, path.basename(url));
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    return fs.createReadStream(file).pipe(res);
  }
  if (url.startsWith('/out/') && req.method === 'PUT') {
    const stream = fs.createWriteStream(path.join(OUT, path.basename(url)));
    req.pipe(stream);
    return stream.on('finish', () => res.end('ok'));
  }
  res.statusCode = 404; res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'post-verify-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let text = '';
  chrome.stderr.on('data', chunk => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
  chrome.on('exit', code => reject(new Error(`Chrome 提前退出：${code}`)));
  setTimeout(() => reject(new Error('Chrome 启动超时')), 20000);
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
const consoleLines = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); if (message.error) reject(new Error(message.error.message)); else resolve(message.result); }
  if (message.method === 'Runtime.consoleAPICalled') consoleLines.push(message.params.args.map(a => a.value ?? a.description).join(' '));
  if (message.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + JSON.stringify(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });

const results = [];
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: origin + '/' }, sessionId);
  for (let i = 0; i < 100; i++) {
    const { result } = await send('Runtime.evaluate', { expression: 'typeof window.__post', returnByValue: true }, sessionId);
    if (result.value === 'object') break;
    await new Promise(r => setTimeout(r, 100));
  }

  const runs = [{ name: 'film-default.mp4', bgm: false }, { name: 'film-bgm.mp4', bgm: true }];
  for (const run of runs) {
    const expression = `(async () => {
      const P = window.__post;
      const names = ${JSON.stringify(SEGMENTS)};
      const blobs = await Promise.all(names.map(n => fetch('/in/' + n).then(r => r.blob())));
      const bgm = ${run.bgm} ? await fetch('/in/bgm.m4a').then(r => r.blob()) : null;
      const t0 = performance.now();
      const durations = await P.measureSegments(blobs);
      const trims = { 1: 3.5, 3: 6 };
      const segments = names.map((n, i) => ({ id: n, durationSeconds: durations[i], trimTo: trims[i] }));
      const draft = P.buildTimeline(segments);
      const at = i => draft.segments[i]?.outputStart ?? 0;
      const end = i => draft.segments[i]?.outputEnd ?? draft.duration;
      const overlays = [
        { type: 'caption', text: '今天主人出门了，我决定偷偷玩一下他的手机。', start: at(0) + 0.3, end: end(0) - 0.1, speaker: '三花猫' },
        { type: 'caption', text: '结果一不小心点开了外卖软件，还下了一单小鱼干！', start: at(1), end: end(1) },
        { type: 'caption', text: '这一段是预演镜头，比例不同会自动加黑边，字幕照样放在安全区里。', start: at(2), end: end(2) },
        { type: 'caption', text: '主人回来了……我该怎么解释呢？', start: at(3), end: end(3) },
        { type: 'flash', at: at(1) },
        { type: 'flash', at: at(3) },
        { type: 'pop', text: '下单成功！', at: at(1) + 1.5, duration: 1.5 },
        ...(draft.segments[4] ? [{ type: 'caption', text: '横屏素材也能放进竖屏成片。', start: at(4), end: end(4) }] : []),
      ];
      const timeline = P.buildTimeline(segments, overlays, { fps: 30 });
      const tMeasured = performance.now();
      let lastProgress = 0;
      const result = await P.composeFilm({ segments: blobs, timeline, width: 720, height: 1280, audio: bgm ? { blob: bgm, gain: 0.2 } : undefined, onProgress: v => { lastProgress = v; } });
      const t1 = performance.now();
      await fetch('/out/${run.name}', { method: 'PUT', body: result.blob });
      return JSON.stringify({ durations, timeline, measureMs: Math.round(tMeasured - t0), composeMs: Math.round(t1 - tMeasured), lastProgress, result: { size: result.blob.size, extension: result.extension, width: result.width, height: result.height, frames: result.frames, seconds: result.seconds, hasAudio: result.hasAudio }, ua: navigator.userAgent });
    })()`;
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(`${run.name} 合成失败：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    results.push({ run, ...JSON.parse(result.value) });
  }
} finally {
  socket.close();
  chrome.kill();
  server.close();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
}

const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,sample_rate,channels:format=duration,size', '-of', 'json', file]).toString());
const meanVolume = (file, start, length) => {
  const run = spawnSync('ffmpeg', ['-v', 'info', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return (run.stderr.match(/mean_volume: (\S+) dB/) ?? [])[1] ?? 'n/a';
};
for (const item of results) {
  const file = path.join(OUT, item.run.name);
  const info = probe(file);
  const expected = item.timeline.duration;
  console.log(`\n=== ${item.run.name} ===`);
  console.log('实测段长:', item.durations.map(d => d.toFixed(3)).join(', '), '→ 时间轴总长', expected.toFixed(3), 's');
  console.log('段窗口:', item.timeline.segments.map(s => `${s.id} ${s.outputStart.toFixed(2)}–${s.outputEnd.toFixed(2)}`).join(' | '));
  console.log('耗时: 量时长', item.measureMs, 'ms, 合成编码', item.composeMs, 'ms; 结果', JSON.stringify(item.result));
  console.log('ffprobe:', JSON.stringify(info));
  const streams = info.streams.map(s => s.codec_type);
  if (!streams.includes('video') || !streams.includes('audio')) throw new Error('缺视频或音频流');
  const duration = Number(info.format.duration);
  if (Math.abs(duration - expected) > 0.15) throw new Error(`时长不符：${duration} vs ${expected}`);
  const video = info.streams.find(s => s.codec_type === 'video');
  if (video.width !== 720 || video.height !== 1280) throw new Error('分辨率不符');
  item.file = file;
}
// 音频落位：预演段（无声）在默认版里应接近静音，猫段应有声；BGM 版各段都应有声。
console.log('\n各段音量（mean_volume dB，段首尾各让 0.3 秒）：');
for (const item of results) {
  console.log(item.run.name, item.timeline.segments.map(s => `${s.id}: ${meanVolume(item.file, s.outputStart + 0.3, Math.max(0.5, s.outputEnd - s.outputStart - 0.6))}`).join(' | '));
}
const plain = results.find(r => !r.run.bgm);

// 抽帧：字幕、闪白第一帧、闪白结束后、弹字、预演段（540x960 放大）、第四段字幕、横屏段黑边。
const t = plain.timeline;
const frames = {
  'caption-seg1': 2.5,
  'flash-start': t.segments[1].outputStart + 0.01,
  'flash-after': t.segments[1].outputStart + 0.25,
  'pop-mid': t.segments[1].outputStart + 2.2,
  'previs-540x960': t.segments[2].outputStart + 4,
  'caption-seg4': t.segments[3].outputStart + 4.5,
  ...(t.segments[4] ? { 'letterbox-16x9': t.segments[4].outputStart + 1.2 } : {}),
};
for (const [name, at] of Object.entries(frames)) ffmpeg('-ss', at.toFixed(3), '-i', plain.file, '-frames:v', '1', path.join(OUT, `${name}.png`));
console.log('\n抽帧:', Object.entries(frames).map(([n, at]) => `${path.join(OUT, n + '.png')} @${at.toFixed(2)}s`).join('\n'));
console.log('\n浏览器:', results[0].ua);
if (consoleLines.length) console.log('页面日志:', consoleLines.join('\n'));
console.log('\nPost compose browser verification passed. 输出目录：', OUT);
