import assert from 'node:assert/strict';
import { planPerShot, LIBRARY_FILE, shotFile, segmentsFor } from '../worker/previs/plan.mjs';
import { restPose } from '../worker/previs/prompts.mjs';
import { requirementsFor } from '../worker/previs/contract.mjs';

// 续跑时被拒的理由要交给模型；中间夹一次 524，下一次续跑也不能把理由弄丢（2026-10-20 实测：丢了，模型原样再犯）。
const beat = { beat_id: 'A', start_seconds: 0, end_seconds: 2, role_ids: ['GIANT'], visual_action: 'Raises one hand', props: [] };
const analysis = { source: { duration_seconds: 2, aspect_ratio: '16:9' }, source_roles: [{ role_id: 'GIANT' }], beats: [beat] };
const library = { schema_version: 'motion-library.v1', actors: [{ id: 'GIANT', kind: 'human', height: 15, color: [.1, .6, .3], skin: [.2, .8, .4] }], props: [], poses: [{ id: 'REST', joints: restPose }] };
const shot = {
  schema_version: 'motion-shot.v2', index: 0, duration: 2,
  actors: [{ id: 'GIANT', keys: [{ at: 0, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, pose: 'REST', head_rotation: [0, 0, 0], mouth_open: 0 }, { at: 1, position: [0, .1, 0] }] }], props: [],
  camera: [{ at: 0, position: [0, -30, 8], target: [0, 0, 8], lens: 45, roll: 0 }],
  coverage: requirementsFor(beat, 0, 2).map(r => ({ id: r.id, start: 0, end: 2, entities: ['GIANT'], detail: 'Synthetic regression evidence' })), uncertainties: [],
};
const files = new Map([[LIBRARY_FILE, { data: library }], [shotFile(0), { data: { ...shot, duration: 3 } }]]);
const store = { read: async n => structuredClone(files.get(n)), write: async (n, v) => { files.set(n, structuredClone(v)); }, reject: async n => { files.delete(n); } };
const run = model => planPerShot({ analysis, segments: segmentsFor(analysis, 600), store, model, allowModelCalls: true, onProgress: async () => {}, manifest: { reusedModelCalls: 0, newModelCalls: 0 } });

const prompts = [];
await assert.rejects(run(async ({ prompt }) => { prompts.push(prompt); throw Object.assign(new Error('HTTP 524'), { requestFailure: { status: 524 } }); }), /524/);
assert.match(prompts[0], /上次第 1 镜编排的结果未通过检查：/);
await run(async ({ prompt }) => { prompts.push(prompt); throw new Error('网络断开'); }).catch(() => {});
await run(async ({ prompt }) => { prompts.push(prompt); throw new Error('网络断开'); }).catch(() => {});
assert.equal(prompts[1].match(/上次第 1 镜编排的结果未通过检查/g)?.length, 1, '524 之后续跑，必须仍把上次被拒的理由交给模型（且只带一次）');
assert.equal(prompts[2].match(/上次第 1 镜编排的结果未通过检查/g)?.length, 1, '连续失败也不丢、不重复叠加');
// 连续被拒时只带最近一条，模型改了这个又把上一个弄坏（2026-10-20 实测：女主人出画↔柯基被挡来回反复）。
files.set(shotFile(0), { data: { ...shot, duration: 3 } });
const later = [];
await run(async ({ prompt }) => { later.push(prompt); return { data: { ...shot, schema_version: 'motion-shot.v9' } }; }).catch(() => {});
await run(async ({ prompt }) => { later.push(prompt); throw new Error('网络断开'); }).catch(() => {});
await run(async ({ prompt }) => { later.push(prompt); throw new Error('网络断开'); }).catch(() => {});
for (const prompt of later.slice(1)) {
  assert.match(prompt, /上次第 1 镜编排的结果未通过检查/);
  assert.match(prompt, /之前还出现过/, '更早被拒的理由也要带上');
  assert.equal(prompt.match(/之前还出现过/g).length, 1);
}
console.log('Previs retry feedback: rejection reason survives intervening request failures and reaches the next paid call exactly once.');
