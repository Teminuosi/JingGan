import assert from 'node:assert/strict';
import { expandShotPlan, shotResponseSchema } from '../worker/previs/shot.mjs';
import { normalizeLibrary } from '../worker/previs/batch.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { segmentsFor } from '../worker/previs/engine.mjs';

const analysis = { source: { duration_seconds: 2 }, source_roles: [{ role_id: 'A' }], beats: [{ beat_id: 'ONE', start_seconds: 0, end_seconds: 2, role_ids: ['A'] }] };
const segments = segmentsFor(analysis, 600);
const library = { schema_version: 'motion-library.v1', actors: [{ id: 'A', kind: 'human', height: 1.7, color: [.2, .3, .4], skin: [.5, .5, .5] }],
  props: [{ id: 'ENVIRONMENT', parts: [{ shape: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: [.3, .3, .3] }] }], poses: [{ id: 'REST', joints: restPose }] };
const shot = { schema_version: 'motion-shot.v2', index: 0, duration: 2,
  actors: [{ id: 'A', initial: { position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST' }, keys: [] }],
  props: [{ id: 'ENVIRONMENT', initial: { position: [8, 5, 0], rotation: [0, 0, 0], visible: true, attach: { actor: 'A', joint: 'pelvis', offset: [0, -1000, 0] } }, keys: [] }],
  camera: { initial: { position: [0, -5, 1], target: [0, 0, 1], lens: 45, roll: 0 }, keys: [] },
  coverage: ['composition', 'camera', 'whole_action', 'props'].map(id => ({ id, start: 0, end: 2, entities: ['A'], detail: 'Synthetic evidence' })),
};
const expand = value => expandShotPlan(value, normalizeLibrary(structuredClone(library)), segments, 0);
const original = structuredClone(shot);
assert.throws(() => expand(shot), error => {
  assert.match(error.message, /ENVIRONMENT.*0s.*attach\.offset/);
  assert.match(error.message, /范围.*-3.*3/);
  assert.match(error.message, /-1000/);
  assert.doesNotMatch(error.message, /必须为有限/);
  return true;
});
assert.deepEqual(shot, original, 'Never clamp or detach an ambiguous target automatically');

for (const offset of [[-3, 0, 3], [0, 0, 0]]) {
  const valid = structuredClone(shot); valid.props[0].initial.attach.offset = offset;
  assert.deepEqual(expand(valid).props[0].keys[0].attach.offset, offset);
}
for (const offset of [[3.001, 0, 0], [0, -3.001, 0], [0, 0, 3.001]]) {
  const invalid = structuredClone(shot); invalid.props[0].initial.attach.offset = offset;
  assert.throws(() => expand(invalid), /范围/);
}
for (const offset of [[0, 0], [0, Infinity, 0], [0, '1', 0], null]) {
  const invalid = structuredClone(shot); invalid.props[0].initial.attach.offset = offset;
  assert.throws(() => expand(invalid), /ENVIRONMENT.*attach\.offset.*有限三维向量/);
}
const later = structuredClone(shot);
later.props[0].initial.attach = null;
later.props[0].keys.push({ at: 1, attach: original.props[0].initial.attach });
assert.throws(() => expand(later), /ENVIRONMENT.*1s.*attach\.offset.*范围/);
const world = structuredClone(shot); world.props[0].initial.attach = null;
assert.equal(expand(world).props[0].keys[0].attach, null);
assert.deepEqual(expand(world).props[0].keys[0].position, [8, 5, 0]);

// The generation contract must reject the same offsets that execution rejects.
const schema = shotResponseSchema(segments[0], normalizeLibrary(library));
const prop = schema.properties.props.items.properties;
for (const attach of [prop.initial.properties.attach, prop.keys.items.properties.attach]) {
  assert.equal(attach.nullable, true, 'World props must retain an explicit unbound representation');
  assert.equal(attach.properties.offset.minItems, 3);
  assert.equal(attach.properties.offset.maxItems, 3);
  assert.deepEqual(attach.properties.offset.items, { type: 'number', minimum: -3, maximum: 3 });
}
console.log('Attachment bounds: generated offsets match execution limits; errors identify prop/time/value; invalid targets stay rejected and world coordinates remain intact.');
