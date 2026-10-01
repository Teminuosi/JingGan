import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMedia, runAutomaticPrevis, segmentsFor, endState } from '../worker/previs/engine.mjs';
import { requirementsFor, validateInput, validatePlan, validateReview, validateContinuation, parsePlanningResponse } from '../worker/previs/contract.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { createPrevisServer, findBlender } from '../worker/previs/server.mjs';
import { createGemini } from '../worker/previs/gemini.mjs';
import { expandBatchPlan } from '../worker/previs/batch.mjs';

const dir = path.resolve('.worker', 'automatic-previs-tests', randomUUID());
await fs.mkdir(dir, { recursive: true });
const beat = { beat_id: 'TEST', start_seconds: 0, end_seconds: 2, role_ids: ['PERSON_NEW'], visual_action: '拿起杯子，举到嘴边喝水，然后放回', camera_motion: '固定全身镜头', framing: '桌子在左前景', props: ['杯子', '桌子'], action_beats: [{ at_seconds: .5, actor_ids: ['PERSON_NEW'], action: '拿起杯子' }] };
const analysis = { source: { duration_seconds: 2, aspect_ratio: '9:16' }, source_roles: [{ role_id: 'PERSON_NEW' }], beats: [beat] };
const requirements = requirementsFor(beat, 0, 2);
const pose = (at, hand) => {
  const joints = structuredClone(restPose);
  if (hand) { joints.right_hand = hand; joints.right_elbow = [.24, -.1, .61]; }
  return { at, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, joints };
};
const propKey = (at, position, attach = null) => ({ at, position, rotation: [0, 0, 0], visible: true, attach });
const part = (shape, size, position = [0, 0, 0]) => ({ shape, size, position, rotation: [0, 0, 0], color: [.25, .5, .7] });
const plan = {
  schema_version: 'motion-plan.v1', duration: 2,
  actors: [{ id: 'PERSON_NEW', kind: 'human', height: 1.72, color: [.1, .4, .6], skin: [.65, .45, .3], keys: [pose(0), pose(.5, [.19, -.2, .5]), pose(1, [.06, -.15, .86]), pose(1.5, [.06, -.15, .86]), pose(2, [.19, -.2, .5])] }],
  props: [
    { id: 'CUP_NEW', parts: [part('torus', [.14, .14, .15]), part('cylinder', [.1, .1, .01], [0, 0, -.07])], keys: [propKey(0, [.3268, -.344, .86]), propKey(.5, [0, 0, 0], { actor: 'PERSON_NEW', joint: 'right_hand', offset: [0, 0, 0] }), propKey(2, [.3268, -.344, .86])] },
    { id: 'TABLE_NEW', parts: [part('box', [.8, .5, .06]), ...[-1, 1].flatMap(x => [-1, 1].map(y => part('box', [.05, .05, .75], [x*.32, y*.18, -.4])))], keys: [propKey(0, [.6, -.34, .77])] },
  ],
  camera: [{ at: 0, position: [0, -5, 1.5], target: [0, 0, .9], lens: 45, roll: 0 }],
  coverage: requirements.map(r => ({ id: r.id, start: 0, end: 2, entities: ['PERSON_NEW', 'CUP_NEW'], detail: '动作轨迹与杯子绑定；测试数据不是模型质量验证' })), uncertainties: [],
};
const expected = { duration: 2, requirements, roleIds: ['PERSON_NEW'] };
validateInput(analysis, 2); validatePlan(plan, expected);
const cameraCoverage = structuredClone(plan);
cameraCoverage.coverage[0].entities.push('camera');
validatePlan(cameraCoverage, expected);
cameraCoverage.coverage[0].entities.push('MISSING');
assert.throws(() => validatePlan(cameraCoverage, expected), /composition/);
const roundedEnd = structuredClone(plan);
roundedEnd.duration = 5.8999999999999995;
roundedEnd.actors[0].keys.at(-1).at = 5.9;
roundedEnd.props[0].keys.at(-1).at = 5.9;
roundedEnd.camera.push({ ...roundedEnd.camera[0], at: 5.9 });
roundedEnd.coverage.forEach(c => { c.end = 5.9; });
validatePlan(roundedEnd, { ...expected, duration: 5.9 });
roundedEnd.actors[0].keys.at(-1).at = 5.91;
assert.throws(() => validatePlan(roundedEnd, { ...expected, duration: 5.9 }), /PERSON_NEW.keys/);
assert.throws(() => validateInput({ ...analysis, beats: [{ ...beat, start_seconds: .4 }] }, 2), /空洞/);
assert.throws(() => validatePlan({ ...plan, duration: 3 }, expected), /时长/);
assert.throws(() => validatePlan({ ...plan, coverage: [] }, expected), /coverage/);
const badActor = structuredClone(plan); badActor.actors[0].keys[1].at = 0;
assert.throws(() => validatePlan(badActor, expected), /递增/);
const badProp = structuredClone(plan); badProp.props[0].keys[1].attach.actor = 'MISSING';
assert.throws(() => validatePlan(badProp, expected), /不存在/);
const nan = structuredClone(plan); nan.camera[0].lens = Infinity;
assert.throws(() => validatePlan(nan, expected), /焦距/);
const passReview = { checks: requirements.map(r => ({ id: r.id, status: 'pass', evidence: 'Synthetic test only' })), issues: [] };
assert.equal(validateReview(passReview, requirements).passed, true);
assert.throws(() => validateReview({ ...passReview, checks: passReview.checks.slice(1) }, requirements), /漏检/);
assert.equal(validateReview({ ...passReview, checks: passReview.checks.map(c => ({ ...c, status: 'uncertain' })) }, requirements).passed, false);
const continuation = structuredClone(plan);
for (const actor of continuation.actors) actor.keys[0] = { ...actor.keys.at(-1), at: 0 };
for (const prop of continuation.props) prop.keys[0] = { ...prop.keys.at(-1), at: 0 };
validateContinuation(endState(plan), continuation);
continuation.actors[0].keys[0].position = [1, 0, 0];
assert.throws(() => validateContinuation(endState(plan), continuation), /初始姿态/);
const split = segmentsFor({ beats: [{ ...beat, end_seconds: 25 }] });
assert.equal(split.length, 3); assert.equal(split.at(-1).end, 25);
assert.equal(split.reduce((n, s) => n + Math.round(s.end * 24) - Math.round(s.start * 24), 0), 600);

const source = path.join(dir, 'source.bin'); await fs.writeFile(source, 'synthetic');
const fakeMedia = {
  async probe() { return { duration: 2, width: 540, height: 960 }; },
  async cut() { assert.fail('Two-call mode must not prepare videos for model calls'); },
  async render(_plan, out, frameCount) { assert.equal(frameCount, 48); await fs.mkdir(out, { recursive: true }); const video = path.join(out, 'preview.mp4'); await fs.writeFile(video, 'synthetic-preview'); return { video, motionCheck: { max_limb_length_change: .1 } }; },
  async concat(_videos, out) { await fs.writeFile(path.join(out, 'preview.mp4'), 'synthetic-concat'); },
};
let calls = 0;
const batch = {
  schema_version: 'motion-batch.v1',
  actors: plan.actors.map(a => ({ id: a.id, kind: a.kind, height: a.height, color: a.color, skin: a.skin })),
  props: plan.props.map(p => ({ id: p.id, parts: p.parts })),
  poses: { REST: restPose },
  segments: [{ ...structuredClone(plan), index: 0,
    actors: plan.actors.map(a => ({ id: a.id, keys: a.keys.map((key, index) => index ? { ...key } : { at: 0, position: key.position, rotation: key.rotation, visible: true, pose: 'REST' }) })),
    props: plan.props.map(p => ({ id: p.id, keys: p.keys })),
  }],
};
const sparse = structuredClone(batch);
sparse.segments[0].actors[0].keys[1] = { at: .5, joints: { right_hand: [.19, -.2, .5] } };
const expanded = expandBatchPlan(sparse, segmentsFor(analysis, 600));
assert.deepEqual(expanded[0].actors[0].keys[1].joints.left_hand, restPose.left_hand);
assert.deepEqual(expanded[0].actors[0].keys[1].position, [0, 0, 0]);
assert.deepEqual(expanded[0].actors[0].keys[1].joints.right_hand, [.19, -.2, .5]);
assert.deepEqual(sparse.segments[0].actors[0].keys[1], { at: .5, joints: { right_hand: [.19, -.2, .5] } });
const missingPose = structuredClone(batch); missingPose.segments[0].actors[0].keys[0].pose = 'MISSING';
assert.throws(() => expandBatchPlan(missingPose, segmentsFor(analysis, 600)), /MISSING/);

// 真实事故复现：模型在道具首帧漏写 rotation（一镜漏 4 个），整单因此作废。
// 「没写 rotation」只有一种意思——不旋转，补恒等值不是替模型做选择；但必须留痕。
const missingIdentity = structuredClone(batch);
for (const track of missingIdentity.segments[0].props) { delete track.keys[0].rotation; delete track.keys[0].attach; }
const filledPlan = expandBatchPlan(missingIdentity, segmentsFor(analysis, 600))[0];
assert.deepEqual(filledPlan.props[0].keys[0].rotation, [0, 0, 0]);
assert.equal(filledPlan.props[0].keys[0].attach, null);
assert.equal(filledPlan.uncertainties.filter(item => item.includes('已按不旋转')).length, filledPlan.props.length, '补了几处就要记几条');
assert.ok(filledPlan.uncertainties.some(item => item.includes('rotation') && item.includes('attach')));
// 补齐只发生在首帧：后续帧靠继承，不该多出记录。
const cleanPlan = expandBatchPlan(structuredClone(batch), segmentsFor(analysis, 600))[0];
assert.equal(cleanPlan.uncertainties.filter(item => item.includes('已按不旋转')).length, 0);
// position 漏了是真不知道东西在哪，不许补。
const missingPosition = structuredClone(batch);
delete missingPosition.segments[0].props[0].keys[0].position;
assert.throws(() => expandBatchPlan(missingPosition, segmentsFor(analysis, 600)), /position/);
// 按镜编排的模型替身：先一次共享库，再每镜一次。姿态在线上是 [{id,joints}] 数组。
const libraryOf = source => ({ schema_version: 'motion-library.v1', actors: source.actors, props: source.props, poses: Object.entries(source.poses).map(([id, joints]) => ({ id, joints })) });
const shotOf = (source, index) => ({ ...structuredClone(source.segments[0]), schema_version: 'motion-shot.v1', index });
const perShotModel = (source, onCall = () => {}) => async ({ videos, prompt, schema }) => {
  assert.match(prompt, /拿起杯子/);
  assert.deepEqual(videos, []);
  assert.ok(schema, '每次编排调用都要带 responseSchema');
  const shot = /motion-shot\.v1/.test(prompt);
  onCall(shot ? 'shot' : 'library');
  if (!shot) return { data: libraryOf(source), raw: '' };
  return { data: shotOf(source, Number(/index 必须是 (\d+)/.exec(prompt)[1])), raw: '' };
};
const model = perShotModel(batch, () => { calls++; });
const manifest = await runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'loop'), model, media: fakeMedia });
// 一次共享库 + 一镜 = 2 次；不再是整片一次。
assert.equal(calls, 2); assert.equal(manifest.mode, 'per-shot'); assert.equal(manifest.modelCalls, 2); assert.equal(manifest.plannedModelCalls, 2);
assert.equal(manifest.status, 'rendered_unreviewed'); assert.equal(manifest.modelComparisonPerformed, false); assert.equal(manifest.modelComparisonPassed, false); assert.equal(manifest.watchedEntireClip, false);
const failed = await runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'failed-check'), model, media: { ...fakeMedia, render: async (...args) => ({ ...await fakeMedia.render(...args), motionCheck: { max_limb_length_change: .5 } }) } });
assert.equal(failed.status, 'needs_review'); assert.equal(failed.modelComparisonPassed, false);
let invalidCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'invalid'), model: async () => { invalidCalls++; return { data: { ...batch, segments: [] } }; }, media: fakeMedia }), /共享库必须为 motion-library\.v1/);
assert.equal(invalidCalls, 1, '共享库不合格就停手，不再往下逐镜烧钱');
let truncatedCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'truncated'), model: async () => { truncatedCalls++; return { parseError: 'MAX_TOKENS', data: null }; }, media: fakeMedia }), /MAX_TOKENS/);
assert.equal(truncatedCalls, 1);

// 按镜编排的核心承诺：某一镜写坏，重试从那一镜继续，前面的不重复计费。
const twoBeats = { ...analysis, beats: [beat, { ...beat, beat_id: 'SECOND', start_seconds: 2, end_seconds: 4, action_beats: [{ ...beat.action_beats[0], at_seconds: 2.5 }] }] };
const twoShotMedia = { ...fakeMedia, probe: async () => ({ duration: 4, width: 540, height: 960 }) };
const resumeDir = path.join(dir, 'resume');
const attempts = [];
const breakSecondShot = failing => async args => {
  const shot = /motion-shot\.v1/.test(args.prompt);
  const index = shot ? Number(/index 必须是 (\d+)/.exec(args.prompt)[1]) : -1;
  attempts.push(shot ? `shot${index}` : 'library');
  if (failing && index === 1) return { raw: '{"schema_version":"motion-shot.v1"', data: null, parseError: '返回内容不是合法 JSON' };
  return shot ? { data: shotOf(batch, index), raw: '' } : { data: libraryOf(batch), raw: '' };
};
await assert.rejects(runAutomaticPrevis({ analysis: twoBeats, source, directory: resumeDir, model: breakSecondShot(true), media: twoShotMedia }), /第 2 镜编排/);
assert.deepEqual(attempts, ['library', 'shot0', 'shot1'], '坏在第 2 镜就停，不继续往下调用');
assert.ok(await fs.readFile(path.join(resumeDir, 'shot-001-response.json'), 'utf8'), '第 1 镜结果必须落盘');
attempts.length = 0;
const resumed = await runAutomaticPrevis({ analysis: twoBeats, source, directory: resumeDir, model: breakSecondShot(false), media: twoShotMedia });
assert.deepEqual(attempts, ['shot1'], '重试只重调坏掉那一镜：共享库和第 1 镜都复用落盘结果');
assert.equal(resumed.newModelCalls, 1);
assert.equal(resumed.reusedModelCalls, 2);
assert.equal(resumed.status, 'rendered_unreviewed');
assert.equal(resumed.segments.length, 2);
const contaminated = JSON.stringify(batch).replace(',"segments":', '极为简短的默认", "segments":');
assert.deepEqual(parsePlanningResponse(contaminated).data, batch);
assert.equal(parsePlanningResponse(contaminated).repaired, true);
assert.throws(() => parsePlanningResponse('{"x":1 garbage}'));
assert.throws(() => parsePlanningResponse('{"x":{}}'.slice(0, -1)));

// 真实事故复现：模型把角色最后一个关键帧的 `"}]}` 写成了 `"]}]}`（多一个闭括号）。
// 关键在于同一份返回里还存在**合法**的 `"]}]}`——全局替换会把对的那处改坏，
// 所以修复只许在 JSON.parse 报错的那个下标上动手。
const legitimateRun = { outer: [{ list: ['b'] }] };   // 序列化后天然含 ]}]}，而且它是对的
assert.ok(JSON.stringify(legitimateRun).includes(']}]}'));
const slipped = `{"keep":${JSON.stringify(legitimateRun)},"actors":[{"id":"A","keys":[{"at":0,"pose":"p"]}]},{"id":"B","keys":[{"at":0,"pose":"q"}]}]}`;
assert.throws(() => JSON.parse(slipped));
// 全局替换会连合法的那处一起改，改完反而更坏——这就是必须定点的原因。
assert.throws(() => JSON.parse(slipped.split(']}]}').join('}]}')));
const repairedSlip = parsePlanningResponse(slipped);
assert.equal(repairedSlip.repaired, true);
assert.equal(repairedSlip.structuralEdits.length, 1, '只该动一处');
assert.deepEqual(repairedSlip.data.keep, legitimateRun, '合法内容一个字节都不许被改');
assert.deepEqual(repairedSlip.data.actors, [{ id: 'A', keys: [{ at: 0, pose: 'p' }] }, { id: 'B', keys: [{ at: 0, pose: 'q' }] }]);
// 推不动就认输：括号缺失而不是多余时，不许硬猜着补。
assert.throws(() => parsePlanningResponse('{"a":[{"b":1}'));
// 不是括号的地方一律不碰。
assert.throws(() => parsePlanningResponse('{"a":1,"b":}'));
const recoveryDir = path.join(dir, 'recovery');
await fs.mkdir(recoveryDir);
const savedResponse = JSON.stringify({ raw: contaminated, data: null, parseError: 'invalid JSON' });
await fs.writeFile(path.join(recoveryDir, 'planning-response.json'), savedResponse);
const recovered = await runAutomaticPrevis({ analysis, source, directory: recoveryDir, recoverSavedResponse: true, model: async () => { throw new Error('Recovery must never call a model'); }, media: fakeMedia });
assert.equal(recovered.newModelCalls, 0);
assert.equal(recovered.status, 'rendered_unreviewed');
assert.equal(await fs.readFile(path.join(recoveryDir, 'planning-response.json'), 'utf8'), savedResponse);
await fs.writeFile(path.join(recoveryDir, 'planning-response.json'), JSON.stringify({ raw: contaminated, data: null, parseError: 'MAX_TOKENS' }));
await assert.rejects(runAutomaticPrevis({ analysis, source, directory: recoveryDir, recoverSavedResponse: true, model: async () => { throw new Error('Forbidden'); }, media: fakeMedia }), /截断/);
const multiAnalysis = { ...analysis, beats: [beat, { ...beat, beat_id: 'SECOND', start_seconds: 2, end_seconds: 4, action_beats: [{ ...beat.action_beats[0], at_seconds: 2.5 }] }] };
const multiBatch = { ...batch, segments: [batch.segments[0], { ...batch.segments[0], index: 1 }] };
let multiCalls = 0;
const multi = await runAutomaticPrevis({ analysis: multiAnalysis, source, directory: path.join(dir, 'multi'), model: perShotModel(multiBatch, () => { multiCalls++; }), media: { ...fakeMedia, probe: async () => ({ duration: 4, width: 540, height: 960 }) } });
assert.equal(multiCalls, 3, '一次共享库 + 两镜'); assert.equal(multi.segments.length, 2);

// Legacy MMSS timestamps must be corrected before segmentation and the paid call.
const encoded = { ...analysis, source: { ...analysis.source, duration_seconds: 62 }, beats: [
  { ...beat, end_seconds: 59 },
  { ...beat, beat_id: 'MINUTE', start_seconds: 59, end_seconds: 102, action_beats: [{ ...beat.action_beats[0], at_seconds: 101 }] },
] };
let repairedCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis: encoded, source, directory: path.join(dir, 'encoded'),
  model: async ({ videos }) => { repairedCalls++; assert.deepEqual(videos, []); throw new Error('TEST_STOP_BEFORE_PAID_CALL'); },
  media: { ...fakeMedia, probe: async () => ({ duration: 62, width: 540, height: 960 }) },
}), /TEST_STOP_BEFORE_PAID_CALL/);
assert.equal(repairedCalls, 1);
const corrected = JSON.parse(await fs.readFile(path.join(dir, 'encoded/source-dna.json'), 'utf8'));
assert.equal(corrected.beats[1].end_seconds, 62);
assert.equal(corrected.beats[1].action_beats[0].at_seconds, 61);
assert.equal(encoded.beats[1].end_seconds, 102);
let rejectedCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis: { ...encoded, beats: [encoded.beats[0], { ...encoded.beats[1], end_seconds: 105 }] }, source,
  directory: path.join(dir, 'unrecoverable'), model: async () => { rejectedCalls++; },
  media: { ...fakeMedia, probe: async () => ({ duration: 62, width: 540, height: 960 }) },
}), /越界/);
assert.equal(rejectedCalls, 0);

// 编排调用必须走流式：实测一次非流式编排耗时 75.97 秒，Cloudflare 的 524 在 100 秒触发。
const encoder = new TextEncoder();
// 按需 pull，不能在 start 里一次性 enqueue 完再 error——那样已入队的分片会被一起丢掉，
// 就测不出「断线前收到的半截必须保留」这件事。
const sseFrom = (...events) => {
  const queue = [...events];
  return new Response(new ReadableStream({
    pull(controller) {
      if (!queue.length) { controller.close(); return; }
      const event = queue.shift();
      if (event instanceof Error) { controller.error(event); return; }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
};
const sseChunk = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

let requestBody, requestUrl;
const geminiCalls = [];
const gemini = createGemini({ baseUrl: 'https://example.com/v1', apiKey: 'test-secret', model: 'test-model' },
  { onCall: event => geminiCalls.push(event), fetchImpl: async (target, options) => { requestBody = JSON.parse(options.body); requestUrl = target; return sseFrom(sseChunk(JSON.stringify(passReview), { finishReason: 'STOP' })); } });
await gemini({ prompt: 'Test', videos: [source, source] });
assert.match(requestUrl, /:streamGenerateContent\?alt=sse$/, '必须请求流式接口');
assert.equal(requestBody.contents[0].parts.filter(p => p.inlineData).length, 2);
assert.equal(requestBody.contents[0].parts[0].videoMetadata.fps, 8);
await gemini({ prompt: 'Text-only planning', videos: [] });
assert.deepEqual(requestBody.contents[0].parts, [{ text: 'Text-only planning' }]);
assert.equal(requestBody.generationConfig.mediaResolution, undefined);
assert.equal(geminiCalls.at(-1).streamed, true);
assert.ok(Number.isInteger(geminiCalls.at(-1).ms), '每次调用都要记耗时，下次排查 524 直接看数字');

// 分片要按顺序拼回完整 JSON；thought 分片是思考过程，不能混进结果。
const wholeReview = JSON.stringify(passReview);
const chunked = createGemini({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' }, { fetchImpl: async () => sseFrom(
  { candidates: [{ content: { parts: [{ text: '模型的内心戏', thought: true }] } }] },
  sseChunk(wholeReview.slice(0, 20)),
  sseChunk(wholeReview.slice(20), { finishReason: 'STOP' }),
) });
const joined = await chunked({ prompt: 'x', videos: [] });
assert.equal(joined.raw, wholeReview, 'thought 分片必须被丢掉，正文要完整拼回');
assert.ok(joined.data);

// 半路断开：不许抛，要把已收到的半截交出来——能看出断在哪，也能判断上游是不是已经计费。
const cut = createGemini({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' }, { fetchImpl: async () => sseFrom(sseChunk('{"partial":'), new Error('socket hang up')) });
const interrupted = await cut({ prompt: 'x', videos: [] });
assert.equal(interrupted.raw, '{"partial":');
assert.match(interrupted.parseError, /传输中途断开/);
assert.equal(interrupted.data, null);

// 中转不支持流式（404）时退回非流式，但要把降级记下来往上报。
let fallbackAttempts = 0;
const degraded = createGemini({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' }, { fetchImpl: async target => {
  fallbackAttempts += 1;
  if (/streamGenerateContent/.test(target)) return new Response('no such method', { status: 404 });
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(passReview) }] }, finishReason: 'STOP' }] });
} });
const fallback = await degraded({ prompt: 'x', videos: [] });
assert.equal(fallbackAttempts, 2);
assert.equal(fallback.streamed, false, '降级必须看得见');
assert.ok(fallback.data);

// 「从断点继续」走真实 HTTP：第一次坏在第 2 镜（模拟 524）→ 任务失败；
// 续跑只为第 2 镜调模型，共享库和第 1 镜直接复用。以前界面上根本没有这条路。
{
  const twoBeatAnalysis = { ...analysis, beats: [beat, { ...beat, beat_id: 'SECOND', start_seconds: 2, end_seconds: 4, action_beats: [{ ...beat.action_beats[0], at_seconds: 2.5 }] }] };
  const calls = [];
  let breakSecond = true;
  const resumeService = await createPrevisServer({
    directory: path.join(dir, 'resume-service'), blenderPath: 'test-blender',
    createMediaImpl: () => ({ ...fakeMedia, probe: async () => ({ duration: 4, width: 540, height: 960 }) }),
    createModel: () => async ({ prompt }) => {
      const shot = /motion-shot\.v1/.test(prompt);
      const index = shot ? Number(/index 必须是 (\d+)/.exec(prompt)[1]) : -1;
      calls.push(shot ? `shot${index}` : 'library');
      if (breakSecond && index === 1) throw new Error('视频分析服务返回 HTTP 524；请查看中转请求记录，未自动重发');
      return shot ? { data: shotOf(batch, index), raw: '' } : { data: libraryOf(batch), raw: '' };
    },
  });
  await new Promise(resolve => resumeService.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${resumeService.address().port}`;
  const origin = { Origin: 'http://localhost:3000' };
  const connection = { baseUrl: 'https://example.com', apiKey: 'test-secret', model: 'mock' };
  const settle = async ticket => {
    const deadline = Date.now() + 15000;
    let job;
    do {
      await new Promise(resolve => setTimeout(resolve, 50));
      job = await fetch(`${endpoint}/jobs/${ticket.id}`, { headers: { ...origin, Authorization: `Bearer ${ticket.token}` } }).then(r => r.json());
    } while (!['failed', 'rendered_unreviewed', 'needs_review'].includes(job.status) && Date.now() < deadline);
    return job;
  };
  const resumeWith = headers => fetch(`${endpoint}/jobs/${ticket.id}/resume`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ connection }) });
  let ticket;
  try {
    ticket = await fetch(`${endpoint}/jobs`, { method: 'POST', headers: { ...origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ analysis: twoBeatAnalysis, connection }) }).then(r => r.json());
    assert.equal(ticket.mode, 'per-shot');
    const auth = { ...origin, Authorization: `Bearer ${ticket.token}` };
    assert.equal((await fetch(`${endpoint}/jobs/${ticket.id}/source`, { method: 'PUT', headers: auth, body: 'synthetic' })).status, 202);
    let job = await settle(ticket);
    assert.equal(job.status, 'failed');
    assert.match(job.message, /第 2 镜编排：视频分析服务返回 HTTP 524/, '网络错误必须标明死在哪一次调用');
    assert.deepEqual(calls, ['library', 'shot0', 'shot1']);
    assert.equal((await resumeWith(origin)).status, 404, '没有任务令牌不许续跑');
    breakSecond = false; calls.length = 0;
    assert.equal((await resumeWith(auth)).status, 202);
    job = await settle(ticket);
    assert.equal(job.status, 'rendered_unreviewed', job.message);
    assert.deepEqual(calls, ['shot1'], '续跑只为坏掉的那一镜调用模型');
    assert.match(job.message, /本次调用模型 1 次，复用已保存结果 2 次/, '成功提示要照实写调了几次');
    assert.equal((await resumeWith(auth)).status, 409, '已经成功的任务不能再续跑');
  } finally { await new Promise(resolve => resumeService.close(resolve)); }
}

const server = await createPrevisServer({ directory: path.join(dir, 'service'), blenderPath: 'test-blender' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(url+'/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url+'/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const created = await fetch(url+'/jobs', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ analysis, projectId: 'test', connection: { baseUrl: 'https://example.com', apiKey: 'test-secret', model: 'test-model' } }) });
  assert.equal(created.status, 201); const ticket = await created.json();
  assert.equal((await fetch(`${url}/jobs/${ticket.id}`)).status, 404);
  const status = await fetch(`${url}/jobs/${ticket.id}`, { headers: { Authorization: `Bearer ${ticket.token}` } });
  assert.equal(status.status, 200); assert.equal((await status.json()).token, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'service', ticket.id, 'input.json'), 'utf8'), /test-secret/);
  await fetch(`${url}/jobs/${ticket.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}` } });
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/recover`, { method: 'POST', headers: { Origin: 'http://localhost:3000' } })).status, 404);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/recover`, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}` } })).status, 403);
  const noSaved = await fetch(`${url}/jobs/${ticket.id}/recover`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Authorization: `Bearer ${ticket.token}` } });
  assert.equal(noSaved.status, 409);
  assert.match((await noSaved.json()).error, /没有已保存/);
  const shotFolder = path.join(dir, 'service', ticket.id, 'output');
  await fs.mkdir(path.join(shotFolder, 'segment-001'), { recursive: true });
  await fs.writeFile(path.join(shotFolder, 'manifest.json'), JSON.stringify({ segments: [{ index: 0, shotIndex: 0, start: 0, end: 2, localChecksPassed: true, issues: [] }] }));
  await fs.writeFile(path.join(shotFolder, 'source-dna.json'), JSON.stringify(analysis));
  await fs.writeFile(path.join(shotFolder, 'segment-001/preview.mp4'), 'synthetic-video');
  const auth = { Authorization: `Bearer ${ticket.token}` };
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shots`)).status, 404);
  const shotList = await fetch(`${url}/jobs/${ticket.id}/shots`, { headers: auth }).then(r => r.json());
  assert.equal(shotList.shots[0].beatId, beat.beat_id);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shot-0`)).status, 404);
  const clip = await fetch(`${url}/jobs/${ticket.id}/shot-0?download=1`, { headers: { ...auth, Range: 'bytes=0-3' } });
  assert.equal(clip.status, 206);
  assert.equal(await clip.text(), 'synt');
  assert.match(clip.headers.get('Content-Disposition'), /attachment/);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shot-99999`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shot-1`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shot-0?from=0&to=3`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${url}/jobs/${ticket.id}/shot-0?from=-1&to=1`, { headers: auth })).status, 400);
} finally { await new Promise(resolve => server.close(resolve)); }
console.log('流式编排（分片拼接 / 断线保留半截 / 不支持时响亮降级）、按镜编排与断点续跑不重复计费、定点括号修复、首帧恒等补齐、稀疏姿态检查全部通过。未产生付费调用。');

if (process.argv.includes('--render')) {
  const blenderPath = await findBlender(); assert.ok(blenderPath, 'Blender required');
  const media = createMedia({ blenderPath, width: 270, height: 480 });
  const rendered = await media.render(plan, path.join(dir, 'real-blender'), 48);
  const probe = await media.probe(rendered.video);
  assert.equal(probe.width, 270); assert.equal(probe.height, 480); assert.equal(probe.duration, 2);
  assert.ok(rendered.motionCheck.attachment_count > 0);
  assert.ok(rendered.motionCheck.max_limb_length_change < .001, 'bone lengths must not stretch during interpolation');
  assert.ok(rendered.motionCheck.attachment_switches.some(s => s.id === 'CUP_NEW' && s.attached && s.distance_from_previous_frame_m < .001), 'cup must remain on the table until the hand grips it, without teleporting');
  console.log(`Real Blender motion render and full FFmpeg decode passed: ${rendered.video}`);

  let modelCalls = 0;
  const live = await createPrevisServer({ directory: path.join(dir, 'live-service'), blenderPath, createModel: () => perShotModel(batch, () => { modelCalls++; }) });
  await new Promise(resolve => live.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${live.address().port}`;
  try {
    const init = await fetch(endpoint+'/jobs', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ analysis, connection: { baseUrl: 'https://example.com', apiKey: 'test-secret', model: 'mock' } }) });
    const ticket = await init.json(); assert.equal(init.status, 201);
    const headers = { Authorization: `Bearer ${ticket.token}`, Origin: 'http://localhost:3000' };
    const uploaded = await fetch(`${endpoint}/jobs/${ticket.id}/source`, { method: 'PUT', headers, body: await fs.readFile(rendered.video) });
    assert.equal(uploaded.status, 202);
    let job;
    const deadline = Date.now()+90000;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await fetch(`${endpoint}/jobs/${ticket.id}`, { headers }).then(r => r.json());
    } while (!['rendered_unreviewed', 'failed', 'needs_review'].includes(job.status) && Date.now() < deadline);
    assert.equal(job.status, 'rendered_unreviewed', job.message); assert.equal(modelCalls, 2, '一次共享库 + 一镜');
    const download = await fetch(`${endpoint}/jobs/${ticket.id}/video`, { headers: { ...headers, Range: 'bytes=0-99' } });
    assert.equal(download.status, 206); assert.equal((await download.arrayBuffer()).byteLength, 100);
    const report = await fetch(`${endpoint}/jobs/${ticket.id}/report`, { headers }).then(r => r.json());
    assert.equal(report.watchedEntireClip, false); assert.equal(report.modelComparisonPassed, false); assert.equal(report.modelCalls, 2);
    console.log('Actual HTTP upload → library + per-shot planning calls → Blender render → merge → authenticated range playback passed (model stub; not semantic quality evidence).');
  } finally { await new Promise(resolve => live.close(resolve)); }
}
