// 极客版第三批测试：复杂度路由、质检、重试引擎、Blender 预演、其余五类 handler。
//
// 这一批测的核心是「钱」和「停手」：
//  - 复杂度路由必须保守：不该上 Blender 的别上（Blender 很贵）
//  - 质检的 fail 必须可靠：每一次误判都意味着重跑，重跑就是钱
//  - 重试引擎绝不能原地打转：同一招不用两次，用尽就交给人而不是烧余额
//  - 拼接必须按镜号而不是完成时间，缺镜头宁可失败也不交残片

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { applySql, createD1 } from './d1-stub.mjs';

const load = async (path) => {
  const r = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const d1 = createD1();
for (const f of fs.readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()) {
  applySql(d1, fs.readFileSync(`drizzle/${f}`, 'utf8'));
}

// ---- 造一个基准镜头 ----
const { buildShotDna } = await load('app/lib/shot-dna/build.ts');
const analysis = {
  schema_version: 'video-dna.v1',
  source: { duration_seconds: 30, aspect_ratio: '9:16', language: 'zh', format_type: '', one_line_summary: '', rights_risks: [] },
  style_dna: { visual: { medium: '实拍', palette: ['冷蓝'], textures: ['颗粒'], atmosphere: '压抑', lighting_logic: '' } },
  source_roles: [], beats: [], preserve_recommendations: [], replace_recommendations: [],
  originality_risks: [], uncertainties: [],
};
const baseBeat = {
  beat_id: 'B1', start_seconds: 0, end_seconds: 8,
  role_ids: ['ROLE_A'], narrative_function: '', visual_action: '一个人站着说话',
  action_beats: [{ at_seconds: 0, actor_ids: ['ROLE_A'], action: '开口' }],
  environment: '室内，办公室', props: [],
  framing: '中景', camera_motion: '固定机位', composition: '',
  lighting: '侧光', color: '', sound: '',
  dialogue: { speaker_role: 'ROLE_A', speaker_on_screen: true, source_text: '你好', semantic_intent: '', delivery: '', approx_characters: 2 },
  transition_in: '', continuity_in: '', continuity_out: '', confidence: 0.9,
};
const simple = buildShotDna(baseBeat, analysis, { projectId: 'P', idx: 0 });

// ============ 复杂度引擎 ============
const { analyzeComplexity, needsKeyframe, routeShots } = await load('app/lib/complexity/engine.ts');

// 一个人、固定机位、8 秒、一拍动作 —— 这种镜头上 Blender 就是纯烧钱
const c1 = analyzeComplexity(simple);
assert.equal(c1.needsBlender, false, `简单镜头不该上 Blender，得分 ${c1.score}：${JSON.stringify(c1.factors)}`);
assert.equal(c1.reasons.length, 0);

// 四人 + 环绕运镜 + 两人中途进出画 + 多层景深 —— 这种必须上
const hard = structuredClone(simple);
hard.actors = [
  { character_id: 'A', role_in_shot: '', screen_position: 'left', depth_layer: 'foreground', facing: '', wardrobe: '', props_held: [] },
  { character_id: 'B', role_in_shot: '从画右走入', screen_position: 'right', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [], entry_at: 2 },
  { character_id: 'C', role_in_shot: '', screen_position: 'center', depth_layer: 'background', facing: '', wardrobe: '', props_held: [] },
  { character_id: 'D', role_in_shot: '走出画面', screen_position: 'center_right', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [], exit_at: 6 },
];
hard.camera.movement = 'orbit';
hard.action_timeline = [
  { at: 0, actor_ids: ['A'], action: '指', toward_ids: ['B'] },
  { at: 2, actor_ids: ['B'], action: '推', toward_ids: ['C'] },
  { at: 4, actor_ids: ['C'], action: '递', toward_ids: ['D'] },
];
const c2 = analyzeComplexity(hard);
assert.equal(c2.needsBlender, true, `复杂镜头必须上 Blender，得分 ${c2.score}`);
assert.ok(c2.reasons.length >= 2, '要说得出为什么上，用户才判断得了值不值');
assert.ok(c2.score > c1.score * 3);

// 中等复杂度：不上 Blender，但要给提示词加强用的警告
const mid = structuredClone(simple);
mid.actors = [
  { character_id: 'A', role_in_shot: '', screen_position: 'left', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] },
  { character_id: 'B', role_in_shot: '', screen_position: 'right', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] },
  { character_id: 'C', role_in_shot: '', screen_position: 'center', depth_layer: 'background', facing: '', wardrobe: '', props_held: [] },
];
const c3 = analyzeComplexity(mid);
assert.equal(c3.needsBlender, false, `三人静态镜头不值得上 Blender，得分 ${c3.score}`);

// 用户强制：跳过评分但仍然把分数算给他看
const forced = analyzeComplexity(simple, { forceBlender: true });
assert.equal(forced.needsBlender, true);
assert.equal(forced.score, c1.score, '强制启用不该篡改评分，用户要看得到真实复杂度');
assert.ok(forced.reasons[0].includes('强制'));

// 关键帧路由
assert.equal(needsKeyframe(simple), true, '首镜必须出关键帧');
const sameScene = { ...structuredClone(simple), shot_id: 'S2', idx: 1 };
assert.equal(needsKeyframe(sameScene, simple), false, '同场同角色的后续镜头不必每镜都出图（每张都是钱）');
const newLocation = structuredClone(simple);
newLocation.shot_id = 'S3'; newLocation.environment.location = '室外，街道';
assert.equal(needsKeyframe(newLocation, simple), true, '换场要出图');
const newCast = structuredClone(simple);
newCast.shot_id = 'S4';
newCast.actors = [...simple.actors, { character_id: 'ROLE_NEW', role_in_shot: '', screen_position: 'right', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] }];
assert.equal(needsKeyframe(newCast, simple), true, '新角色登场要出图');

const routed = routeShots([simple, hard]);
assert.equal(routed[0].needsBlender, false);
assert.equal(routed[1].needsBlender, true);
assert.equal(routed[0].seconds, 8);

// ============ 质检 ============
const { structuralQa, visualQa, mergeReports } = await load('app/lib/qa/report.ts');

const goodProbe = { durationSeconds: 8, width: 720, height: 1280, bytes: 2_000_000, hasAudio: true };
assert.equal(structuralQa({ dna: simple, probe: goodProbe }).verdict, 'pass');

// 时长短了要判废：拼接时会整条错位
const shortR = structuralQa({ dna: simple, probe: { ...goodProbe, durationSeconds: 5 } });
assert.equal(shortR.verdict, 'fail');
assert.ok(shortR.findings.some((f) => f.code === 'duration_mismatch'));
// 长了还能裁，只警告
assert.equal(structuralQa({ dna: simple, probe: { ...goodProbe, durationSeconds: 9 } }).verdict, 'warn');

// 空文件
assert.equal(structuralQa({ dna: simple, probe: { ...goodProbe, bytes: 100 } }).verdict, 'fail');

// 画幅比错了不能靠缩放救
const aspect = structuralQa({
  dna: simple, probe: { ...goodProbe, width: 1280, height: 720 },
  expectedResolution: { width: 720, height: 1280 },
});
assert.equal(aspect.verdict, 'fail');
assert.ok(aspect.findings.some((f) => f.code === 'aspect_mismatch'));

// 有对白没音轨 → 警告而非判废
assert.equal(structuralQa({ dna: simple, probe: { ...goodProbe, hasAudio: false } }).verdict, 'warn');

// 视觉检查：形象崩了要判废，且失败分类要对
const drift = visualQa({
  dna: simple, charactersPresent: { ROLE_A: true },
  identityMatch: { ROLE_A: 0.3 }, modelConfidence: 0.9,
});
assert.equal(drift.verdict, 'fail');
assert.equal(drift.primaryFailure, 'identity_drift');

// ⭐ 最重要的一条：模型没把握时，fail 要降级成 warn。
// 没有这条规则，一个爱说「不确定」的模型会把用户的钱一次次烧在重跑上。
const unsure = visualQa({
  dna: simple, charactersPresent: { ROLE_A: false }, modelConfidence: 0.4,
});
assert.equal(unsure.verdict, 'warn', '低置信度的 fail 必须降级，否则会误杀好镜头再花一份钱重跑');
assert.ok(unsure.findings[0].message.includes('把握不足'));

// pop-in
const popin = visualQa({ dna: simple, charactersPresent: { ROLE_A: true }, popInDetected: true, modelConfidence: 0.9 });
assert.equal(popin.primaryFailure, 'popin');

// 漏演：漏一半以上判废，漏一两拍只警告
const manyBeats = structuredClone(simple);
manyBeats.action_timeline = [0, 1, 2, 3].map((i) => ({ at: i, actor_ids: ['ROLE_A'], action: `动作${i}` }));
assert.equal(visualQa({ dna: manyBeats, charactersPresent: { ROLE_A: true }, actionsPerformed: { 0: false, 1: false, 2: true, 3: true }, modelConfidence: 0.9 }).verdict, 'fail');
assert.equal(visualQa({ dna: manyBeats, charactersPresent: { ROLE_A: true }, actionsPerformed: { 0: false, 1: true, 2: true, 3: true }, modelConfidence: 0.9 }).verdict, 'warn');

// 合并：任一 fail 即 fail
assert.equal(mergeReports('S1', [
  structuralQa({ dna: simple, probe: goodProbe }),
  drift,
]).verdict, 'fail');

// ============ 重试引擎 ============
const { decideRetry, withinRetryBudget } = await load('app/lib/qa/retry.ts');
const ctxBase = { attempt: 1, maxAttempts: 4, usedStrategies: [], blenderEnabled: false, hasFallbackProvider: true, splittable: true };

// 形象崩 → 先重做关键帧，不是原样重跑
const d1r = decideRetry(drift, ctxBase);
assert.equal(d1r.strategy, 'regenerate_keyframe');
assert.equal(d1r.regenerateKeyframe, true);
assert.equal(d1r.newSeed, false);

// 空间错 → 直接上 Blender，这就是它存在的意义
const spatial = { shotId: 'S', verdict: 'fail', score: 0.2, findings: [{ code: 'x', verdict: 'fail', confidence: 0.9, message: '走位错了', failureClass: 'spatial_wrong' }], primaryFailure: 'spatial_wrong' };
assert.equal(decideRetry(spatial, ctxBase).strategy, 'enable_blender');
// 已经在用 Blender 了就不能再拿它当新招
assert.notEqual(decideRetry(spatial, { ...ctxBase, blenderEnabled: true }).strategy, 'enable_blender');

// 轻微瑕疵是唯一适合原样重跑的场景，且必须换 seed
const minor = { shotId: 'S', verdict: 'fail', score: 0.6, findings: [{ code: 'a', verdict: 'fail', confidence: 0.9, message: '多了只手', failureClass: 'minor_artifact' }], primaryFailure: 'minor_artifact' };
const dm = decideRetry(minor, ctxBase);
assert.equal(dm.strategy, 'regenerate_same');
assert.equal(dm.newSeed, true, '原样重跑不换 seed 等于把同一张废片再买一次');

// 参数被拒：重试多少次都一样，直接交给人
const rejected = { shotId: 'S', verdict: 'fail', score: 0, findings: [], primaryFailure: 'provider_rejected' };
assert.equal(decideRetry(rejected, ctxBase).strategy, 'manual');

// ⭐ 绝不原地打转：同一招不用两次，用尽就停手
const used = [];
let ctxLoop = { ...ctxBase, usedStrategies: used };
const seen = new Set();
for (let i = 0; i < 6; i += 1) {
  const d = decideRetry(drift, ctxLoop);
  if (d.strategy === 'manual') break;
  assert.ok(!seen.has(d.strategy), `策略 ${d.strategy} 被重复使用，等于原地打转烧钱`);
  seen.add(d.strategy);
  used.push(d.strategy);
  ctxLoop = { ...ctxLoop, usedStrategies: [...used], attempt: i + 2 };
}
assert.equal(decideRetry(drift, { ...ctxLoop, attempt: 9 }).strategy, 'manual', '次数用尽必须停手交给人');

// 没有备用 Provider 时不该建议换家
const unavailable = { shotId: 'S', verdict: 'fail', score: 0, findings: [], primaryFailure: 'provider_unavailable' };
assert.notEqual(decideRetry(unavailable, { ...ctxBase, hasFallbackProvider: false }).strategy, 'switch_provider');

// 成本闸：重试累计不许超过预估的若干倍
assert.equal(withinRetryBudget(200, 100).ok, true);
const over = withinRetryBudget(400, 100);
assert.equal(over.ok, false);
assert.ok(over.reason.includes('停止自动重试'));

// ============ Blender ============
const { buildScene, buildFilmScene, frameHalfWidth, frameHalfHeight, resolutionFor, validateScene, describeBlocking, describeCameraPath } = await load('app/lib/blender/protocol.ts');
const { generateBlenderPython } = await load('app/lib/blender/python.ts');
const { MockBlenderRunner, previsShot } = await load('app/lib/blender/runner.ts');

const scene = buildScene(hard, { aspectRatio: '9:16' });
assert.equal(scene.schema_version, 'blender-scene.v1');
assert.equal(scene.actors.length, 4);
// 屏幕位置要真的变成不同的世界坐标，否则四个人会叠在一起
const xs = scene.actors.map((a) => a.position.x);
assert.equal(new Set(xs).size, 4, `四个不同站位应得到四个不同 X，实际 ${xs}`);
// 景深层要变成不同的 Y
assert.ok(scene.actors[0].position.y < scene.actors[2].position.y, '前景应该比背景离相机近');
// 中途入画的人要有走位路径，起点在画外
const mover = scene.actors.find((a) => a.id === 'B');
assert.ok(mover.path.length >= 2, '中途入画的角色必须有走位关键帧');
// 画外不再是写死的 ±5 米，而是"在这个景别的画框之外"——断言也要照这个本意写
{
  const dist = Math.abs(scene.camera.position.y - scene.camera.lookAt.y);
  const halfW = frameHalfWidth(dist, scene.camera.focalLength, scene.aspectRatio);
  assert.ok(Math.abs(mover.path[0].position.x) > halfW,
    `走位起点应该在画框外：起点 x=${mover.path[0].position.x}，画面半宽 ${halfW.toFixed(2)}m`);
}
assert.equal(mover.path[1].at, 2, '第 2 秒到位');
// 环绕运镜要产出多点机位路径
assert.ok(scene.camera.path.length >= 4, '环绕运镜需要多个机位采样点');
assert.ok(scene.outputs.includes('path_animation'), '有走位时应该渲路径动画');

// 固定机位简单镜头不该渲动画（渲染很贵）
const simpleScene = buildScene(simple, { aspectRatio: '9:16' });
assert.equal(simpleScene.camera.path.length, 0);
assert.ok(!simpleScene.outputs.includes('path_animation'), '固定机位不必渲动画');

// 景别要真的影响机位距离
const cu = structuredClone(simple); cu.camera.shot_size = 'CU';
const ls = structuredClone(simple); ls.camera.shot_size = 'LS';
const cuDist = Math.abs(buildScene(cu, { aspectRatio: '9:16' }).camera.position.y - buildScene(cu, { aspectRatio: '9:16' }).camera.lookAt.y);
const lsDist = Math.abs(buildScene(ls, { aspectRatio: '9:16' }).camera.position.y - buildScene(ls, { aspectRatio: '9:16' }).camera.lookAt.y);
assert.ok(cuDist < lsDist, `特写机位应该比全景近，实际 ${cuDist} vs ${lsDist}`);

// 场景校验要抓到人物重叠
const overlap = structuredClone(simple);
overlap.actors = [
  { character_id: 'X', role_in_shot: '', screen_position: 'center', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] },
  { character_id: 'Y', role_in_shot: '', screen_position: 'center', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] },
];
const overlapIssues = validateScene(buildScene(overlap, { aspectRatio: '9:16' }));
assert.ok(overlapIssues.some((i) => i.code === 'actor_overlap'), '两人站同一点会穿模，必须抓到');

// Python 脚本：必须是自包含的，且场景数据以 JSON 内联（拼字符串会被引号炸掉）
const py = generateBlenderPython(scene, { outputDir: '/tmp/out' });
assert.ok(py.includes('import bpy'));
assert.ok(py.includes('TRACK_TO'), '相机应该用约束对准目标，手算欧拉角会万向锁');
assert.ok(py.includes('BLENDER_DONE'), '要有可解析的完成标记');
const jsonStart = py.indexOf('{', py.indexOf('DATA = json.loads'));
assert.ok(JSON.parse(py.slice(jsonStart, py.lastIndexOf('}', py.indexOf('""")', jsonStart)) + 1)).scene, '内联的场景数据必须是合法 JSON');
// 带引号的角色名不该炸掉脚本
const quoted = structuredClone(simple);
quoted.actors = [{ character_id: 'A"B\'C', role_in_shot: '', screen_position: 'center', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] }];
assert.ok(generateBlenderPython(buildScene(quoted, { aspectRatio: '9:16' }), { outputDir: '/tmp' }).includes('A\\"B'), '带引号的名字必须被 JSON 转义');

// 空间描述：这才是 Blender 交给视频模型的主产物
const blocking = describeBlocking(scene);
assert.ok(blocking.includes('画面左侧') && blocking.includes('画面右侧'));
assert.ok(blocking.includes('米'), '相对位置要给出距离，模型才照做得了');
assert.ok(describeCameraPath(scene).includes('弧线'));
assert.ok(describeCameraPath(simpleScene).includes('固定不动'));

// Mock 渲染：即使没装 Blender，空间描述也是真的
const written = [];
const previs = await previsShot(hard, new MockBlenderRunner({ writeFile: async (k) => { written.push(k); } }), { aspectRatio: '9:16' });
assert.ok(previs.result.artifacts.length >= 2);
assert.ok(previs.result.blocking.length > 20, 'Mock 也必须给出真实的空间描述，这部分不依赖渲染');
assert.equal(written.length, previs.result.artifacts.length);

// 场景有硬错误就不该白渲十分钟
const empty = structuredClone(simple);
empty.actors = []; empty.objects = [];
await assert.rejects(() => previsShot(empty, new MockBlenderRunner(), { aspectRatio: '9:16' }), /场景不合法/);

// ============ 其余 handler ============
const H = await load('app/lib/orchestrator/handlers/index.ts');
const { TaskQueue } = await load('app/lib/task/queue.ts');
const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');
const { MemoryObjectStore } = await load('app/lib/storage/object-store.ts');

const shotStore = new Map([[simple.shot_id, simple]]);
const assets = [];
const qaReports = [];
const repo = {
  getShotDna: async (id) => shotStore.get(id) ?? null,
  saveShotDna: async (d) => { shotStore.set(d.shot_id, d); },
  listShotDna: async () => [...shotStore.values()].sort((a, b) => a.idx - b.idx),
  compileContext: async () => ({
    characters: { ROLE_A: { character_id: 'ROLE_A', name: '老周', appearance: '寸头', wardrobe: '夹克' } },
    styleLock: { pacing: '', camera: '', visual: '写实', performance: '', sound: '', negativeConstraints: [] },
    dialogueLanguage: '中文',
  }),
  registerAsset: async (a) => { const id = `asset-${assets.length}`; assets.push({ id, ...a }); return id; },
  assetsOf: async (_p, kind) => assets.filter((a) => a.kind === kind).map((a) => ({ id: a.id, shotId: a.shotId, key: a.key, duration: a.duration ?? 0 })),
  saveQaReport: async (r) => { qaReports.push(r); },
  latestQaOutcomes: async () => Object.fromEntries(qaReports.map((r) => [r.shotId, r.verdict])),
  latestClip: async (_p, shotId) => { const a = assets.filter((x) => x.kind === 'video_result' && x.shotId === shotId).at(-1); return a ? { key: a.key } : null; },
  setShotPrompt: async () => {},
};

const ffmpeg = {
  probe: async () => ({ durationSeconds: 8, width: 720, height: 1280, bytes: 2_000_000, hasAudio: true }),
  cut: async (_s, _a, _b, outKey) => ({ key: outKey, bytes: 1000 }),
  extractFrames: async (_k, at) => at.map((t) => `data:image/png;base64,FRAME${t}`),
  concat: async (keys, outKey) => ({ key: outKey, bytes: keys.length * 1000, durationSeconds: keys.length * 8 }),
};

const queue = new TaskQueue(d1);
const run = async (handler, type, input, key) => {
  await queue.enqueue({ type, idempotencyKey: key, projectId: 'P', input });
  const rt = new WorkerRuntime(queue, { workerId: `w-${key}`, types: [type] }).register(handler);
  return await rt.runOnce();
};

// ---- preprocess ----
const pre = await run(H.createPreprocessHandler({ repo, ffmpeg, sourceKeyOf: async () => 'src/a.mp4' }),
  'preprocess', { projectId: 'P' }, 'h-pre');
assert.equal(pre.status, 'succeeded');
// 源视频缺失要报得明白
const preBad = await run(H.createPreprocessHandler({ repo, ffmpeg, sourceKeyOf: async () => '' }),
  'preprocess', { projectId: 'P' }, 'h-pre-bad');
assert.equal(preBad.status, 'failed');
assert.ok(preBad.error.includes('源视频'));

// ---- analyze ----
const analyzeProvider = { name: 'fake', estimateCents: () => 0, analyze: async () => ({ text: 'OK', promptTokens: 100, completionTokens: 50 }) };
const an = await run(H.createAnalyzeHandler({
  repo, provider: analyzeProvider, creds: { baseUrl: '', apiKey: '' }, model: 'm', instruction: 'i',
  parse: () => [simple],
}), 'analyze', { projectId: 'P' }, 'h-an');
assert.equal(an.status, 'succeeded');

// 解析不出来必须失败，绝不能产出空镜头列表让管线继续跑
const anEmpty = await run(H.createAnalyzeHandler({
  repo, provider: analyzeProvider, creds: { baseUrl: '', apiKey: '' }, model: 'm', instruction: 'i',
  parse: () => [],
}), 'analyze', { projectId: 'P' }, 'h-an-empty');
assert.equal(anEmpty.status, 'failed');
assert.ok(anEmpty.error.includes('没有产出'));

const anBad = await run(H.createAnalyzeHandler({
  repo, provider: analyzeProvider, creds: { baseUrl: '', apiKey: '' }, model: 'm', instruction: 'i',
  parse: () => { throw new Error('不是合法 JSON'); },
}), 'analyze', { projectId: 'P' }, 'h-an-bad');
assert.equal(anBad.status, 'failed');
assert.equal(anBad.failureClass, 'unknown', '解析失败是可重试的，不该当成上游故障');

// ---- keyframe ----
const store = new MemoryObjectStore();
const kf = await run(H.createKeyframeHandler({
  repo, store, model: 'img', creds: { baseUrl: '', apiKey: '' },
  provider: { name: 'img', estimateCents: () => 5, generate: async () => ({ images: [{ dataUri: 'data:image/png;base64,AAAA' }], costCents: 5 }) },
  decodeDataUri: () => ({ bytes: new ArrayBuffer(64), contentType: 'image/png' }),
}), 'keyframe', { projectId: 'P', shotId: simple.shot_id }, 'h-kf');
assert.equal(kf.status, 'succeeded');
assert.equal(store.size, 1, '关键帧必须进对象存储');
assert.ok(assets.some((a) => a.kind === 'keyframe'));

// 模型没返回图要报失败，不能当成功
const kfEmpty = await run(H.createKeyframeHandler({
  repo, store, model: 'img', creds: { baseUrl: '', apiKey: '' },
  provider: { name: 'img', estimateCents: () => 5, generate: async () => ({ images: [] }) },
  decodeDataUri: () => ({ bytes: new ArrayBuffer(0), contentType: '' }),
}), 'keyframe', { projectId: 'P', shotId: simple.shot_id }, 'h-kf-empty');
assert.equal(kfEmpty.status, 'failed');

// ---- blender ----
shotStore.set('HARD', { ...structuredClone(hard), shot_id: 'HARD' });
const bl = await run(H.createBlenderHandler({ repo, store, runner: new MockBlenderRunner(), aspectRatioOf: async () => '9:16' }),
  'blender', { projectId: 'P', shotId: 'HARD' }, 'h-bl');
assert.equal(bl.status, 'succeeded', bl.error);
const blOut = JSON.parse((await queue.byIdempotencyKey('h-bl')).output_json);
assert.ok(blOut.blocking.length > 20, '预演的主产物是空间描述文字');
assert.ok(assets.some((a) => a.kind === 'blender_preview'));

// ---- qa ----
const qaOk = await run(H.createQaHandler({ repo, ffmpeg, expectedResolution: { width: 720, height: 1280 } }),
  'qa', { projectId: 'P', shotId: simple.shot_id, objectKey: 'clip.mp4' }, 'h-qa');
assert.equal(qaOk.status, 'succeeded');
assert.equal(qaReports.at(-1).verdict, 'pass');

// 质检判废时，质检任务本身仍然算成功 —— 废的是出片产物，不是质检
const badFfmpeg = { ...ffmpeg, probe: async () => ({ durationSeconds: 3, width: 720, height: 1280, bytes: 2_000_000, hasAudio: true }) };
const qaFail = await run(H.createQaHandler({ repo, ffmpeg: badFfmpeg }),
  'qa', { projectId: 'P', shotId: simple.shot_id, objectKey: 'clip.mp4' }, 'h-qa-fail');
assert.equal(qaFail.status, 'succeeded', '质检完成了自己的工作，判废写在输出里而不是让任务失败');
assert.equal(JSON.parse((await queue.byIdempotencyKey('h-qa-fail')).output_json).verdict, 'fail');

// 结构检查判废时要跳过视觉检查省钱
let inspected = 0;
await run(H.createQaHandler({ repo, ffmpeg: badFfmpeg, inspect: async () => { inspected += 1; return { charactersPresent: {} }; } }),
  'qa', { projectId: 'P', shotId: simple.shot_id, objectKey: 'clip.mp4' }, 'h-qa-skip');
assert.equal(inspected, 0, '结构已判废就不该再花一次视觉检查的钱');

// ---- merge ----
// 先清掉前面用例留下的质检报告：拼接闸门查的是最新结论，
// 上面那几条故意判废的报告会把这里的正常用例一起挡掉。
qaReports.length = 0;
// ⭐ 顺序必须按镜号而不是完成时间：任务是并发的，第 7 镜可能比第 2 镜先好
shotStore.clear();
shotStore.set('S0', { ...simple, shot_id: 'S0', idx: 0 });
shotStore.set('S1', { ...simple, shot_id: 'S1', idx: 1 });
shotStore.set('S2', { ...simple, shot_id: 'S2', idx: 2 });
assets.length = 0;
// 故意按乱序登记，模拟并发完成
for (const id of ['S2', 'S0', 'S1']) {
  assets.push({ id: `a-${id}`, kind: 'video_result', shotId: id, key: `clip-${id}.mp4`, duration: 8 });
}
let concatOrder = [];
const mg = await run(H.createMergeHandler({ repo, ffmpeg: { ...ffmpeg, concat: async (keys, outKey) => { concatOrder = keys; return { key: outKey, bytes: 1, durationSeconds: 24 }; } } }),
  'merge', { projectId: 'P' }, 'h-mg');
assert.equal(mg.status, 'succeeded');
assert.deepEqual(concatOrder, ['clip-S0.mp4', 'clip-S1.mp4', 'clip-S2.mp4'],
  `拼接顺序必须按镜号，实际 ${concatOrder}`);

// 拼接闸门：有镜头没过质检就不许拼
qaReports.push({ shotId: 'S1', verdict: 'fail', score: 0, findings: [] });
const mgGated = await run(H.createMergeHandler({ repo, ffmpeg }), 'merge', { projectId: 'P' }, 'h-mg-gated');
assert.equal(mgGated.status, 'failed');
assert.ok(mgGated.error.includes('第 2 镜') && mgGated.error.includes('质检'), mgGated.error);
qaReports.length = 0;

// 同一镜重试出了两份成片时，只能取最新那份，不能两份都拼进去
assets.push({ id: 'a-S1b', kind: 'video_result', shotId: 'S1', key: 'clip-S1-retry.mp4', duration: 8 });
let dedupOrder = [];
const mgDedup = await run(H.createMergeHandler({ repo, ffmpeg: { ...ffmpeg, concat: async (keys, out) => { dedupOrder = keys; return { key: out, bytes: 1, durationSeconds: 24 }; } } }),
  'merge', { projectId: 'P' }, 'h-mg-dedup');
assert.equal(mgDedup.status, 'succeeded', mgDedup.error);
assert.deepEqual(dedupOrder, ['clip-S0.mp4', 'clip-S1-retry.mp4', 'clip-S2.mp4'],
  `重试过的镜头只能取最新那份，实际 ${dedupOrder}`);

// 缺镜头宁可失败，也不交一条残片
assets.length = 0;
assets.push({ id: 'a-S0', kind: 'video_result', shotId: 'S0', key: 'clip-S0.mp4', duration: 8 });
const mgShort = await run(H.createMergeHandler({ repo, ffmpeg }), 'merge', { projectId: 'P' }, 'h-mg-short');
assert.equal(mgShort.status, 'failed');
assert.ok(mgShort.error.includes('第 2、3 镜'), `要说清缺哪几镜，实际：${mgShort.error}`);

console.log('极客版第三批测试通过：复杂度（简单镜不上 Blender/复杂镜必上且说得出理由/强制不篡改评分/关键帧按需出图）、质检（时长短判废长只警告/画幅比判废/低置信度 fail 降级防误杀重跑/漏演过半才判废）、重试（按失败分类换打法/同一招不重复/次数用尽交人/原样重跑必换 seed/成本闸）、Blender（站位与景深映射成坐标/景别决定机位距离/走位关键帧/重叠检测/Python 自包含且 JSON 转义/Mock 也给真空间描述/非法场景不白渲）、Handler（源缺失报明白/解析失败不产半成品/关键帧落存储/质检判废不等于任务失败且跳过付费视检/拼接按镜号且缺镜不交残片）。');

// ---- 画幅必须跟着源片走 ----
// 栽过一次：预演写死 960×540 横屏，而源片和出片都是 9:16 竖屏。
// 参考视频画幅不对等于给了个错的构图——在 16:9 里"站在画面左边"的角色，
// 换到 9:16 根本就在画外。比不给参考还糟。
{
  assert.deepEqual(resolutionFor('9:16'), { width: 540, height: 960 }, '竖屏要渲成竖的');
  assert.deepEqual(resolutionFor('16:9'), { width: 960, height: 540 }, '横屏要渲成横的');
  assert.deepEqual(resolutionFor('1:1'), { width: 960, height: 960 }, '方形');
  assert.deepEqual(resolutionFor('1080x1920'), { width: 540, height: 960 }, '也认 1080x1920 这种写法');
  for (const [w, h] of [[540, 960], [960, 540], [960, 960]]) {
    assert.ok(w % 2 === 0 && h % 2 === 0, 'H.264 要求宽高都是偶数');
  }
  // 认不出来的一律抛错，绝不偷偷退回 16:9——那正是上次踩的坑
  for (const bad of ['', '竖屏', '9-16', '0:16', 'abc']) {
    assert.throws(() => resolutionFor(bad), /认不出来|不是正数比例/, `「${bad}」该被拒绝`);
  }
  const vertical = buildScene(hard, { aspectRatio: '9:16' });
  assert.equal(vertical.aspectRatio, '9:16', '画幅要落进场景协议');
  assert.ok(generateBlenderPython(vertical, { outputDir: '/tmp' }).includes('"width": 540'),
    '生成的 Blender 脚本必须按画幅设分辨率');
}

// ---- 全片预演：不在这一镜里的人不能站在画面里 ----
// 全片把所有镜头的角色合并进同一个 3D 场景，不管可见性的话，
// 只在第 3 镜出现的人会从第 0 秒就杵在画面中——而且相机为了框住他会被往后推，
// 说好的近景被撑成全景，景别整个失真。
{
  const mk = (idx, start, end, ids) => ({
    ...hard,
    shot_id: `V${idx}`, idx, start_time: start, end_time: end,
    actors: ids.map((id, n) => ({
      character_id: id, role_in_shot: '', props_held: [], facing: '面向镜头', wardrobe: '',
      screen_position: ['left', 'center', 'right'][n % 3], depth_layer: 'midground',
    })),
  });
  // 甲全程在；乙只在第 2 镜；丙第 3 镜中途才入画
  const s3 = mk(2, 8, 12, ['甲', '丙']);
  s3.actors[1].entry_at = 10;
  const film = buildFilmScene([mk(0, 0, 4, ['甲']), mk(1, 4, 8, ['甲', '乙']), s3], { aspectRatio: '9:16' });

  const vis = (id) => film.actors.find((a) => a.id === id)?.visibility ?? [];
  const visibleAt = (id, t) => {
    const keys = vis(id);
    if (!keys.length) return true;
    let on = false;
    for (const k of keys) { if (k.at <= t + 1e-6) on = k.visible; }
    return on;
  };

  assert.ok(!visibleAt('乙', 1), '乙不在第 1 镜里，第 1 秒不该出现');
  assert.ok(visibleAt('乙', 5), '乙在第 2 镜里，第 5 秒该出现');
  assert.ok(!visibleAt('乙', 10), '乙不在第 3 镜里，第 10 秒该消失');
  assert.ok(!visibleAt('丙', 9), '丙第 10 秒才入画，第 9 秒不该出现');
  assert.ok(visibleAt('丙', 11), '丙入画之后该出现');
  assert.ok(visibleAt('甲', 1) && visibleAt('甲', 5) && visibleAt('甲', 11), '甲全程在场');
  assert.equal(vis('甲').length, 0, '全程在场的人不该有多余的可见性关键帧');

  // 逐镜预演里每个人都在场，不该凭空长出可见性数据
  assert.ok(!buildScene(hard, { aspectRatio: '9:16' }).actors.some((a) => a.visibility?.length),
    '逐镜预演不需要可见性关键帧');

  const py = generateBlenderPython(film, { outputDir: '/tmp' });
  assert.ok(py.includes('hide_render'), 'Blender 脚本要真的隐藏不在场的人');
  assert.ok(py.includes('set_constant_interpolation'), '可见性必须用 CONSTANT 插值，不能淡进淡出');
}
console.log('画幅跟随源片、全片预演出场窗口：通过');

// ---- 景别必须真的决定机位 ----
// 栽过的坑：左右写死成世界坐标 ±2 米，相机为了框住所有人被推到 7.5 米外，
// 于是不管分析说 ECU 还是 LS，渲出来永远是同一个距离，景别整个失真。
{
  const shot = (size, n, aspect = '9:16') => buildScene({
    ...hard, camera: { ...hard.camera, shot_size: size, movement: 'static' },
    actors: ['甲', '乙', '丙'].slice(0, n).map((id, i) => ({
      character_id: id, role_in_shot: '', props_held: [], facing: '面向镜头', wardrobe: '',
      screen_position: ['center', 'left', 'right'][i], depth_layer: 'midground',
    })),
  }, { aspectRatio: aspect });
  const dist = (sc) => +Math.abs(sc.camera.position.y - sc.camera.lookAt.y).toFixed(2);

  // 单人时景别说多远就是多远，一米不差
  assert.equal(dist(shot('MCU', 1)), 2.0, 'MCU 单人就该在 2 米');
  assert.equal(dist(shot('MS', 1)), 3.0, 'MS 单人就该在 3 米');
  assert.equal(dist(shot('LS', 1)), 7.0, 'LS 单人就该在 7 米');
  // 景别之间必须拉开档次，不能被"框住所有人"抹平
  const ladder = ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS'].map((s) => dist(shot(s, 1)));
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i] > ladder[i - 1], `景别阶梯必须单调递增，实际 ${ladder.join(' < ')}`);
  }

  // 相机对准画框中心，不是角色重心：一个人站画右，就该待在画右
  const lone = buildScene({
    ...hard, camera: { ...hard.camera, shot_size: 'MS', movement: 'static' },
    actors: [{ character_id: '甲', role_in_shot: '', props_held: [], facing: '面向镜头', wardrobe: '', screen_position: 'right', depth_layer: 'midground' }],
  }, { aspectRatio: '9:16' });
  assert.equal(lone.camera.position.x, 0, '相机必须钉在画框中心');
  assert.ok(lone.actors[0].position.x > 0, '站画右的人就该在 x 正方向，不该被摆到正中');

  // 所有人天然在画内，不需要把相机往后拖
  for (const n of [1, 2, 3]) {
    const sc = shot('MS', n);
    const halfW = frameHalfWidth(dist(sc), sc.camera.focalLength, sc.aspectRatio);
    for (const a of sc.actors) {
      assert.ok(Math.abs(a.position.x) <= halfW, `${n} 人时 ${a.id} 跑到画外了：x=${a.position.x}，半宽 ${halfW.toFixed(2)}`);
    }
  }

  // 竖屏的水平视野比横屏窄，摆位必须跟着画幅变，否则 9:16 里人全在画外
  const v = shot('MS', 3, '9:16'), h = shot('MS', 3, '16:9');
  const spread = (sc) => Math.max(...sc.actors.map((a) => Math.abs(a.position.x)));
  assert.ok(spread(v) < spread(h), `竖屏摆位应该更窄：竖 ${spread(v).toFixed(2)} vs 横 ${spread(h).toFixed(2)}`);

  // 物理上装不下时可以退，但必须说出来，不许闷着改
  const crowded = shot('ECU', 3);
  assert.ok(dist(crowded) > 0.6, '大特写装不下三个人，机位得退');
  assert.ok(/ECU 装不下 3 个人/.test(crowded.framingNote ?? ''), `机位退让必须写进 framingNote，实际：${crowded.framingNote}`);
  assert.equal(shot('MS', 1).framingNote, undefined, '没退让就别编一条说明出来');
}
console.log('景别真的决定机位、相机钉在画框中心、退让有交代：通过');

// ---- 墙必须顶满画框 ----
// 墙高原来写死 3.2 米，9:16 竖画框上面三分之一全是空的暗区。
// 参考视频白白浪费三分之一，而它是要喂给出片模型的。
{
  const sc = (aspect) => buildScene({
    ...hard, camera: { ...hard.camera, shot_size: 'MS', movement: 'static' },
    actors: [{ character_id: '甲', role_in_shot: '', props_held: [], facing: '面向镜头', wardrobe: '', screen_position: 'center', depth_layer: 'midground' }],
  }, { aspectRatio: aspect });
  for (const aspect of ['9:16', '16:9', '1:1']) {
    const s = sc(aspect);
    const toWall = s.room.depth / 2 - s.camera.position.y;
    const topOfFrame = s.camera.position.z + frameHalfHeight(toWall, s.camera.focalLength, aspect);
    assert.ok(s.room.height >= topOfFrame,
      `${aspect} 的墙没顶到画框顶：墙高 ${s.room.height}，画框顶 ${topOfFrame.toFixed(2)}`);
  }
  assert.ok(sc('9:16').room.height > sc('16:9').room.height, '竖画框更高，墙也该更高');
}
console.log('墙顶满画框：通过');
