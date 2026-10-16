import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandShotPlan } from '../worker/previs/shot.mjs';
import { normalizeLibrary } from '../worker/previs/batch.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { runAutomaticPrevis, segmentsFor } from '../worker/previs/engine.mjs';

const analysis = { source: { duration_seconds: 4 }, source_roles: [{ role_id: 'A' }], beats: [
  { beat_id: 'FIRST', start_seconds: 0, end_seconds: 2, role_ids: ['A'] },
  { beat_id: 'SECOND', start_seconds: 2, end_seconds: 4, role_ids: ['A'], action_beats: [{ at_seconds: 2.5, action: 'turn' }] },
] };
const library = { schema_version: 'motion-library.v1', actors: [{ id: 'A', kind: 'human', height: 1.7, color: [.2, .3, .4], skin: [.5, .5, .5] }], props: [], poses: [{ id: 'REST', joints: restPose }] };
const shot = index => ({ schema_version: 'motion-shot.v1', index, duration: 2,
  actors: [{ id: 'A', keys: [{ at: 0, pose: 'REST', position: [0, 0, 0], rotation: [0, 0, 0], visible: true }] }], props: [],
  camera: [{ at: 0, position: [0, -5, 1], target: [0, 0, 1], lens: 45, roll: 0 }],
  coverage: ['composition', 'camera', 'whole_action', 'props', ...(index ? ['action_0'] : [])].map(id => ({ id, start: 0, end: 2, entities: ['A'], detail: 'Synthetic test evidence' })), uncertainties: [],
});
// The actual failure returned a pose but omitted both camera and coverage.
const incomplete = { ...shot(1), camera: [], coverage: [] };
assert.throws(() => expandShotPlan(incomplete, normalizeLibrary(library), segmentsFor(analysis, 600), 1), error => {
  assert.match(error.message, /第 2 镜/);
  assert.match(error.message, /相机|camera/);
  assert.match(error.message, /coverage/);
  assert.match(error.message, /action_0/);
  return true;
});

// A relay can ignore the coverage ID enum and append _req to every ID while
// returning complete evidence. Recover that exact alias without inventing data.
const aliased = shot(1);
for (const item of aliased.coverage) item.id += '_req';
const originalAliased = structuredClone(aliased);
const expand = value => expandShotPlan(value, normalizeLibrary(library), segmentsFor(analysis, 600), 1);
const aliasPlan = expand(aliased);
assert.deepEqual(aliasPlan.coverage.map(item => item.id), ['composition', 'camera', 'whole_action', 'props', 'action_0']);
for (let i = 0; i < aliased.coverage.length; i++) {
  assert.deepEqual(aliasPlan.coverage[i], { ...aliased.coverage[i], id: aliasPlan.coverage[i].id }, 'ID normalization must preserve every evidence field');
}
assert.deepEqual(aliased, originalAliased, 'Do not rewrite the saved paid response');
assert.ok(aliasPlan.uncertainties.some(note => note.includes('composition_req') && note.includes('composition')));
const missingAlias = structuredClone(aliased); missingAlias.coverage.pop();
assert.throws(() => expand(missingAlias), /coverage.*action_0/);
const duplicateAlias = structuredClone(aliased);
duplicateAlias.coverage.push({ ...duplicateAlias.coverage[0], id: 'composition' });
assert.throws(() => expand(duplicateAlias), /composition.*重复|重复.*composition|逐条覆盖 composition/);
for (const patch of [{ detail: '' }, { entities: ['UNKNOWN'] }, { end: 3 }, { start: -1 }]) {
  const invalidEvidence = structuredClone(aliased);
  Object.assign(invalidEvidence.coverage[0], patch);
  assert.throws(() => expand(invalidEvidence), /composition.*证据无效/);
}
const unknownAlias = structuredClone(aliased); unknownAlias.coverage[0].id = 'composition_other';
assert.throws(() => expand(unknownAlias), /coverage.*composition/);

const directory = path.resolve('.worker/automatic-previs-tests', `incomplete-${randomUUID()}`);
await fs.mkdir(directory, { recursive: true });
const source = path.join(directory, 'source.bin'); await fs.writeFile(source, 'synthetic');
const saveResponse = async (name, data) => {
  const text = JSON.stringify({ raw: JSON.stringify(data), data });
  await fs.writeFile(path.join(directory, name), text);
  return text;
};
const savedLibrary = await saveResponse('library-response.json', library);
const savedFirst = await saveResponse('shot-001-response.json', shot(0));
const savedSecond = await saveResponse('shot-002-response.json', incomplete);
const media = {
  async probe() { return { duration: 4, width: 960, height: 540 }; },
  async render(_plan, out) { return { video: path.join(out, 'preview.mp4'), motionCheck: { max_limb_length_change: 0 } }; },
  async concat() {},
};
let modelCalls = 0;
const noCalls = async () => { modelCalls++; throw Error('Unexpected model call'); };
await assert.rejects(runAutomaticPrevis({ analysis, source, directory, media, model: noCalls, recoverSavedResponse: true }), /camera/);
assert.equal(modelCalls, 0);
assert.equal(await fs.readFile(path.join(directory, 'shot-002-response.json'), 'utf8'), savedSecond);

// An explicit retry supplies specific feedback and nonempty output constraints,
// reuses the valid first shot, and stops after one invalid paid response.
await assert.rejects(runAutomaticPrevis({ analysis, source, directory, media, model: async ({ prompt, schema }) => {
  modelCalls++;
  assert.match(prompt, /上次.*检查/);
  assert.match(prompt, /camera.*coverage/s);
  assert.ok(schema.properties.camera.required.includes('initial'));
  assert.ok(schema.properties.actors.items.required.includes('initial'));
  assert.ok(schema.properties.props.items.required.includes('initial'));
  assert.equal(schema.properties.coverage.minItems, 5);
  assert.equal(schema.properties.actors.minItems, 1);
  return { raw: JSON.stringify(incomplete), data: incomplete };
} }), /camera/);
assert.equal(modelCalls, 1, 'Never automatically resubmit an incomplete paid response');
assert.equal(await fs.readFile(path.join(directory, 'library-response.json'), 'utf8'), savedLibrary);
assert.equal(await fs.readFile(path.join(directory, 'shot-001-response.json'), 'utf8'), savedFirst);
const archived = (await fs.readdir(directory)).find(name => /^shot-002-response\.rejected-/.test(name));
assert.ok(archived);
assert.equal(await fs.readFile(path.join(directory, archived), 'utf8'), savedSecond);

const completed = await runAutomaticPrevis({ analysis, source, directory, media, model: async () => { modelCalls++; return { data: shot(1) }; } });
assert.equal(modelCalls, 2);
assert.equal(completed.newModelCalls, 1);
assert.equal(completed.reusedModelCalls, 2);
assert.equal(completed.status, 'rendered_unreviewed');
// Replaying the alternate IDs must use the existing response even when paid
// calls are allowed, so the original resume path cannot resubmit a valid shot.
const savedAliased = await saveResponse('shot-002-response.json', aliased);
const reusedAliases = await runAutomaticPrevis({ analysis, source, directory, media, model: noCalls });
assert.equal(modelCalls, 2);
assert.equal(reusedAliases.newModelCalls, 0);
assert.equal(reusedAliases.reusedModelCalls, 3);
assert.equal(reusedAliases.status, 'rendered_unreviewed');
assert.equal(await fs.readFile(path.join(directory, 'shot-002-response.json'), 'utf8'), savedAliased);
console.log('Incomplete shot: precise missing-field diagnostics, constrained retry, cached first shot preserved, no automatic paid retry.');
