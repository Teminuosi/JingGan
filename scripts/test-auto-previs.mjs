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
const model = async ({ videos, prompt }) => {
  assert.match(prompt, /拿起杯子/);
  assert.deepEqual(videos, []);
  calls++;
  return { data: structuredClone(batch), raw: JSON.stringify(batch) };
};
const manifest = await runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'loop'), model, media: fakeMedia });
assert.equal(calls, 1); assert.equal(manifest.status, 'rendered_unreviewed'); assert.equal(manifest.modelComparisonPerformed, false); assert.equal(manifest.modelComparisonPassed, false); assert.equal(manifest.watchedEntireClip, false);
const failed = await runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'failed-check'), model, media: { ...fakeMedia, render: async (...args) => ({ ...await fakeMedia.render(...args), motionCheck: { max_limb_length_change: .5 } }) } });
assert.equal(failed.status, 'needs_review'); assert.equal(failed.modelComparisonPassed, false);
let invalidCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'invalid'), model: async () => { invalidCalls++; return { data: { ...batch, segments: [] } }; }, media: fakeMedia }), /全片编排失败/);
assert.equal(invalidCalls, 1);
let truncatedCalls = 0;
await assert.rejects(runAutomaticPrevis({ analysis, source, directory: path.join(dir, 'truncated'), model: async () => { truncatedCalls++; return { parseError: 'MAX_TOKENS', data: null }; }, media: fakeMedia }), /MAX_TOKENS/);
assert.equal(truncatedCalls, 1);
const contaminated = JSON.stringify(batch).replace(',"segments":', '极为简短的默认", "segments":');
assert.deepEqual(parsePlanningResponse(contaminated).data, batch);
assert.equal(parsePlanningResponse(contaminated).repaired, true);
assert.throws(() => parsePlanningResponse('{"x":1 garbage}'));
assert.throws(() => parsePlanningResponse('{"x":{}}'.slice(0, -1)));
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
const multi = await runAutomaticPrevis({ analysis: multiAnalysis, source, directory: path.join(dir, 'multi'), model: async ({ videos }) => { multiCalls++; assert.deepEqual(videos, []); return { data: multiBatch }; }, media: { ...fakeMedia, probe: async () => ({ duration: 4, width: 540, height: 960 }) } });
assert.equal(multiCalls, 1); assert.equal(multi.segments.length, 2);

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

let requestBody;
const gemini = createGemini({ baseUrl: 'https://example.com/v1', apiKey: 'test-secret', model: 'test-model' }, { fetchImpl: async (_url, options) => { requestBody = JSON.parse(options.body); return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(passReview) }] }, finishReason: 'STOP' }] }); } });
await gemini({ prompt: 'Test', videos: [source, source] });
assert.equal(requestBody.contents[0].parts.filter(p => p.inlineData).length, 2);
assert.equal(requestBody.contents[0].parts[0].videoMetadata.fps, 8);
await gemini({ prompt: 'Text-only planning', videos: [] });
assert.deepEqual(requestBody.contents[0].parts, [{ text: 'Text-only planning' }]);
assert.equal(requestBody.generationConfig.mediaResolution, undefined);

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
console.log('Batch planning, one-call budget, text-only request, sparse poses and failure checks passed. No paid model calls.');

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
  const live = await createPrevisServer({ directory: path.join(dir, 'live-service'), blenderPath, createModel: () => async ({ videos }) => {
    modelCalls++;
    assert.deepEqual(videos, []);
    return { data: structuredClone(batch), raw: 'MOCK_MODEL' };
  } });
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
    assert.equal(job.status, 'rendered_unreviewed', job.message); assert.equal(modelCalls, 1);
    const download = await fetch(`${endpoint}/jobs/${ticket.id}/video`, { headers: { ...headers, Range: 'bytes=0-99' } });
    assert.equal(download.status, 206); assert.equal((await download.arrayBuffer()).byteLength, 100);
    const report = await fetch(`${endpoint}/jobs/${ticket.id}/report`, { headers }).then(r => r.json());
    assert.equal(report.watchedEntireClip, false); assert.equal(report.modelComparisonPassed, false); assert.equal(report.modelCalls, 1);
    console.log('Actual HTTP upload → one text-only planning call → Blender render → merge → authenticated range playback passed (model stub; not semantic quality evidence).');
  } finally { await new Promise(resolve => live.close(resolve)); }
}
