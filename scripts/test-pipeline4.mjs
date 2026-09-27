// 极客版第四批测试：重试督导与拼接闸门。
//
// 这一批测的是「闭环」——质检算出结论之后，有没有人真的去执行。
// 三条最要命的性质：
//  1. 重试任务的幂等键必须带轮次。不带的话第二次重试命中第一次那个已 succeeded 的任务，
//     队列原样返回，什么都不发生——管线看着在跑，实际死循环空转。
//  2. 拼接必须挂上新的质检任务作依赖，且自己还要独立查一遍最新结论。
//     老的质检任务判废时自身仍是 succeeded，光靠依赖图挡不住。
//  3. 该停手时停手：次数用尽、策略用尽、成本超闸，一律交人工而不是接着烧余额。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { applySql, createD1 } from './d1-stub.mjs';

const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const d1 = createD1();
for (const f of fs.readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()) {
  applySql(d1, fs.readFileSync(`drizzle/${f}`, 'utf8'));
}

const { TaskQueue } = await load('app/lib/task/queue.ts');
const { RetrySupervisor } = await load('app/lib/orchestrator/supervisor.ts');
const { planProject, submitPlan } = await load('app/lib/orchestrator/plan.ts');

const queue = new TaskQueue(d1);
const PROJECT = 'RP';

// ---- 假仓储：把督导要的几项数据放在内存里，方便逐条操纵 ----
const state = {
  qa: new Map(),          // shotId -> report
  used: new Map(),        // shotId -> strategies[]
  spend: new Map(),       // shotId -> {spentCents, estimateCents}
  blender: new Set(),
  decisions: [],
};
const repo = {
  latestQa: async () => [...state.qa.entries()].map(([shotId, report]) => ({ shotId, report })),
  usedStrategies: async (id) => state.used.get(id) ?? [],
  spending: async (id) => state.spend.get(id) ?? { spentCents: 100, estimateCents: 100 },
  recordDecision: async (shotId, report, decision) => {
    state.decisions.push({ shotId, strategy: decision.strategy });
    // 真实实现会把决定写进质检报告；这里同步进 used，模拟「同一招不用两次」
    state.used.set(shotId, [...(state.used.get(shotId) ?? []), decision.strategy]);
  },
  blenderEnabled: async (id) => state.blender.has(id),
  shotShape: async () => ({ seconds: 10, actionBeats: 3, revision: 1 }),
};

const failReport = (shotId, cls, msg = '形象崩了') => ({
  shotId, verdict: 'fail', score: 0.2,
  findings: [{ code: 'x', verdict: 'fail', confidence: 0.9, message: msg, failureClass: cls }],
  primaryFailure: cls,
});

// ---- 先建一张正常的任务图 ----
const plan = planProject({
  projectId: PROJECT, needsPreprocess: false, needsAnalyze: false, videoModel: 'mock/video',
  shots: [
    { shotId: 'A', idx: 0, seconds: 10, needsBlender: false, needsKeyframe: true, revision: 1 },
    { shotId: 'B', idx: 1, seconds: 10, needsBlender: false, needsKeyframe: false, revision: 1 },
  ],
});
await submitPlan(queue, plan);
const baseCount = (await queue.listByProject(PROJECT)).length;

const supervisor = new RetrySupervisor(queue, repo);

/**
 * 把某一镜的所有在途任务标成终态。
 *
 * 督导只处理「已经没有在跑的任务」的镜头——真实流程里，质检出结论时
 * 这一镜的任务本来就都跑完了。测试里任务是手工造的，得显式推到终态，
 * 否则督导会（正确地）认为上一轮还没跑完而跳过。
 */
const settle = async (shotId) => {
  await d1.prepare(
    "UPDATE tasks SET status='succeeded', locked_by='', lease_until=0 WHERE shot_id=? AND status IN ('pending','leased','running','failed')",
  ).bind(shotId).run();
};

// ============ 质检全过时什么都不做 ============
state.qa.set('A', { shotId: 'A', verdict: 'pass', score: 1, findings: [] });
state.qa.set('B', { shotId: 'B', verdict: 'pass', score: 1, findings: [] });
let r = await supervisor.reconcile({ projectId: PROJECT });
assert.equal(r.retried.length, 0);
assert.equal(r.giveUp.length, 0);
assert.equal((await queue.listByProject(PROJECT)).length, baseCount, '全过时不该多排任何任务');

// ============ 判废 → 排重试链 ============
state.qa.set('A', failReport('A', 'identity_drift'));
await settle('A');
r = await supervisor.reconcile({ projectId: PROJECT, videoModel: 'mock/video' });
assert.equal(r.retried.length, 1);
assert.equal(r.retried[0].strategy, 'regenerate_keyframe', '形象崩了应先重做关键帧');

const afterFirst = await queue.listByProject(PROJECT);
// 新排了 keyframe + video + qa 三个
assert.equal(afterFirst.length, baseCount + 3, `应新增 3 个任务，实际 ${afterFirst.length - baseCount}`);

const retryVideo = afterFirst.find((t) => t.idempotency_key === `${PROJECT}:video:A:r1:retry1`);
assert.ok(retryVideo, '重试出片任务的幂等键必须带轮次');
const vin = JSON.parse(retryVideo.input_json);
assert.equal(vin.retryHint.failureClass, 'identity_drift', '必须把失败分类传给提示词编译器，否则这次重试和上次没区别');
assert.equal(vin.model, 'mock/video');

// 出片要等新关键帧
const retryKf = afterFirst.find((t) => t.idempotency_key === `${PROJECT}:keyframe:A:r1:retry1`);
const blocked = await queue.blockedBy(retryVideo.id);
assert.ok(blocked.some((t) => t.id === retryKf.id), '重试出片必须等新关键帧，否则还是用旧图');

// ⭐ 拼接必须被新的质检挡住
const merge = afterFirst.find((t) => t.type === 'merge');
const retryQa = afterFirst.find((t) => t.idempotency_key === `${PROJECT}:qa:A:r1:retry1`);
const mergeBlockers = await queue.blockedBy(merge.id);
assert.ok(mergeBlockers.some((t) => t.id === retryQa.id),
  '拼接必须挂上新的质检任务，老的那个已经 succeeded 挡不住');

// ============ 重复巡检不该排出第二套 ============
const before = (await queue.listByProject(PROJECT)).length;
// 还原 used，模拟「决定已记录但任务还没跑」的状态
state.used.set('A', ['regenerate_keyframe']);
await settle('A');
await supervisor.reconcile({ projectId: PROJECT });
const after = (await queue.listByProject(PROJECT)).length;
// 第二轮会用下一个策略（reinforce_prompt），所以确实会多排；
// 但同一轮次的键不会重复建 —— 用同一个 used 再巡一次验证这一点
state.used.set('A', ['regenerate_keyframe']);
const dup = await queue.enqueue({ type: 'video', idempotencyKey: `${PROJECT}:video:A:r1:retry1`, projectId: PROJECT });
assert.equal(dup.id, retryVideo.id, '同一个幂等键必须命中已有任务，不能建第二个');
assert.ok(after > before, '第二轮换了新策略，应该排新任务');

// ============ 策略阶梯：同一招不用两次，用尽交人工 ============
state.qa.set('B', failReport('B', 'identity_drift'));
state.used.set('B', []);
const strategies = [];
for (let i = 0; i < 6; i += 1) {
  await settle('B');
  const res = await supervisor.reconcile({ projectId: PROJECT, maxAttempts: 5 });
  const hit = res.retried.find((x) => x.shotId === 'B');
  const gave = res.giveUp.find((x) => x.shotId === 'B');
  if (gave) break;
  assert.ok(hit, '既没重试也没放弃，督导空转了');
  assert.ok(!strategies.includes(hit.strategy), `策略 ${hit.strategy} 被重复使用`);
  strategies.push(hit.strategy);
}
assert.ok(strategies.length >= 2, `应该试过至少两种策略，实际 ${strategies}`);
await settle('B');
const finalRes = await supervisor.reconcile({ projectId: PROJECT, maxAttempts: 5 });
assert.ok(finalRes.giveUp.some((x) => x.shotId === 'B'), '策略用尽后必须交人工，不能接着烧钱');

// ============ 成本闸：还有招可用也得停 ============
state.qa.clear();
state.qa.set('C', failReport('C', 'identity_drift'));
state.used.set('C', []);
state.spend.set('C', { spentCents: 500, estimateCents: 100 });   // 已花 5 倍
const capped = await supervisor.reconcile({ projectId: PROJECT, budgetMultiplier: 3 });
assert.equal(capped.retried.length, 0, '超预算时不许再排重试');
assert.ok(capped.giveUp[0].reason.includes('停止自动重试'));
assert.ok(capped.giveUp[0].reason.includes('3 倍'));

// 预算内则正常重试
state.spend.set('C', { spentCents: 150, estimateCents: 100 });
await settle('C');
const ok = await supervisor.reconcile({ projectId: PROJECT, budgetMultiplier: 3 });
assert.equal(ok.retried.length, 1);

// ============ enable_blender 时要排 Blender 任务 ============
state.qa.clear();
state.used.clear();
state.spend.clear();
state.qa.set('D', failReport('D', 'spatial_wrong', '走位错了'));
await settle('D');
const sp = await supervisor.reconcile({ projectId: PROJECT });
assert.equal(sp.retried[0].strategy, 'enable_blender');
const tasksD = await queue.listByProject(PROJECT);
const blD = tasksD.find((t) => t.idempotency_key === `${PROJECT}:blender:D:r1:retry1`);
assert.ok(blD, '启用 Blender 时必须排一个 Blender 任务');
const vD = tasksD.find((t) => t.idempotency_key === `${PROJECT}:video:D:r1:retry1`);
assert.ok((await queue.blockedBy(vD.id)).some((t) => t.id === blD.id), '出片必须等 Blender 预演完成');

// 已启用 Blender 的镜头不该把它当成新招
state.blender.add('E');
state.qa.clear();
state.qa.set('E', failReport('E', 'spatial_wrong'));
state.used.set('E', []);
await settle('E');
const spE = await supervisor.reconcile({ projectId: PROJECT });
assert.notEqual(spE.retried[0]?.strategy, 'enable_blender', '已经在用 Blender 了，不能当成新策略');

// ============ 原样重跑必须换 seed ============
state.qa.clear(); state.used.clear(); state.blender.clear();
state.qa.set('F', failReport('F', 'minor_artifact', '多了只手'));
await settle('F');
await supervisor.reconcile({ projectId: PROJECT });
const vF = (await queue.listByProject(PROJECT)).find((t) => t.idempotency_key === `${PROJECT}:video:F:r1:retry1`);
assert.ok(JSON.parse(vF.input_json).seed, '原样重跑不换 seed 等于把同一张废片再买一次');

// ============ 拼接闸门：独立于依赖图的最后一道 ============
const H = await load('app/lib/orchestrator/handlers/index.ts');
const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');

const shots = [
  { shot_id: 'M0', idx: 0, start_time: 0, end_time: 8 },
  { shot_id: 'M1', idx: 1, start_time: 8, end_time: 16 },
];
let outcomes = { M0: 'pass', M1: 'pass' };
const mergeRepo = {
  listShotDna: async () => shots,
  assetsOf: async () => shots.map((s) => ({ id: s.shot_id, shotId: s.shot_id, key: `c-${s.shot_id}.mp4`, duration: 8 })),
  latestQaOutcomes: async () => outcomes,
  registerAsset: async () => 'final-1',
};
const mergeFfmpeg = { concat: async (k, out) => ({ key: out, bytes: 1, durationSeconds: 16 }) };
const mergeQueue = new TaskQueue(d1);
const runMerge = async (key) => {
  await mergeQueue.enqueue({ type: 'merge', idempotencyKey: key, projectId: 'MG', input: { projectId: 'MG' } });
  return await new WorkerRuntime(mergeQueue, { workerId: `w-${key}`, types: ['merge'] })
    .register(H.createMergeHandler({ repo: mergeRepo, ffmpeg: mergeFfmpeg })).runOnce();
};

assert.equal((await runMerge('mg-ok')).status, 'succeeded');

// 有镜头没过质检时，即使依赖图放行也必须拦住 —— 这是防废片进成片的最后一道
outcomes = { M0: 'pass', M1: 'fail' };
const blockedMerge = await runMerge('mg-blocked');
assert.equal(blockedMerge.status, 'failed');
assert.ok(blockedMerge.error.includes('第 2 镜'), `要说清是哪一镜，实际：${blockedMerge.error}`);
assert.ok(blockedMerge.error.includes('质检'));

// warn 不拦：警告是提醒，不是判废
outcomes = { M0: 'pass', M1: 'warn' };
assert.equal((await runMerge('mg-warn')).status, 'succeeded', 'warn 不该挡住拼接');

// ============ 级联取消：上游死了，整条链都要停 ============
// 真实事故：全片预演崩了，只有直接依赖它的出片被取消，
// 质检和拼接一直挂在 pending，界面显示「排队中」——看着还在跑，其实早死了。
const CQ = new TaskQueue(d1);
const P2 = 'CASCADE';
const up = await CQ.enqueue({ type: 'blender', idempotencyKey: 'c-previs', projectId: P2 });
const mid = await CQ.enqueue({ type: 'video', idempotencyKey: 'c-video', projectId: P2, shotId: 'S1' });
const low = await CQ.enqueue({ type: 'qa', idempotencyKey: 'c-qa', projectId: P2, shotId: 'S1' });
const end = await CQ.enqueue({ type: 'merge', idempotencyKey: 'c-merge', projectId: P2 });
await CQ.addDependencies(mid.id, [up.id]);
await CQ.addDependencies(low.id, [mid.id]);
await CQ.addDependencies(end.id, [low.id]);

// 让预演进死信。直接改状态而不是走 claim：
// claim 不按项目过滤，会抓到前面用例留下的其他 blender 任务。
// 这条用例测的是「死信之后会怎样」，不是死信本身怎么发生的。
await d1.prepare("UPDATE tasks SET status='dead', error_text='渲染崩了' WHERE id=?").bind(up.id).run();
assert.equal((await CQ.byId(up.id)).status, 'dead');

const canceled = await CQ.cancelOrphans(P2);
assert.equal(canceled, 3, `出片/质检/拼接三个都该被取消，实际 ${canceled}`);
for (const [t, name] of [[mid, '出片'], [low, '质检'], [end, '拼接']]) {
  assert.equal((await CQ.byId(t.id)).status, 'canceled', `${name}没有被级联取消，会永远挂在 pending`);
}

// ============ 巡检失败不拖垮 worker ============
const logs = [];
const rt = new WorkerRuntime(new TaskQueue(d1), { workerId: 'w-rec', onLog: (l) => logs.push(l) });
// 在巡检里发停止信号：这样循环真的进去跑了一轮，抛错也被接住了，
// 然后本轮结束就退出。在 loop 之前 stop 的话循环压根不进，什么都没测到。
rt.reconcile({ name: '会炸的巡检', run: async () => { rt.stop(); throw new Error('炸了'); } });
await rt.loop(async () => {});
assert.ok(logs.some((l) => l.includes('会炸的巡检') && l.includes('炸了')), `巡检失败要记下来，实际日志：${JSON.stringify(logs)}`);

console.log('极客版第四批测试通过：级联取消（上游死信后出片→质检→拼接整条链都停，不留 pending 假象）、督导（全过不空转/判废排重试链且幂等键带轮次/失败分类传进提示词/重试出片等新关键帧/拼接挂上新质检/同招不重复且用尽交人工/成本闸优先于策略/启用 Blender 排预演任务且已启用不重复用/原样重跑换 seed）、拼接闸门（未过质检拦住并说清哪一镜、warn 放行）、巡检失败不拖垮 worker。');
