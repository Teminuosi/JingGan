// 「附带 3D 预演参考」开关：判定函数、提示词措辞、请求指纹 / 缓存键随开关变化、干跑计数跟着开关走。
// 全部离线：不发任何模型 / 中转请求。
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
globalThis.fetch = () => { throw new Error('Network/model requests forbidden'); };

const { resolvePrevisAttach, PREVIS_ATTACH_REASONS: R } = await load('app/lib/previs-attach.ts');
const models = await load('app/lib/video-models.ts');
const segments = await load('app/lib/post/segments.ts');
const relay = await load('app/lib/relay-client.ts');

// ---- 1. 判定函数：每种带不了的原因、能不能一键去补 ----
const ok = { omni: true, preserve: true, previsReady: true, stale: false, matched: true };
assert.deepEqual(resolvePrevisAttach(ok), { attachable: true, on: true, reason: '' }, '能带时默认开');
assert.deepEqual(resolvePrevisAttach({ ...ok, choice: false }), { attachable: true, on: false, reason: '' });
assert.deepEqual(resolvePrevisAttach({ ...ok, choice: true, exportFormat: 'mp4' }), { attachable: true, on: true, reason: '' });
assert.deepEqual(resolvePrevisAttach({ ...ok, omni: false, choice: true }), { attachable: false, on: false, reason: R.model });
assert.deepEqual(resolvePrevisAttach({ ...ok, preserve: false }), { attachable: false, on: false, reason: R.rewrite });
assert.deepEqual(resolvePrevisAttach({ ...ok, previsReady: false, matched: false }), { attachable: false, on: false, reason: R.missing, action: 'go-previs' });
assert.deepEqual(resolvePrevisAttach({ ...ok, stale: true }), { attachable: false, on: false, reason: R.stale, action: 'go-previs' });
assert.deepEqual(resolvePrevisAttach({ ...ok, matched: false }), { attachable: false, on: false, reason: R.missing, action: 'go-previs' });
assert.deepEqual(resolvePrevisAttach({ ...ok, exportFormat: 'webm', choice: true }), { attachable: false, on: false, reason: R.webm });
// 先说最根本的原因：模型不收 > 重写模式 > 没预演 > 过期 > 没对上 > 格式。
assert.equal(resolvePrevisAttach({ omni: false, preserve: false, previsReady: false, stale: true, matched: false, exportFormat: 'webm' }).reason, R.model);
assert.equal(resolvePrevisAttach({ ...ok, preserve: false, previsReady: false }).reason, R.rewrite);
assert.equal(resolvePrevisAttach({ ...ok, stale: true, matched: false }).reason, R.stale);

// ---- 2. 提示词：开 = 参考视频管走位；关 = 只按文字分镜 ----
const omni = models.videoModel('seedance-2.5');
const web = '镜头一：甲走向门口。\n\n绑定本段 3D 预演作为走位、构图与运镜参考；以文字动作和角色图为准，不生成灰模外观。';
const promptOn = models.toApiPrompt(web, ['CHAR_A'], omni, { referenceVideo: true });
const promptOff = models.toApiPrompt(web, ['CHAR_A'], omni, { referenceVideo: false });
assert.ok(promptOn.includes(models.REFERENCE_VIDEO_LINE));
assert.ok(!promptOn.includes('不需要参考视频'));
assert.ok(!promptOff.includes(models.REFERENCE_VIDEO_LINE));
assert.ok(promptOff.includes('只用角色图和以下文字分镜，不需要参考视频。'));
assert.equal(promptOff, models.toApiPrompt(web, ['CHAR_A'], omni), '关 = 原来的纯文字措辞');

// ---- 3. 指纹 / 缓存键：开关进身份，签名链接不进 ----
const identity = 'browser:abc:1:shot-0:-';
const bodyFor = (on, url) => models.buildVideoRequest(omni, { model: omni.id, seconds: 8, prompt: on ? promptOn : promptOff, referenceImages: [], ...(url ? { referenceVideos: [url] } : {}) });
const urlA = 'https://jinggan.example/api/reference-media/a.mp4?exp=1&sig=aaa';
const urlB = 'https://jinggan.example/api/reference-media/b.mp4?exp=2&sig=bbb';
const fpOn = await segments.requestFingerprint(bodyFor(true, urlA), ['asset'], identity, promptOff);
const fpOnOtherUrl = await segments.requestFingerprint(bodyFor(true, urlB), ['asset'], identity, promptOff);
const fpOff = await segments.requestFingerprint(bodyFor(false), ['asset'], undefined, promptOff);
assert.deepEqual(fpOn, fpOnOtherUrl, '每次上传换签名链接，指纹不变');
assert.notEqual(fpOn.requestHash, fpOff.requestHash, '开关 3D 改变请求身份');
assert.equal(fpOn.promptHash, fpOff.promptHash, '开关 3D 只算参数变了，不算用户改了提示词');
assert.equal(segments.segmentFreshness({ ...fpOn, origin: 'relay' }, fpOff), 'stale-params');
assert.equal(segments.segmentFreshness({ ...fpOff, origin: 'relay' }, fpOn), 'stale-params');
assert.equal(segments.segmentFreshness({ ...fpOff, origin: 'relay' }, fpOff), 'fresh');
const keyOnA = await relay.videoCacheKey('p', 'RUN_01', bodyFor(true, urlA), identity);
const keyOnB = await relay.videoCacheKey('p', 'RUN_01', bodyFor(true, urlB), identity);
const keyOff = await relay.videoCacheKey('p', 'RUN_01', bodyFor(false));
assert.equal(keyOnA, keyOnB, '缓存键不含签名链接');
assert.notEqual(keyOnA, keyOff, '开 / 关 是两份不同的任务');

// ---- 4. 干跑计数跟着开关走：已带 3D 出过片，关掉就要重出（只报告，不自动提交） ----
const plan = models.resolveSeconds(omni, 8);
const callPlan = current => segments.planOutputCalls({
  runs: [{ runId: 'RUN_01', plannedSeconds: 8, plan, current }],
  segments: { RUN_01: { ...fpOn, origin: 'relay' } }, pending: [], model: omni,
});
assert.equal(callPlan(fpOn).runs[0].status, 'reuse');
assert.equal(callPlan(fpOn).toGenerate.length, 0);
assert.equal(callPlan(fpOff).runs[0].status, 'stale');
assert.equal(callPlan(fpOff).runs[0].freshness, 'stale-params');
assert.equal(callPlan(fpOff).toGenerate.length, 1);

console.log('Previs attach toggle: resolver states/reasons, prompt on/off, fingerprint & cache key identity, call plan passed; no network calls.');
