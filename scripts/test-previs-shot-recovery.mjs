import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SHOT_SCHEMA, LIBRARY_SCHEMA, expandShotPlan } from '../worker/previs/shot.mjs';
import { normalizeLibrary } from '../worker/previs/batch.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { requirementsFor } from '../worker/previs/contract.mjs';
import { runAutomaticPrevis, segmentsFor } from '../worker/previs/engine.mjs';

const beat = { beat_id: 'A', start_seconds: 0, end_seconds: 2, role_ids: ['GIANT'], visual_action: 'Raises one hand', props: [] };
const analysis = { source: { duration_seconds: 2, aspect_ratio: '16:9' }, source_roles: [{ role_id: 'GIANT' }], beats: [beat] };
const library = { schema_version: 'motion-library.v1', actors: [{ id: 'GIANT', kind: 'human', height: 15, color: [.1, .6, .3], skin: [.2, .8, .4] }], props: [], poses: [{ id: 'REST', joints: restPose }] };
const shot = {
  schema_version: 'v1', index: 0, duration: 2,
  actors: [{ id: 'GIANT', keys: [
    { at: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST' },
    { at: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST', head_rotation: [0, 0, 0], mouth_open: 0 },
    { at: 1, position: [0, .1, 0] },
  ] }], props: [],
  camera: [{ at: 0, position: [0, -30, 8], target: [0, 0, 8], lens: 45, roll: 0 }],
  coverage: requirementsFor(beat, 0, 2).map(r => ({ id: r.id, start: 0, end: 2, entities: ['GIANT'], detail: 'Synthetic regression evidence' })), uncertainties: [],
};
const original = structuredClone(shot);
const expand = value => expandShotPlan(value, normalizeLibrary(structuredClone(library)), segmentsFor(analysis, 600), 0);
const recovered = expand(shot);
assert.equal(recovered.schema_version, 'motion-plan.v1');
assert.deepEqual(recovered.actors[0].keys.map(k => k.at), [0, 1]);
assert.equal(recovered.actors[0].height, 15, 'Do not shrink the source giant to pass validation');
assert.deepEqual(recovered.actors[0].keys[1].position, [0, .1, 0]);
assert.deepEqual(shot, original, 'Never mutate the saved model response');
assert.ok(recovered.uncertainties.some(n => n.includes('版本')));
assert.ok(recovered.uncertainties.some(n => n.includes('重复关键帧')));
assert.deepEqual(SHOT_SCHEMA.properties.schema_version.enum, ['motion-shot.v2']);
assert.deepEqual(LIBRARY_SCHEMA.properties.schema_version.enum, ['motion-library.v1']);
const conflict = structuredClone(shot);
conflict.actors[0].keys[1].position = [1, 0, 0];
assert.throws(() => expand(conflict), /冲突/);
assert.throws(() => expand({ ...shot, schema_version: 'motion-shot.v3' }), /motion-shot.v1/);
assert.throws(() => expand({ ...shot, index: 1 }), /序号|版本|motion-shot.v1/);
assert.throws(() => expand({ ...shot, duration: 3 }), /时长/);
const unordered = structuredClone(shot);
unordered.actors[0].keys.push({ at: .5, position: [0, .2, 0] });
assert.throws(() => expand(unordered), /严格递增/);
const cameraDuplicate = structuredClone(shot);
cameraDuplicate.camera.push({ at: 0, lens: 45 });
assert.equal(expand(cameraDuplicate).camera.length, 1);
cameraDuplicate.camera[1].lens = 50;
assert.throws(() => expand(cameraDuplicate), /冲突/);
const failedWithPose = structuredClone(shot);
failedWithPose.poses = [{ id: 'UNVALIDATED', joints: restPose }];
failedWithPose.duration = 3;
const unchangedLibrary = normalizeLibrary(structuredClone(library));
assert.throws(() => expandShotPlan(failedWithPose, unchangedLibrary, segmentsFor(analysis, 600), 0), /时长/);
assert.equal(Object.hasOwn(unchangedLibrary.poses, 'UNVALIDATED'), false);
const huge = structuredClone(library); huge.actors[0].height = 51;
assert.throws(() => expandShotPlan(shot, normalizeLibrary(huge), segmentsFor(analysis, 600), 0), /身高/);

// Some relays return shot-local poses as an ID-keyed map despite the array schema.
// Ignoring that map loses complete paid results and forces a needless new call.
const mappedShot = structuredClone(shot);
mappedShot.poses = {
  kneel_start: { ...structuredClone(restPose), right_hand: [.15, -.2, .6] },
  kneel_end: { ...structuredClone(restPose), right_hand: [.2, -.3, .65] },
};
mappedShot.actors[0].keys[0].pose = 'kneel_start';
mappedShot.actors[0].keys[1].pose = 'kneel_start';
mappedShot.actors[0].keys[2].pose = 'kneel_end';
const originalMapped = structuredClone(mappedShot);
const mappedLibrary = normalizeLibrary(structuredClone(library));
const mappedPlan = expandShotPlan(mappedShot, mappedLibrary, segmentsFor(analysis, 600), 0);
assert.deepEqual(mappedPlan.actors[0].keys[0].joints.right_hand, [.15, -.2, .6]);
assert.deepEqual(mappedPlan.actors[0].keys[1].joints.right_hand, [.2, -.3, .65]);
assert.deepEqual(mappedLibrary.poses.kneel_end.right_hand, [.2, -.3, .65]);
assert.deepEqual(mappedShot, originalMapped, 'Format normalization must preserve the saved response');
assert.ok(mappedPlan.uncertainties.some(note => note.includes('姿态') && note.includes('格式')));
const invalidMapped = structuredClone(mappedShot);
invalidMapped.poses.kneel_end.right_hand = [1, 2];
const unmodifiedLibrary = normalizeLibrary(structuredClone(library));
assert.throws(() => expandShotPlan(invalidMapped, unmodifiedLibrary, segmentsFor(analysis, 600), 0), /kneel_end.*right_hand/);
assert.equal(Object.hasOwn(unmodifiedLibrary.poses, 'kneel_start'), false, 'Failed shots cannot leak new poses into subsequent shots');
assert.throws(() => expand({ ...shot, poses: 'invalid' }), /姿态.*格式/);
assert.throws(() => expand({ ...mappedShot, poses: { kneel_start: null } }), /kneel_start/);

const directory = path.resolve('.worker', 'automatic-previs-tests', `recovery-${randomUUID()}`);
await fs.mkdir(directory, { recursive: true });
const source = path.join(directory, 'source.bin'); await fs.writeFile(source, 'synthetic');
const savedLibrary = JSON.stringify({ data: library, raw: JSON.stringify(library) });
const savedShot = JSON.stringify({ data: mappedShot, raw: JSON.stringify(mappedShot) });
await fs.writeFile(path.join(directory, 'library-response.json'), savedLibrary);
await fs.writeFile(path.join(directory, 'shot-001-response.json'), savedShot);
let calls = 0;
const result = await runAutomaticPrevis({ analysis, source, directory, recoverSavedResponse: true,
  model: async () => { calls++; throw Error('Paid calls forbidden'); },
  media: {
    async probe() { return { duration: 2, width: 960, height: 540 }; },
    async render(plan, out, frames) { assert.equal(plan.actors[0].height, 15); assert.equal(frames, 48); return { video: path.join(out, 'preview.mp4'), motionCheck: { max_limb_length_change: 0 } }; },
    async concat() {},
  },
});
assert.equal(calls, 0);
assert.equal(result.newModelCalls, 0);
assert.equal(result.reusedModelCalls, 2);
assert.equal(result.status, 'rendered_unreviewed');
assert.equal(await fs.readFile(path.join(directory, 'library-response.json'), 'utf8'), savedLibrary);
assert.equal(await fs.readFile(path.join(directory, 'shot-001-response.json'), 'utf8'), savedShot);
const rejectedShot = JSON.stringify({ data: conflict });
await fs.writeFile(path.join(directory, 'shot-001-response.json'), rejectedShot);
await assert.rejects(runAutomaticPrevis({ analysis, source, directory, recoverSavedResponse: true,
  model: async () => { calls++; throw Error('Paid calls forbidden'); },
  media: { async probe() { return { duration: 2, width: 960, height: 540 }; } },
}), /冲突/);
assert.equal(calls, 0);
assert.equal(await fs.readFile(path.join(directory, 'shot-001-response.json'), 'utf8'), rejectedShot, 'Read-only recovery must preserve rejected evidence');
console.log('Previs recovery: version alias, compatible duplicate keys and giant scale recovered locally; conflicts and invalid plans rejected; no paid calls or response rewrites.');
