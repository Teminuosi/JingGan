// 极客版第二批测试：Shot DNA、Prompt Compiler、连续性引擎、编排器与 Worker 运行时。
//
// 测的不是「函数能不能调用」，而是这几条会直接毁掉成片的性质：
//  - Shot DNA 时间轴越界/乱序要被拦；旧数据投影不许编造字段
//  - 提示词必须确定性、超长只许整段丢弃且要回报丢了什么
//  - 连续性必须能抓到换装、轴线跳变、时间跳变，且不许对空数据产生假问题
//  - 任务图必须「拼接依赖全部质检」，依赖没满足的任务绝不能被认领
//  - worker 崩了正在跑的任务必须能被回收，且不会重复扣费

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

// ============ Shot DNA ============
const { buildShotDna, buildShotDnaList } = await load('app/lib/shot-dna/build.ts');
const { validateShotDna, hasErrors } = await load('app/lib/shot-dna/validate.ts');
const { shotCharacterIds, shotDuration } = await load('app/lib/shot-dna/types.ts');

const analysis = {
  schema_version: 'video-dna.v1',
  source: { duration_seconds: 30, aspect_ratio: '9:16', language: 'zh', format_type: '', one_line_summary: '', rights_risks: [] },
  style_dna: { visual: { medium: '实拍', palette: ['冷蓝'], textures: ['颗粒'], atmosphere: '压抑', lighting_logic: '' } },
  source_roles: [], beats: [], preserve_recommendations: [], replace_recommendations: [],
  originality_risks: [], uncertainties: [],
};

const beat = {
  beat_id: 'B1', start_seconds: 0, end_seconds: 19.5,
  role_ids: ['ROLE_A', 'ROLE_B', 'ROLE_C'],
  narrative_function: '立威',
  visual_action: 'A 指向身后的 B，C 见状不再开口',
  action_beats: [
    { at_seconds: 0, actor_ids: ['ROLE_A'], action: '拍桌子' },
    { at_seconds: 6.2, actor_ids: ['ROLE_A'], action: '指向身后', toward_ids: ['ROLE_B'], reaction: '不动声色', consequence: 'A 借到势' },
    { at_seconds: 12.0, actor_ids: ['ROLE_C'], action: '张嘴又闭上', toward_ids: ['ROLE_A'], reaction: '移开视线', consequence: 'C 退让' },
  ],
  environment: '室内，昏暗的仓库，黄昏',
  props: ['木桌'],
  framing: '中景', camera_motion: '固定机位', composition: '三角构图，浅景深',
  lighting: '侧逆光', color: '低饱和', sound: '环境嗡鸣',
  dialogue: { speaker_role: 'ROLE_A', speaker_on_screen: true, source_text: '你再说一遍', semantic_intent: '', delivery: '压低嗓音', approx_characters: 5 },
  transition_in: '硬切', continuity_in: '', continuity_out: 'A 站着，C 低头',
  confidence: 0.9,
};

const dna = buildShotDna(beat, analysis, { projectId: 'P1', idx: 0 });
assert.equal(dna.schema_version, 'shot-dna.v1');
assert.equal(shotDuration(dna), 19.5);
// 枚举要真的从中文里认出来，认不出必须是 unknown 而不是瞎填一个
assert.equal(dna.camera.shot_size, 'MS', `景别应识别为中景，实际 ${dna.camera.shot_size}`);
assert.equal(dna.camera.movement, 'static');
assert.equal(dna.camera.depth_of_field, 'shallow');
assert.equal(dna.environment.interior_exterior, 'interior');
assert.equal(dna.environment.time_of_day, '黄昏');
// 旧分析没有焦距，绝不许编一个出来——编了会被 Blender 当真值用
assert.equal(dna.camera.lens_mm, undefined, '旧数据没有焦距时不许填默认值');
// 秒数必须换算成相对本镜开头
assert.deepEqual(dna.action_timeline.map((f) => f.at), [0, 6.2, 12]);
// 表情/视线要能从 reaction + toward_ids 推出来，这正是老项目丢掉的那条因果链
assert.equal(dna.expression_timeline.length, 2);
assert.equal(dna.expression_timeline[1].character_id, 'ROLE_A');
assert.equal(dna.expression_timeline[1].gaze, 'ROLE_C');
assert.equal(dna.dialogue.speaker_id, 'ROLE_A');
assert.deepEqual(shotCharacterIds(dna).sort(), ['ROLE_A', 'ROLE_B', 'ROLE_C']);

// 角色 ID 映射：投影到创作层要换成 CHAR_*
const mapped = buildShotDna(beat, analysis, { projectId: 'P1', idx: 0, mapCharacterId: (id) => id.replace('ROLE_', 'CHAR_') });
assert.deepEqual(shotCharacterIds(mapped).sort(), ['CHAR_A', 'CHAR_B', 'CHAR_C']);
assert.equal(mapped.action_timeline[1].toward_ids[0], 'CHAR_B');

// 干净的 DNA 不该有 error（warning 可以有：旧数据本来就缺字段）
assert.equal(hasErrors(validateShotDna(dna)), false, JSON.stringify(validateShotDna(dna), null, 2));

// 越界、乱序、引用不存在的角色 —— 三种最会毁掉成片的错都要被抓到
const bad = structuredClone(dna);
bad.action_timeline = [
  { at: 5, actor_ids: ['ROLE_A'], action: '甲' },
  { at: 2, actor_ids: ['ROLE_A'], action: '乙' },          // 乱序
  { at: 99, actor_ids: ['ROLE_Z'], action: '丙' },          // 越界 + 不存在的角色
];
const badIssues = validateShotDna(bad);
const codes = badIssues.map((i) => i.code);
assert.ok(codes.includes('out_of_order'), '乱序必须被抓到');
assert.ok(codes.includes('out_of_range'), '越界必须被抓到');
assert.ok(codes.includes('unknown_character'), '引用不存在的角色必须被抓到');
assert.ok(hasErrors(badIssues));

// 中途入画却没说明怎么进来 → pop-in 风险，必须是 warning 而不是静默通过
const popin = structuredClone(dna);
popin.actors[1].entry_at = 8;
assert.ok(validateShotDna(popin).some((i) => i.code === 'popin_risk'), 'pop-in 风险必须被提示');

// 长镜头没有逐拍动作要警告：一句概括演 19 秒必然演飞
assert.ok(validateShotDna({ ...dna, action_timeline: [] }).some((i) => i.code === 'no_action_timeline'));

assert.equal(buildShotDnaList({ ...analysis, beats: [beat, { ...beat, beat_id: 'B2', start_seconds: 19.5, end_seconds: 25 }] }, 'P1').length, 2);

// ============ 空间信息（blocking）============
// 这是让 3D 预演拿到真数据的唯一来源。没有它，所有角色都会被摆在原点，
// 渲出来是几根叠在一起的柱子，喂给模型的空间描述还会写成「相距 0.0 米」。
const blockedBeat = {
  ...structuredClone(beat),
  beat_id: 'B_BLK',
  blocking: {
    actors: [
      { role_id: 'ROLE_A', screen_position: 'left', depth_layer: 'foreground', facing: '侧身朝右' },
      { role_id: 'ROLE_B', screen_position: 'right', depth_layer: 'background', facing: '面向镜头', entry_at: 6.5 },
      { role_id: 'ROLE_C', screen_position: 'center', depth_layer: 'midground', facing: '背对镜头' },
    ],
    camera: { shot_size: 'MLS', angle: 'low', movement: 'dolly_in', screen_direction: 'toward_camera', subject_distance_m: 4.2 },
  },
};
const blockedDna = buildShotDna(blockedBeat, analysis, { projectId: 'P1', idx: 0 });
// 位置必须来自 blocking，而不是统一填 center
assert.deepEqual(blockedDna.actors.map((a) => a.screen_position), ['left', 'right', 'center']);
assert.deepEqual(blockedDna.actors.map((a) => a.depth_layer), ['foreground', 'background', 'midground']);
assert.equal(blockedDna.actors[0].facing, '侧身朝右');
// 机位枚举直接采用模型给的，不再从散文里猜（散文写的是「中景/固定机位」，blocking 说是 MLS/推近）
assert.equal(blockedDna.camera.shot_size, 'MLS', '有 blocking 时应采信枚举而不是文本匹配');
assert.equal(blockedDna.camera.angle, 'low');
assert.equal(blockedDna.camera.movement, 'dolly_in');
assert.equal(blockedDna.camera.screen_direction, 'toward_camera');
assert.equal(blockedDna.camera.subject_distance_m, 4.2);
// 入画时间要换算成相对本镜开头，和 action_timeline 同一个基准
assert.equal(blockedDna.actors[1].entry_at, 6.5, '本镜从 0 秒开始，绝对 6.5 秒即相对 6.5 秒');
assert.equal(blockedDna.actors[0].entry_at, undefined, '一开始就在画面里的不该有入画时间');

// 同一份数据，镜头从 20 秒开始时入画时间要跟着平移
const shifted = buildShotDna(
  { ...blockedBeat, start_seconds: 20, end_seconds: 39.5,
    action_beats: blockedBeat.action_beats.map((s) => ({ ...s, at_seconds: s.at_seconds + 20 })),
    blocking: { ...blockedBeat.blocking, actors: blockedBeat.blocking.actors.map((a) => a.entry_at ? { ...a, entry_at: 26.5 } : a) } },
  analysis, { projectId: 'P1', idx: 1 });
assert.equal(shifted.actors[1].entry_at, 6.5, '绝对 26.5 秒、本镜从 20 秒起，相对应为 6.5 秒');

// 旧 DNA（没有 blocking）必须退回原行为，不能崩
const legacy = buildShotDna(beat, analysis, { projectId: 'P1', idx: 0 });
assert.deepEqual(legacy.actors.map((a) => a.screen_position), ['center', 'center', 'center']);
assert.equal(legacy.camera.shot_size, 'MS', '没有 blocking 时退回文本匹配');

// 角色映射后 blocking 也要跟着换
const mappedBlk = buildShotDna(blockedBeat, analysis,
  { projectId: 'P1', idx: 0, mapCharacterId: (id) => id.replace('ROLE_', 'CHAR_') });
assert.equal(mappedBlk.actors[0].character_id, 'CHAR_A');
assert.equal(mappedBlk.actors[0].screen_position, 'left', '换了角色 ID 也要找得到对应站位');

// ---- 校验：模型填错要被挡住 ----
const V = await load('app/lib/validation.ts');
const mkDna = (blocking) => ({
  ...analysis,
  source_roles: [{ role_id: 'ROLE_A' }, { role_id: 'ROLE_B' }, { role_id: 'ROLE_C' }],
  beats: [{ ...blockedBeat, blocking }],
});
const rejects = (blocking, why) => {
  let threw = false;
  try { V.assertVideoDnaShape(mkDna(blocking)); } catch { threw = true; }
  assert.ok(threw, why);
};
rejects({ actors: [{ role_id: 'ROLE_A', screen_position: '画面左边', depth_layer: 'foreground', facing: '' }],
  camera: blockedBeat.blocking.camera }, '枚举写成散文必须被拒');
rejects({ actors: [{ role_id: 'ROLE_Z', screen_position: 'left', depth_layer: 'foreground', facing: '' }],
  camera: blockedBeat.blocking.camera }, '引用本镜没有的角色必须被拒');
rejects({ actors: [{ role_id: 'ROLE_A', screen_position: 'left', depth_layer: 'foreground', facing: '', entry_at: 99 }],
  camera: blockedBeat.blocking.camera }, '入画时间落在镜头外必须被拒');
rejects({ actors: blockedBeat.blocking.actors,
  camera: { ...blockedBeat.blocking.camera, movement: '缓缓推近' } }, '机位枚举写成中文必须被拒');

// ============ Prompt Compiler ============
const PC = await load('app/lib/prompt-compiler/index.ts');
const ctx = {
  characters: {
    ROLE_A: { character_id: 'ROLE_A', name: '老周', appearance: '四十岁男性，寸头', wardrobe: '深灰夹克', referenceSlot: '图1' },
    ROLE_B: { character_id: 'ROLE_B', name: '阿强', appearance: '三十岁男性，络腮胡', wardrobe: '黑T恤', referenceSlot: '图2' },
    ROLE_C: { character_id: 'ROLE_C', name: '小林', appearance: '二十多岁男性', wardrobe: '白衬衫', referenceSlot: '图3' },
  },
  styleLock: { pacing: '', camera: '', visual: '写实', performance: '', sound: '', negativeConstraints: ['不要卡通风'] },
  dialogueLanguage: '中文',
};

const p1 = PC.compileShotPrompt(dna, ctx);
assert.equal(p1.template, 'video-shot');
assert.equal(p1.version, 'v1');
// 确定性：同输入必须逐字相同，否则缓存和防重复扣费全部失效
const p1again = PC.compileShotPrompt(dna, ctx);
assert.equal(p1.text, p1again.text);
assert.equal(p1.fingerprint, p1again.fingerprint);
// 进了提示词的内容一变，指纹必须变
const tweaked = structuredClone(dna);
tweaked.action_timeline[1].action = '转身就走';
assert.notEqual(PC.compileShotPrompt(tweaked, ctx).fingerprint, p1.fingerprint);
// 反过来：改了没进提示词的字段，指纹必须保持不变。
// 指纹认的是「这份提示词」而不是「这份 DNA」——有逐拍动作时 summary 根本不进词，
// 它变了重新生成也是一模一样的结果，此时命中缓存才是对的，重跑就是白烧钱。
assert.equal(PC.compileShotPrompt({ ...dna, summary: '换个说法' }, ctx).fingerprint, p1.fingerprint);
// 逐拍动作必须真的进了提示词，而且带秒数
assert.ok(p1.text.includes('6.2s'), '动作时间轴必须逐行进提示词');
assert.ok(p1.text.includes('指向身后'));
assert.ok(p1.text.includes('图1'), '有参考图时必须指认谁是图几');
assert.ok(p1.negative.includes('不要卡通风'));
assert.equal(p1.dropped.length, 0);

// 超长：只许整段丢弃，且必须回报丢了什么。静默截断 = 用户拿到残缺提示词还不知道
const short = PC.compileShotPrompt(dna, { ...ctx, maxChars: 300 });
assert.ok(short.charCount <= 300 || short.sections.length === 1);
assert.ok(short.dropped.length > 0, '超长必须报告被丢弃的段落');
// 先丢低优先级的，动作时间轴（95）绝不能先于声音（30）被丢
assert.ok(short.dropped.includes('sound'), `应先丢声音段，实际丢了 ${short.dropped}`);
assert.ok(!short.dropped.includes('action') || short.sections.length === 1, '动作时间轴不该被优先丢弃');

// 重试加强：不同失败分类要写进不同的加强语，而不是原样重跑
const retried = PC.compileShotPrompt(dna, { ...ctx, retryHint: { failureClass: 'identity_drift', note: '' } });
assert.ok(retried.text.includes('面部特征'), '形象崩了要加强形象约束');
assert.notEqual(retried.fingerprint, p1.fingerprint, '加强后是另一份提示词，指纹必须不同');

// 关键帧模板：中途入画的人不能出现在首帧里
const kf = PC.compileShotPrompt(popin, ctx, { templateName: 'keyframe-first' });
assert.ok(!kf.text.includes('阿强'), '第 8 秒才入画的人不该画进首帧');
assert.ok(kf.text.includes('老周'));
assert.ok(kf.negative.includes('不要运动模糊'));

// 版本对比
const diff = PC.diffPrompts(p1, retried);
assert.ok(diff.some((d) => d.key === 'retry' && d.status === 'added'));

// ============ 连续性引擎 ============
const { checkContinuity, autoFixContinuity, continuitySummary } = await load('app/lib/continuity/engine.ts');

const mk = (over) => ({
  ...structuredClone(dna), shot_id: over.shot_id, idx: over.idx,
  start_time: over.start_time, end_time: over.end_time,
  scene_id: over.scene_id ?? 'S1',
  actors: over.actors ?? structuredClone(dna.actors),
  objects: over.objects ?? [],
  environment: { ...dna.environment, ...(over.environment ?? {}) },
  lighting: { ...dna.lighting, ...(over.lighting ?? {}) },
  camera: { ...dna.camera, ...(over.camera ?? {}) },
  continuity: { from_previous: '', to_next: '', wardrobe_state: {}, prop_state: {}, position_state: {}, ...(over.continuity ?? {}) },
});

const A = mk({
  shot_id: 'S1', idx: 0, start_time: 0, end_time: 10,
  actors: [{ character_id: 'ROLE_A', role_in_shot: '', screen_position: 'left', depth_layer: 'midground', facing: '', wardrobe: '深灰夹克', props_held: [] }],
  objects: [{ object_id: 'O1', name: '木桌', screen_position: 'center', depth_layer: 'midground', state: '完好', persistent: true }],
  continuity: { wardrobe_state: { ROLE_A: '深灰夹克' }, position_state: { ROLE_A: 'left' }, prop_state: { 木桌: '完好' } },
});
// 换装 + 越轴 + 时间跳变 + 道具消失，四个错一次全踩
const B = mk({
  shot_id: 'S2', idx: 1, start_time: 10, end_time: 18,
  actors: [{ character_id: 'ROLE_A', role_in_shot: '', screen_position: 'right', depth_layer: 'midground', facing: '', wardrobe: '白色西装', props_held: [] }],
  environment: { time_of_day: '深夜' },
});
const issues = checkContinuity([A, B]);
const icodes = issues.map((i) => i.code);
assert.ok(icodes.includes('wardrobe_break'), '换装穿帮必须被抓到');
assert.ok(icodes.includes('axis_break'), '越轴必须被抓到');
assert.ok(icodes.includes('time_jump'), '同场时间跳变必须被抓到');
assert.ok(icodes.includes('prop_vanished'), '常驻道具消失必须被抓到');

// 时间轴空隙
const gapIssues = checkContinuity([A, mk({ shot_id: 'S3', idx: 1, start_time: 12, end_time: 18 })]);
assert.ok(gapIssues.some((i) => i.code === 'timeline_gap'));

// 关键性质：空数据不许产生假问题。
// 旧分析投影出来的 DNA 大量字段为空，如果拿空值去比，用户第一次点开就看到几百条噪音，
// 之后他再也不会看这个面板了。
const blankA = buildShotDna(beat, analysis, { projectId: 'P1', idx: 0 });
const blankB = buildShotDna({ ...beat, beat_id: 'B2', start_seconds: 19.5, end_seconds: 25 }, analysis, { projectId: 'P1', idx: 1 });
const blankIssues = checkContinuity([blankA, blankB]);
assert.equal(blankIssues.filter((i) => i.severity === 'error').length, 0,
  `空字段不该产生 error，实际：${JSON.stringify(blankIssues.filter((i) => i.severity === 'error'))}`);

// 自动修复：只修「把上一镜状态传下去」这类不需要判断力的，越轴这种要判断意图的绝不自动改
const C = mk({
  shot_id: 'S4', idx: 1, start_time: 10, end_time: 18,
  actors: [{ character_id: 'ROLE_A', role_in_shot: '', screen_position: 'left', depth_layer: 'midground', facing: '', wardrobe: '', props_held: [] }],
});
const inheritIssues = checkContinuity([A, C]);
assert.ok(inheritIssues.some((i) => i.code === 'wardrobe_inherit'));
const { shots: fixed, applied } = autoFixContinuity([A, C], inheritIssues);
assert.equal(fixed[1].actors[0].wardrobe, '深灰夹克', '没写服装的镜头应沿用上一镜');
assert.equal(fixed[1].revision, C.revision + 1, '一次修复只算一次修订，哪怕同一镜修了好几处');
assert.ok(applied.length >= 2, '这一镜同时缺服装和丢了常驻道具，两处都该修');
assert.equal(C.actors[0].wardrobe, '', '自动修复不许改入参，真相源要能追溯');
assert.ok(applied.every((i) => i.code !== 'axis_break'), '越轴不许自动改');

const sum = continuitySummary(issues);
assert.ok(sum.error > 0 && sum.error + sum.warning + sum.info === issues.length);

// ============ 编排器 ============
const { planProject, submitPlan, projectProgress } = await load('app/lib/orchestrator/plan.ts');
const { TaskQueue } = await load('app/lib/task/queue.ts');
const queue = new TaskQueue(d1);

const plan = planProject({
  projectId: 'PRJ',
  needsPreprocess: true,
  needsAnalyze: true,
  previsMode: 'per_shot',   // 逐镜预演：每一镜都排一个 blender 任务
  shots: [
    { shotId: 'SH1', idx: 0, seconds: 10, needsBlender: false, needsKeyframe: true, revision: 1 },
    { shotId: 'SH2', idx: 1, seconds: 8, needsBlender: true, needsKeyframe: false, revision: 1 },
  ],
});
// preprocess + analyze + 2×(blender,video,qa) + 1×keyframe + merge = 10
assert.equal(plan.length, 10, `任务数应为 10，实际 ${plan.length}`);

// off 模式一个预演任务都不排——要不要花这份渲染时间是用户的决定，不替他拍板
const offPlan = planProject({
  projectId: 'PRJ_OFF', needsPreprocess: false, needsAnalyze: false, previsMode: 'off',
  shots: [{ shotId: 'X1', idx: 0, seconds: 10, needsBlender: true, needsKeyframe: false, revision: 1 }],
});
assert.equal(offPlan.filter((t) => t.type === 'blender').length, 0, 'off 模式不该排预演任务');

// 全片模式只排一个不带 shotId 的预演任务，所有出片都等它
const fullPlan = planProject({
  projectId: 'PRJ_FULL', needsPreprocess: false, needsAnalyze: false, previsMode: 'full',
  shots: [
    { shotId: 'F1', idx: 0, seconds: 10, needsBlender: false, needsKeyframe: false, revision: 1 },
    { shotId: 'F2', idx: 1, seconds: 8, needsBlender: false, needsKeyframe: false, revision: 1 },
  ],
});
const filmTasks = fullPlan.filter((t) => t.type === 'blender');
assert.equal(filmTasks.length, 1, '全片模式只该有一个预演任务');
assert.equal(filmTasks[0].shotId, undefined, '全片预演任务不带 shotId —— handler 靠这个区分全片和单镜');
for (const v of fullPlan.filter((t) => t.type === 'video')) {
  assert.ok(v.dependsOn.includes(filmTasks[0].idempotencyKey), '每一镜出片都必须等全片预演渲完');
  assert.equal(v.input.previsMode, 'full', '出片任务要知道模式，才会去取参考视频');
}
const merge = plan.find((t) => t.type === 'merge');
const qaKeys = plan.filter((t) => t.type === 'qa').map((t) => t.idempotencyKey);
assert.deepEqual(merge.dependsOn.sort(), qaKeys.sort(), '拼接必须依赖全部质检，而不是出片');
// 出片依赖关键帧/Blender，不能抢跑
const v1 = plan.find((t) => t.type === 'video' && t.shotId === 'SH1');
assert.ok(v1.dependsOn.some((k) => k.includes(':keyframe:')));
const v2 = plan.find((t) => t.type === 'video' && t.shotId === 'SH2');
assert.ok(v2.dependsOn.some((k) => k.includes(':blender:')));

// 重复提交同一张图只产生一份任务
const rows = await submitPlan(queue, plan);
assert.equal(rows.length, 10);
const rows2 = await submitPlan(queue, plan);
assert.deepEqual(rows.map((r) => r.id).sort(), rows2.map((r) => r.id).sort(), '重复提交必须命中幂等');
assert.equal(d1.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id='PRJ'").first().c, 10);

// 依赖没满足的任务绝不能被认领：此刻只有 preprocess 可跑
const first = await queue.claim('w1');
assert.equal(first.type, 'preprocess', `首个可认领的应是 preprocess，实际 ${first.type}`);
const second = await queue.claim('w2');
assert.equal(second, null, 'analyze 依赖 preprocess，未完成前不该被认领');

const mergeRow = rows.find((r) => r.type === 'merge');
assert.equal((await queue.blockedBy(mergeRow.id)).length, 2, '拼接应被两个质检任务挡住');

await queue.start(first.id);
await queue.succeed(first.id, {});
const third = await queue.claim('w2');
assert.equal(third.type, 'analyze', '上游成功后下游才解锁');

// 上游进死信 → 下游不能永远挂在 pending 装作还在跑
await queue.start(third.id);
await queue.fail(third.id, '分析失败', 'provider_rejected');   // 不可重试，直接 dead
assert.equal((await queue.byId(third.id)).status, 'dead');
const orphans = await queue.cancelOrphans('PRJ');
assert.ok(orphans > 0, '上游死信后下游应被取消，而不是一直 pending');

const progress = projectProgress(await queue.listByProject('PRJ'));
assert.equal(progress.total, 10);
assert.equal(progress.succeeded, 1);
assert.equal(progress.dead, 1);
assert.equal(progress.stage, '有任务失败，等待处理');
assert.equal(progress.blocked.length, 1);

// ============ Worker 运行时 ============
const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');
const { MemoryObjectStore } = await load('app/lib/storage/object-store.ts');
const { createVideoHandler, classifyProviderError } = await load('app/lib/orchestrator/handlers/video.ts');
const { Wallet } = await load('app/lib/billing/wallet.ts');
const { MockVideoProvider } = await load('app/lib/providers/mock-video.ts');
const { VideoGateway } = await load('app/lib/providers/gateway.ts');
const { ProviderError } = await load('app/lib/providers/types.ts');

assert.equal(classifyProviderError(new ProviderError('渠道不存在', 'unavailable')), 'provider_unavailable');
assert.equal(classifyProviderError(new ProviderError('参数错', 'rejected')), 'provider_rejected');
assert.equal(classifyProviderError(new Error('随便')), 'internal');

// worker 只认领自己有 handler 的类型，不抢别人的活
const rt = new WorkerRuntime(queue, { workerId: 'w-video' });
assert.equal((await rt.runOnce()).status, 'idle', '没注册任何 handler 时不该认领任何任务');

// 一条真实的出片链路：冻结 → 提交 → 立刻存 jobId → 轮询 → 下载 → 存档 → 结算
d1.prepare('INSERT INTO users (id,email,display_name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .bind('U9', 'u9@x.c', 'u9', 'user', 'active', Date.now(), Date.now()).run();
const wallet = new Wallet(d1);
await wallet.topup('U9', 10_000, 'u9-topup');

const store = new MemoryObjectStore();
const persisted = [];
const gateway = new VideoGateway([{ provider: new MockVideoProvider({ generationMs: 0 }), creds: { baseUrl: '', apiKey: '' } }]);
const videoHandler = createVideoHandler({
  gateway, wallet, store,
  sleep: async () => {},
  pollIntervalMs: 0,
  persistJobId: async (taskId, provider, jobId) => { persisted.push({ taskId, provider, jobId }); },
  registerAsset: async ({ key }) => `asset:${key}`,
});

const vqueue = new TaskQueue(d1);
const vt = await vqueue.enqueue({
  type: 'video', idempotencyKey: 'vid-run-1', projectId: 'PRJ2', shotId: 'SHX',
  input: { projectId: 'PRJ2', shotId: 'SHX', userId: 'U9', model: 'mock/video', prompt: '一个镜头', seconds: 6 },
});
const vrt = new WorkerRuntime(vqueue, { workerId: 'w-video', types: ['video'] }).register(videoHandler);
const res = await vrt.runOnce();
assert.equal(res.status, 'succeeded', res.error);
assert.equal(persisted.length, 1, 'jobId 必须在提交成功那一刻就落库（丢过一次 1.03 美元）');
const out = JSON.parse((await vqueue.byId(vt.id)).output_json);
assert.ok(out.assetId.startsWith('asset:'));
assert.equal(store.size, 1, '成片必须进对象存储');
// 能力表里的 centsPerSecond 单位是「百分之一分/秒」，Mock 的 100 就是 1 分/秒。
// 6 秒 = 6 分。冻结与实扣一致，冻结应清零。
assert.equal(out.estimateCents, 6);
assert.equal(out.chargedCents, 6);
const w9 = await wallet.get('U9');
assert.equal(w9.frozen_cents, 0, '结算后不该还有冻结');
assert.equal(w9.balance_cents, 9_994);

// 上游拒绝：不建任务就不该扣钱，必须全额解冻
const failing = {
  name: 'mock', capabilities: () => undefined, estimateCents: () => 500,
  generate: async () => { throw new ProviderError('参数不合法', 'rejected', 400); },
  getTaskStatus: async () => ({ jobId: '', status: 'failed' }),
  download: async () => new ArrayBuffer(0),
};
const badHandler = createVideoHandler({
  gateway: new VideoGateway([{ provider: failing, creds: { baseUrl: '', apiKey: '' } }]),
  wallet, store, sleep: async () => {},
  persistJobId: async () => { throw new Error('不该走到这一步'); },
  registerAsset: async () => 'x',
});
const bt = await vqueue.enqueue({
  type: 'video', idempotencyKey: 'vid-run-2', projectId: 'PRJ2', shotId: 'SHY',
  input: { projectId: 'PRJ2', shotId: 'SHY', userId: 'U9', model: 'mock/video', prompt: '另一个', seconds: 5 },
});
const brt = new WorkerRuntime(vqueue, { workerId: 'w-video2', types: ['video'] }).register(badHandler);
const bres = await brt.runOnce();
assert.equal(bres.status, 'failed');
assert.equal(bres.failureClass, 'provider_rejected', '参数被拒不该被当成可重试');
assert.equal((await vqueue.byId(bt.id)).status, 'dead', '不可重试的失败应直接进死信，不浪费次数');
assert.equal((await wallet.get('U9')).balance_cents, 9_994, '上游没建任务就不许扣钱');
assert.equal((await wallet.get('U9')).frozen_cents, 0, '提交失败必须全额解冻');

// worker 崩在半路：租约到期要能回收，且不会重复扣费
const ct = await vqueue.enqueue({
  type: 'video', idempotencyKey: 'vid-run-3', projectId: 'PRJ2',
  input: { projectId: 'PRJ2', shotId: 'SHZ', model: 'mock/video', prompt: 'p', seconds: 4 },
});
const claimed = await vqueue.claim('w-crash', ['video']);
await vqueue.start(claimed.id);
await d1.prepare('UPDATE tasks SET lease_until=? WHERE id=?').bind(Date.now() - 1, claimed.id).run();
assert.equal(await vqueue.reclaimExpired(), 1);
assert.equal((await vqueue.byId(ct.id)).status, 'pending', '崩溃的 worker 手里的任务必须回到队列');

console.log('极客版第二批测试通过：空间信息（blocking 驱动站位/机位枚举优先于文本猜测/入画时间跨镜换算/旧 DNA 退回原行为/角色映射后仍匹配/四类填错全被校验挡下）、Shot DNA（枚举识别/秒数换算/越界乱序拦截/不编造缺失字段/pop-in 提示）、Prompt Compiler（确定性指纹/逐拍进词/超长整段丢弃并回报/重试分类加强/首帧排除中途入画）、连续性（换装·越轴·时间跳变·道具消失全抓到、空数据零假问题、自动修复不改入参且不碰需判断的项）、编排器（拼接依赖全部质检/依赖未满足不可认领/重复提交幂等/上游死信收孤儿/进度由任务表现算）、Worker（只认领自有类型/出片全链路冻结结算/提交被拒全额解冻/崩溃租约回收）。');
