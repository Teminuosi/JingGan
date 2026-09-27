import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { selectPrevisClip } from '../worker/previs-selection.mjs';
import { applyReviewCorrections } from '../worker/blender-review-corrections.mjs';

async function load(p) {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const { buildScene } = await load('app/lib/blender/protocol.ts');
const { createBlenderHandler } = await load('app/lib/orchestrator/handlers/index.ts');
const { MockBlenderRunner } = await load('app/lib/blender/runner.ts');
const actor = (id, facing) => ({ character_id: id, screen_position: 'center', depth_layer: 'midground', facing, props_held: [] });
const base = { schema_version: 'shot-dna.v1', project_id: 'P', shot_id: 'A', idx: 0, start_time: 0, end_time: 3,
  camera: { shot_size: 'MS', angle: 'eye_level', movement: 'static' }, actors: [actor('dog', 'away_from_camera')],
  objects: [], environment: { interior_exterior: 'exterior' }, lighting: { color_temperature: '', key_light: '' },
  complexity: { score: 1 }, action_timeline: [], expression_timeline: [] };
for (const [facing, expected] of [['away_from_camera', 0], ['toward_camera', 180], ['turned_left', 90], ['turned_right', 270], ['背对镜头', 0]]) {
  assert.equal(buildScene({ ...base, actors: [actor('dog', facing)] }, { aspectRatio: '9:16' }).actors[0].rotationZ, expected);
}
const shots = [base, { ...base, shot_id: 'B', idx: 1, start_time: 3, end_time: 7,
  actors: [actor('other', 'turned_left')], camera: { ...base.camera, movement: 'dolly_in' } }];
assert.throws(() => applyReviewCorrections(base, { evidence: 'source', executionCorrections: { start_time: 8 } }), /不允许/);
assert.throws(() => applyReviewCorrections(base, { evidence: 'source', executionCorrections: { actors: [] } }), /角色/);
assert.throws(() => applyReviewCorrections(base, { executionCorrections: { summary: 'x' } }), /依据/);
const corrected = applyReviewCorrections(base, { evidence: 'source frame 1', executionCorrections: { summary: 'new blocking' } });
assert.equal(corrected.summary, 'new blocking');
assert.equal(base.summary, undefined);
const saved = [];
const handler = createBlenderHandler({
  runner: new MockBlenderRunner(), store: {}, aspectRatioOf: async () => '9:16',
  repo: { listShotDna: async () => shots, saveShotDna: async (dna) => saved.push(dna), registerAsset: async () => 'asset' },
});
await handler.run({ task: { input_json: JSON.stringify({ projectId: 'P' }) }, heartbeat: async () => {}, log: () => {} });
assert.match(saved[0].complexity.previs.camera_path, /固定/);
assert.doesNotMatch(saved[0].complexity.previs.blocking, /other/);
assert.match(saved[1].complexity.previs.camera_path, /4 秒/);
assert.doesNotMatch(saved[1].complexity.previs.blocking, /dog/);
shots[0].revision = 2;
shots[0].complexity = { ...shots[0].complexity, previs: { blocking: 'reviewed', camera_path: 'static', reviewed_revision: 2 } };
saved.length = 0;
await handler.run({ task: { input_json: JSON.stringify({ projectId: 'P' }) }, heartbeat: async () => {}, log: () => {} });
assert.equal(saved.length, 1);
assert.equal(saved[0].shot_id, 'B');
const clips = [{ key: 'film.mp4', shotId: '' }, { key: 'old.mp4', shotId: 'A' }, { key: 'other.mp4', shotId: 'B' }, { key: 'reviewed.mp4', shotId: 'A' }];
assert.equal(selectPrevisClip(clips, 'A').key, 'reviewed.mp4');
assert.equal(selectPrevisClip(clips, 'C').key, 'film.mp4');
assert.equal(selectPrevisClip([{ key: 'other.mp4', shotId: 'B' }], 'A'), undefined);
console.log('Blender review regression tests passed: facing, per-shot descriptions, latest preview, no cross-shot fallback.');
