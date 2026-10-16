import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandShotPlan, shotResponseSchema } from '../worker/previs/shot.mjs';
import { normalizeLibrary } from '../worker/previs/batch.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { runAutomaticPrevis, segmentsFor } from '../worker/previs/engine.mjs';

const analysis = { source: { duration_seconds: 2 }, source_roles: [{ role_id: 'A' }], beats: [{ beat_id: 'ONE', start_seconds: 0, end_seconds: 2, role_ids: ['A'] }] };
const segments = segmentsFor(analysis, 600);
const library = { schema_version: 'motion-library.v1', actors: ['A', 'B'].map(id => ({ id, kind: 'human', height: 1.7, color: [.2, .3, .4], skin: [.5, .5, .5] })),
  props: ['GROUND', 'SWORD'].map(id => ({ id, parts: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: [.3, .3, .3] }] })), poses: [{ id: 'REST', joints: restPose }] };
const placeholder = { actor: '', joint: 'pelvis', offset: [0, 0, 0] };
const binding = { actor: 'A', joint: 'right_hand', offset: [0, 0, 0] };
const shot = { schema_version: 'motion-shot.v2', index: 0, duration: 2,
  actors: [{ id: 'A', initial: { position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST' }, keys: [] }],
  props: [
    { id: 'GROUND', initial: { position: [8, 5, 0], rotation: [0, 0, 0], visible: true, attach: placeholder }, keys: [{ at: 1, position: [9, 5, 0] }] },
    { id: 'SWORD', initial: { position: [0, 0, 0], rotation: [0, 0, 0], visible: true, attach: binding }, keys: [] },
  ],
  camera: { initial: { position: [0, -5, 1], target: [0, 0, 1], lens: 45, roll: 0 }, keys: [] },
  coverage: ['composition', 'camera', 'whole_action', 'props'].map(id => ({ id, start: 0, end: 2, entities: ['A'], detail: 'Synthetic evidence' })),
};
const expand = value => expandShotPlan(value, normalizeLibrary(structuredClone(library)), segments, 0);
const original = structuredClone(shot);
// A blank root placeholder must not make an explicitly positioned world prop unusable.
const recovered = expand(shot);
assert.equal(recovered.props[0].keys[0].attach, null);
assert.equal(recovered.props[0].keys[1].attach, null);
assert.deepEqual(recovered.props[0].keys.map(key => key.position), [[8, 5, 0], [9, 5, 0]]);
assert.deepEqual(recovered.props[1].keys[0].attach, binding, 'Preserve a real hand binding');
assert.ok(recovered.uncertainties.some(note => note.includes('GROUND') && note.includes('未绑定')));
assert.deepEqual(shot, original, 'Normalization must not rewrite paid model evidence');

// Do not guess unknown targets, malformed offsets, or an ambiguous release after attachment.
for (const invalid of [
  { actor: 'MISSING', joint: 'right_hand', offset: [0, 0, 0] },
  { actor: 'B', joint: 'right_hand', offset: [0, 0, 0] }, // B has no track in this shot.
  { actor: '', joint: 'right_hand', offset: [0, 0, 0] },
  { actor: '', joint: 'pelvis', offset: [0, 1, 0] },
  { actor: 'A', joint: 'right_wrist', offset: [0, 0, 0] },
]) {
  const bad = structuredClone(shot); bad.props[0].initial.attach = invalid;
  assert.throws(() => expand(bad), error => /GROUND/.test(error.message) && /绑定/.test(error.message));
}
const badRelease = structuredClone(shot);
badRelease.props[1].keys.push({ at: 1, attach: placeholder });
assert.throws(() => expand(badRelease), /SWORD.*绑定|绑定.*SWORD/);
const explicitRelease = structuredClone(shot);
explicitRelease.props[1].keys.push({ at: 1, attach: null, position: [1, 0, 0] });
assert.equal(expand(explicitRelease).props[1].keys[1].attach, null);

const directory = path.resolve('.worker/automatic-previs-tests', `attachments-${randomUUID()}`);
await fs.mkdir(directory, { recursive: true });
const source = path.join(directory, 'source.bin'); await fs.writeFile(source, 'synthetic');
const savedLibrary = JSON.stringify({ data: library });
const savedShot = JSON.stringify({ data: shot, raw: JSON.stringify(shot) });
await fs.writeFile(path.join(directory, 'library-response.json'), savedLibrary);
await fs.writeFile(path.join(directory, 'shot-001-response.json'), savedShot);
const media = {
  async probe() { return { duration: 2, width: 960, height: 540 }; },
  async render(plan, out) { assert.equal(plan.props[0].keys[0].attach, null); assert.deepEqual(plan.props[1].keys[0].attach, binding); return { video: path.join(out, 'preview.mp4'), motionCheck: { max_limb_length_change: 0 } }; },
  async concat() {},
};
const replay = await runAutomaticPrevis({ analysis, source, directory, media, recoverSavedResponse: true, model: async () => assert.fail('Cached recovery must not call a model') });
assert.equal(replay.newModelCalls, 0);
assert.equal(replay.reusedModelCalls, 2);
assert.equal(await fs.readFile(path.join(directory, 'shot-001-response.json'), 'utf8'), savedShot);

// Verify constraints at the actual engine -> model boundary for future paid requests.
await fs.rename(path.join(directory, 'shot-001-response.json'), path.join(directory, 'saved-shot.json'));
await runAutomaticPrevis({ analysis, source, directory, media, model: async ({ schema }) => {
  for (const attach of [schema.properties.props.items.properties.initial.properties.attach, schema.properties.props.items.properties.keys.items.properties.attach]) {
    assert.equal(attach.nullable, true);
    assert.deepEqual(attach.properties.actor.enum, ['A', 'B']);
    assert.deepEqual(attach.required, ['actor', 'joint', 'offset']);
  }
  return { data: shot };
} });
assert.equal(shotResponseSchema(segments[0]).properties.props.items.properties.initial.properties.attach.properties.actor.enum, undefined, 'Per-job IDs must not leak into the shared schema');
console.log('Previs attachments: cached world placeholders recovered without calls or mutation; real bindings preserved; ambiguous bindings rejected; future requests constrained to library actors.');
