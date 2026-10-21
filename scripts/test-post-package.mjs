// 后期包装层第 3b/4 阶段的纯逻辑单测：段落裁剪与排序、默认字幕、时刻手动修正优先、
// planOutputCalls（缺失/过期/复用/价格未知）、视频转发路由的把关。全程不联网、不调模型。
import assert from 'node:assert/strict';
import { build } from 'esbuild';

process.on('uncaughtException', error => { console.error(error); process.exitCode = 1; });
const load = async path => {
  const result = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const segments = await load('app/lib/post/segments.ts');
const pkg = await load('app/lib/post/package.ts');
const guard = await load('app/lib/post/download-guard.ts');
const { buildTimeline } = await load('app/lib/post/timeline.ts');
const { videoModel } = await load('app/lib/video-models.ts');
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} ≠ ${expected}`);

// ---- 裁剪：模型多交的秒数裁回设计时长；手填优先；不超过实测 ----
assert.equal(segments.segmentKeepSeconds({ padded: 0.4, plannedSeconds: 9.6, durationSeconds: 10.04 }), 9.6);
assert.equal(segments.segmentKeepSeconds({ padded: 0, plannedSeconds: 9.6, durationSeconds: 10.04 }), undefined, '没垫秒数就整段保留');
assert.equal(segments.segmentKeepSeconds({ padded: 0.4, plannedSeconds: 9.6, durationSeconds: 9.5 }), undefined, '实测比设计还短时不裁');
assert.equal(segments.segmentKeepSeconds({ padded: 0.4, plannedSeconds: 9.6, durationSeconds: 10.04 }, 7), 7, '手填优先');
assert.equal(segments.segmentKeepSeconds({ padded: 0, plannedSeconds: 5, durationSeconds: 5 }, 12), 5, '手填不超过实测');

// ---- 同一段多份取最新 ----
const latest = segments.latestByRun([{ runId: 'A', createdAt: 1, tag: 'old' }, { runId: 'A', createdAt: 3, tag: 'new' }, { runId: 'B', createdAt: 2, tag: 'b' }]);
assert.equal(latest.A.tag, 'new'); assert.equal(latest.B.tag, 'b');

// ---- 拼接顺序与裁剪进入时间轴 ----
const runs = [
  { run_id: 'RUN_01', beat_ids: ['B01', 'B02'], source_start_seconds: 0, source_end_seconds: 8, duration_seconds: 8 },
  { run_id: 'RUN_02', beat_ids: ['B03'], source_start_seconds: 8, source_end_seconds: 12, duration_seconds: 4 },
];
const tl = buildTimeline([
  { id: 'RUN_01', durationSeconds: 8.04 },
  { id: 'RUN_02', durationSeconds: 5.04, trimTo: segments.segmentKeepSeconds({ padded: 1, plannedSeconds: 4, durationSeconds: 5.04 }) },
]);
assert.deepEqual(tl.segments.map(s => s.id), ['RUN_01', 'RUN_02']);
near(tl.segments[1].outputStart, 8.04, 'RUN_02 start'); near(tl.segments[1].keepSeconds, 4, 'RUN_02 trimmed'); near(tl.duration, 12.04, 'total');

// ---- 默认字幕：去说话人标签、按镜头时间窗、多句按字数分 ----
assert.deepEqual(pkg.dialogueLines('CHAR_A: 你好呀 CHAR_B：别碰我的手机'), ['你好呀', '别碰我的手机']);
assert.deepEqual(pkg.dialogueLines('CHAR_A: “喂？”\nCHAR_A: 谁在那'), ['喂？', '谁在那']);
const beats = [
  { beat_id: 'B01', start_seconds: 0, end_seconds: 4, dialogue: 'CHAR_A: 今天主人不在家' },
  { beat_id: 'B02', start_seconds: 4, end_seconds: 8, dialogue: '' },
  { beat_id: 'B03', start_seconds: 8, end_seconds: 12, dialogue: 'CHAR_A: 一二 CHAR_B: 三四五六' },
];
const caps1 = pkg.defaultCaptionLines(runs[0], beats);
assert.deepEqual(caps1, [{ beatId: 'B01', text: '今天主人不在家', from: 0, to: 0.5 }]);
const caps2 = pkg.defaultCaptionLines(runs[1], beats);
assert.equal(caps2.length, 2); near(caps2[0].to, 2 / 6, '按字数分'); near(caps2[1].to, 1, '最后一句到段尾');
// 编辑：行数不变沿用时间窗；行数变了按字数重铺；默认变了编辑作废
const base = pkg.captionBase(caps2);
assert.deepEqual(pkg.effectiveCaptionLines(caps2, { base, lines: ['甲', '乙'] }).map(l => [l.text, l.from]), [['甲', 0], ['乙', caps2[1].from]]);
const relaid = pkg.effectiveCaptionLines(caps2, { base, lines: ['一句', '', '两句话'] });
assert.deepEqual(relaid.map(l => l.text), ['一句', '两句话']); near(relaid[0].to, 2 / 5, '重铺'); near(relaid[1].to, 1, '重铺到尾');
assert.equal(pkg.effectiveCaptionLines(caps2, { base: '旧默认', lines: ['x'] }), caps2, '默认变了编辑作废');

// ---- 时刻：手动修正优先于按比例换算 ----
const analysis = { beats: [{ beat_id: 'B01', start_seconds: 0, end_seconds: 4, action_beats: [] }, { beat_id: 'B02', start_seconds: 4, end_seconds: 8 }, { beat_id: 'B03', start_seconds: 8, end_seconds: 12 }] };
const moment = { id: 'm1', beat_id: 'B03', kind: 'reversal', label: '主人推门', anchor: { type: 'beat', position: 0.5 }, source_seconds: 10, emphasis: 3 };
const mseg = pkg.momentSegments(runs, tl.segments);
const auto = pkg.momentOutputTime(analysis, moment, mseg);
near(auto.seconds, 8.04 + 0.5 * 4, '按比例'); assert.equal(auto.manual, false);
const manual = pkg.momentOutputTime(analysis, moment, mseg, { m1: 9.5 });
assert.equal(manual.seconds, 9.5); assert.equal(manual.manual, true);
assert.equal(pkg.momentOutputTime(analysis, moment, mseg, { m1: -1 }).manual, false, '负数不算修正');

// ---- 包装轨：默认字幕开、闪白只打强度 3、弹字默认关 ----
assert.deepEqual(pkg.DEFAULT_TOGGLES, { captions: true, flash: true, pop: false });
const captions = { RUN_01: caps1, RUN_02: caps2 };
const weak = { ...moment, id: 'm2', emphasis: 2, label: '偷看' };
let overlays = pkg.buildOverlays({ toggles: pkg.DEFAULT_TOGGLES, segments: tl.segments, captions, moments: [{ moment, seconds: 10 }, { moment: weak, seconds: 5 }] });
assert.deepEqual(overlays.map(o => o.type).sort(), ['caption', 'caption', 'caption', 'flash']);
near(overlays.find(o => o.type === 'caption').end, 4.02, '字幕按保留时长换算');
assert.equal(overlays.find(o => o.type === 'flash').at, 10);
overlays = pkg.buildOverlays({ toggles: { captions: false, flash: false, pop: true }, segments: tl.segments, captions, moments: [{ moment, seconds: 10 }, { moment: weak, seconds: 5 }, { moment: { ...weak, id: 'm3', emphasis: 1 }, seconds: 6 }, { moment: { ...weak, id: 'm4' }, seconds: undefined }], popText: { m2: '偷看！' } });
assert.deepEqual(overlays.map(o => [o.type, o.text]), [['pop', '主人推门'], ['pop', '偷看！']]);

// ---- 指纹 ----
const body = { model: 'seedance-2.5', prompt: 'p', seconds: '8', reference_images: ['data:...'] };
const fp1 = await segments.requestFingerprint(body, ['asset-a']);
assert.deepEqual(await segments.requestFingerprint({ ...body, reference_images: ['data:other'] }, ['asset-a']), fp1, '图片压缩不同不算内容变化');
assert.deepEqual(await segments.requestFingerprint({ seconds: '8', prompt: 'p', model: 'seedance-2.5' }, ['asset-a']), fp1, '键顺序无关');
const fpPrompt = await segments.requestFingerprint({ ...body, prompt: 'q' }, ['asset-a']);
const fpParam = await segments.requestFingerprint({ ...body, seconds: '10' }, ['asset-a']);
const fpAsset = await segments.requestFingerprint(body, ['asset-b']);
assert.notEqual(fpPrompt.requestHash, fp1.requestHash);
assert.equal(segments.segmentFreshness({ ...fp1, origin: 'relay' }, fp1), 'fresh');
assert.equal(segments.segmentFreshness({ ...fp1, origin: 'relay' }, fpPrompt), 'stale-prompt');
assert.equal(segments.segmentFreshness({ ...fp1, origin: 'relay' }, fpParam), 'stale-params');
assert.equal(segments.segmentFreshness({ ...fp1, origin: 'relay' }, fpAsset), 'stale-params');
assert.equal(segments.segmentFreshness({ requestHash: '', promptHash: '', origin: 'local' }, fp1), 'unknown');
assert.equal(segments.segmentFreshness({ ...fp1, origin: 'relay' }, undefined), 'unknown');

// ---- planOutputCalls：缺失/过期/复用/在跑/装不下/价格未知 ----
const seedance = videoModel('seedance-2.5');
const plan = (seconds) => ({ seconds, billedSeconds: seconds, padded: 0 });
const result = segments.planOutputCalls({
  model: seedance, resolution: '480p',
  runs: [
    { runId: 'R1', plannedSeconds: 8, plan: plan(8), current: fp1 },        // 有且没变 → 复用
    { runId: 'R2', plannedSeconds: 8, plan: plan(8), current: fpPrompt },   // 有但提示词变了 → 过期
    { runId: 'R3', plannedSeconds: 5, plan: plan(5), current: fp1 },        // 没有 → 缺失
    { runId: 'R4', plannedSeconds: 5, plan: plan(5), current: fp1 },        // 在跑 → 不计
    { runId: 'R5', plannedSeconds: 30, plan: { billedSeconds: 15, padded: 0, blocked: '装不下' }, current: fp1 },
    { runId: 'R6', plannedSeconds: 5, plan: plan(5), current: fp1 },        // 本机文件 → 复用
  ],
  segments: { R1: { ...fp1, origin: 'relay' }, R2: { ...fp1, origin: 'relay' }, R6: { requestHash: '', promptHash: '', origin: 'local' } },
  pending: ['R4'],
});
assert.deepEqual(result.runs.map(r => r.status), ['reuse', 'stale', 'missing', 'pending', 'blocked', 'reuse']);
assert.deepEqual(result.toGenerate.map(r => r.runId), ['R2', 'R3']);
assert.equal(result.reusable, 2); assert.equal(result.pending, 1); assert.equal(result.blocked, 1);
const { estimateCredits } = await load('app/lib/video-models.ts');
const expected = Number(((estimateCredits(seedance, 8, '480p') ?? 0) + (estimateCredits(seedance, 5, '480p') ?? 0)).toFixed(2));
assert.ok(expected > 0); assert.equal(result.knownCredits, expected); assert.equal(result.unknownPrice, 0);
const text = segments.describeCallPlan(result).join('\n');
assert.match(text, /已完成且提示词没变的 1 段直接复用，不重复扣费/);
assert.match(text, /另有 1 段是本机文件或来源不明/);
assert.match(text, /R2：已过期，提示词变了/); assert.match(text, /R3：还没有视频/);
// 价格未知：绝不编数
const unknownModel = { ...seedance, price: { unit: 'second', credits: {} } };
const unknown = segments.planOutputCalls({ model: unknownModel, runs: [{ runId: 'X', plannedSeconds: 5, plan: plan(5) }], segments: {}, pending: [] });
assert.equal(unknown.toGenerate[0].credits, undefined); assert.equal(unknown.unknownPrice, 1); assert.equal(unknown.knownCredits, 0);
assert.match(segments.describeCallPlan(unknown).join('\n'), /价格未知/);
// 改包装不涉及任何段落 → 要生成 0 段
const allDone = segments.planOutputCalls({ model: seedance, runs: [{ runId: 'R1', plannedSeconds: 8, plan: plan(8), current: fp1 }], segments: { R1: { ...fp1, origin: 'relay' } }, pending: [] });
assert.equal(allDone.toGenerate.length, 0);

// ---- 转发下载的地址把关 ----
for (const bad of ['http://cdn.example.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://localhost/a.mp4', 'https://10.1.2.3/a.mp4', 'https://192.168.1.5/a.mp4', 'https://172.20.0.1/a.mp4', 'https://169.254.169.254/latest', 'https://100.64.0.1/a', 'https://0.0.0.0/a', 'https://[::1]/a', 'https://[fd00::1]/a', 'https://[fe80::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://2130706433/a', 'https://0x7f.1/a', 'https://user:pw@cdn.example.com/a', 'https://cdn.example.com:8443/a', 'https://printer.local/a', 'https://intranet/a', 'file:///etc/passwd', 'ftp://x.com/a', 42, '']) {
  assert.throws(() => guard.checkDownloadUrl(bad), undefined, `应拒绝 ${bad}`);
}
assert.equal(guard.checkDownloadUrl('https://cdn.example.com/v/a.mp4?sig=1').hostname, 'cdn.example.com');
assert.equal(guard.checkDownloadUrl('https://8.8.8.8/a.mp4').hostname, '8.8.8.8');
assert.ok(guard.isVideoContentType('video/mp4')); assert.ok(guard.isVideoContentType('video/webm; codecs=vp9'));
for (const type of ['text/html', 'application/octet-stream', 'image/png', null, 'video/', 'videox/mp4']) assert.equal(guard.isVideoContentType(type), false, String(type));
assert.equal(guard.checkContentLength(null), null); assert.equal(guard.checkContentLength('1000'), null);
assert.match(guard.checkContentLength(String(guard.MAX_SEGMENT_BYTES + 1)), /超过/);

// ---- 路由：未登录拒绝、只转 https 公网视频、跳转逐跳复查、流式转发 ----
const originalFetch = globalThis.fetch;
const env = { NODE_ENV: process.env.NODE_ENV, MIRROR_AUTH_ENABLED: process.env.MIRROR_AUTH_ENABLED };
process.env.NODE_ENV = 'development';
try {
  const { POST } = await load('app/api/relay/video-file/route.ts');
  const calls = [];
  let reply = () => new Response('video-bytes', { headers: { 'content-type': 'video/mp4', 'content-length': '11' } });
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), ...options }); return reply(String(url)); };
  const req = (url, headers = {}) => new Request('http://localhost:3000/api/relay/video-file', { method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'x-relay-base': 'https://heyroute.ai/v1', ...headers }, body: JSON.stringify({ url }) });
  process.env.MIRROR_AUTH_ENABLED = 'true';
  process.env.SUPABASE_URL = ''; // 未登录：没有会话 Cookie
  const unauth = await POST(req('https://cdn.example.com/a.mp4'));
  assert.ok([401, 503].includes(unauth.status), `未登录应拒绝，实际 ${unauth.status}`);
  assert.equal(calls.length, 0, '未登录不能发出任何请求');
  process.env.MIRROR_AUTH_ENABLED = 'false';
  const ok = await POST(req('https://cdn.example.com/a.mp4'));
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'video/mp4'); assert.equal(await ok.text(), 'video-bytes');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store'); assert.equal(calls.at(-1).redirect, 'manual');
  assert.equal((await POST(req('https://cdn.example.com/a.mp4', { origin: 'https://evil.com' }))).status, 400);
  for (const bad of ['http://cdn.example.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://[::1]/a.mp4', 'https://192.168.0.2/a.mp4']) {
    const before = calls.length;
    assert.equal((await POST(req(bad))).status, 400, bad); assert.equal(calls.length, before, `${bad} 不应发请求`);
  }
  reply = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  assert.equal((await POST(req('https://cdn.example.com/a.mp4'))).status, 415);
  reply = () => new Response('x', { headers: { 'content-type': 'application/octet-stream' } });
  assert.equal((await POST(req('https://cdn.example.com/a.mp4'))).status, 415);
  reply = () => new Response('x', { headers: { 'content-type': 'video/mp4', 'content-length': String(guard.MAX_SEGMENT_BYTES + 1) } });
  assert.equal((await POST(req('https://cdn.example.com/a.mp4'))).status, 413);
  // 跳转到内网：逐跳复查后拒绝，不去请求内网
  reply = url => url.includes('cdn.example.com') ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }) : new Response('secret', { headers: { 'content-type': 'video/mp4' } });
  const before = calls.length;
  assert.equal((await POST(req('https://cdn.example.com/a.mp4'))).status, 400);
  assert.equal(calls.length, before + 1, '内网跳转目标不能被请求');
  // 合法跳转可以跟
  reply = url => url.includes('cdn.example.com') ? new Response(null, { status: 302, headers: { location: 'https://oss.example.net/b.mp4' } }) : new Response('ok', { headers: { 'content-type': 'video/mp4' } });
  const followed = await POST(req('https://cdn.example.com/a.mp4'));
  assert.equal(followed.status, 200); assert.equal(calls.at(-1).url, 'https://oss.example.net/b.mp4');
  reply = () => new Response('gone', { status: 403, headers: { 'content-type': 'text/plain' } });
  assert.equal((await POST(req('https://cdn.example.com/a.mp4'))).status, 502);
} finally {
  globalThis.fetch = originalFetch;
  process.env.NODE_ENV = env.NODE_ENV;
  if (env.MIRROR_AUTH_ENABLED === undefined) delete process.env.MIRROR_AUTH_ENABLED; else process.env.MIRROR_AUTH_ENABLED = env.MIRROR_AUTH_ENABLED;
}
console.log('Post package: trim/order, caption defaults, moment overrides, planOutputCalls, download proxy guards passed; no network or model calls.');
