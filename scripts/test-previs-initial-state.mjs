import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandShotPlan, shotResponseSchema } from '../worker/previs/shot.mjs';
import { normalizeLibrary } from '../worker/previs/batch.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { segmentsFor, runAutomaticPrevis } from '../worker/previs/engine.mjs';

const analysis = { source: { duration_seconds: 2 }, source_roles: [{ role_id: 'A' }], beats: [{ beat_id: 'ONE', start_seconds: 0, end_seconds: 2, role_ids: ['A'] }] };
const segments = segmentsFor(analysis, 600);
const library = { schema_version: 'motion-library.v1', actors: ['A', 'B'].map(id => ({ id, kind: 'human', height: 1.7, color: [.2, .3, .4], skin: [.5, .5, .5] })), props: [], poses: [{ id: 'REST', joints: restPose }] };
const coverage = ['composition', 'camera', 'whole_action', 'props'].map(id => ({ id, start: 0, end: 2, entities: ['A'], detail: 'Synthetic evidence' }));
const expand = value => expandShotPlan(value, normalizeLibrary(structuredClone(library)), segments, 0);
const broken = { schema_version: 'motion-shot.v1', index: 0, duration: 2,
  actors: ['A', 'B'].map(id => ({ id, keys: [{ at: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: id === 'A' }] })),
  props: [], camera: [{ at: 0, position: [0, -5, 1], target: [0, 0, 1] }], coverage,
};
assert.throws(() => expand(broken), error => {
  for (const field of ['A', 'B', 'pose', 'lens', 'roll']) assert.ok(error.message.includes(field), `Report every missing initial field together: ${field}`);
  return true;
});

const complete = { schema_version: 'motion-shot.v2', index: 0, duration: 2,
  actors: [{ id: 'A', initial: { position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST' }, keys: [{ at: 1, joints: { right_hand: [.3, -.2, .5] } }] }],
  props: [], camera: { initial: { position: [0, -5, 1], target: [0, 0, 1], lens: 45, roll: 0 }, keys: [{ at: 1, position: [0, -4, 1] }] }, coverage,
};
const untouched = structuredClone(complete);
const plan = expand(complete);
assert.deepEqual(complete, untouched);
assert.deepEqual(plan.actors[0].keys.map(key => key.at), [0, 1]);
assert.deepEqual(plan.actors[0].keys[1].joints.left_hand, restPose.left_hand);
assert.deepEqual(plan.actors[0].keys[1].joints.right_hand, [.3, -.2, .5]);
assert.equal(plan.camera[1].lens, 45);
assert.deepEqual(plan.camera[1].target, [0, 0, 1]);
assert.equal(expand({ ...complete, camera: { ...complete.camera, keys: [] } }).camera.length, 1, 'A static camera still has an explicit initial state');
const noPose = structuredClone(complete); delete noPose.actors[0].initial.pose;
assert.throws(() => expand(noPose), /initial.*pose/);
const noLens = structuredClone(complete); delete noLens.camera.initial.lens;
assert.throws(() => expand(noLens), /initial.*lens/);
const zeroDelta = structuredClone(complete); zeroDelta.actors[0].keys[0].at = 0;
assert.throws(() => expand(zeroDelta), /0|初始/);
const noInitial = structuredClone(complete); delete noInitial.camera.initial;
assert.throws(() => expand(noInitial), /camera.*initial/);
const unknown = structuredClone(complete); unknown.actors[0].initial.pose = 'UNKNOWN';
assert.throws(() => expand(unknown), /UNKNOWN/);

const schema = shotResponseSchema(segments[0]);
assert.deepEqual(schema.properties.schema_version.enum, ['motion-shot.v2']);
for (const field of ['position', 'rotation', 'visible', 'pose']) assert.ok(schema.properties.actors.items.properties.initial.required.includes(field));
for (const field of ['position', 'rotation', 'visible', 'attach']) assert.ok(schema.properties.props.items.properties.initial.required.includes(field));
for (const field of ['position', 'target', 'lens', 'roll']) assert.ok(schema.properties.camera.properties.initial.required.includes(field));
assert.equal(schema.properties.camera.properties.keys.minItems, 0);

const directory = path.resolve('.worker/automatic-previs-tests', `initial-${randomUUID()}`);
await fs.mkdir(directory, { recursive: true });
const source = path.join(directory, 'source.bin'); await fs.writeFile(source, 'synthetic');
const media = {
  async probe() { return { duration: 2, width: 960, height: 540 }; },
  async render(rendered, out) { assert.deepEqual(rendered, { ...plan, ghost_parts: [] }, "渲染收到的计划附带半透明部件名单"); return { video: path.join(out, 'preview.mp4'), motionCheck: { max_limb_length_change: 0 } }; },
  async concat() {},
};
const prompts = [];
let calls = 0;
const result = await runAutomaticPrevis({ analysis, source, directory, media, model: async ({ prompt, schema: sentSchema }) => {
  prompts.push(prompt); calls++;
  if (calls === 1) return { data: library };
  assert.deepEqual(sentSchema, shotResponseSchema(segments[0], normalizeLibrary(library)));
  return { data: complete };
} });
assert.equal(result.status, 'rendered_unreviewed');
assert.equal(calls, 2);
assert.match(prompts[1], /motion-shot.v2/);
assert.match(prompts[1], /initial/);
const replay = await runAutomaticPrevis({ analysis, source, directory, media, recoverSavedResponse: true, model: async () => assert.fail('Replay must not call a model') });
assert.equal(replay.reusedModelCalls, 2);
assert.equal(replay.newModelCalls, 0);
console.log('Initial-state contract: all missing legacy fields reported together; v2 requires complete initial states, preserves sparse updates and replays without model calls.');
