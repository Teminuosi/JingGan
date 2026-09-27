// 多任务端到端烟测：真的起 worker 进程，跑完一整张任务图。
//
// 和单元测试的区别：这里用的是真数据库文件、真磁盘、真 handler 注册链，
// 只有 Provider 和 Blender 是 Mock（不花钱、本机没装）。
// 它要回答的是「这些东西接在一起还能不能跑」，而不是「每个函数对不对」。
//
// 用法：node scripts/smoke-worker.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { applySql, createD1 } from './d1-stub.mjs';
import { createRepo } from '../worker/repo.mjs';

const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-worker-smoke-'));

const db = createD1(path.join(WORK, 'pipeline.sqlite'));
for (const f of fs.readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()) {
  applySql(db, fs.readFileSync(path.join('drizzle', f), 'utf8'));
}

const { buildShotDna } = await load('app/lib/shot-dna/build.ts');
const { routeShots } = await load('app/lib/complexity/engine.ts');
const { planProject, submitPlan, projectProgress } = await load('app/lib/orchestrator/plan.ts');
const { TaskQueue } = await load('app/lib/task/queue.ts');

const PROJECT = 'SMOKE';
const repo = createRepo(db);

// 项目行必须先存在：shots.project_id 是它的外键。
// 这一步在真实流程里由「创建项目」那个接口做，烟测要照着真实顺序来。
db.prepare('INSERT INTO users (id,email,display_name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .bind('U-SMOKE', 'smoke@local', '烟测', 'user', 'active', Date.now(), Date.now()).run();
db.prepare('INSERT INTO projects (id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .bind(PROJECT, 'U-SMOKE', '端到端烟测', 'created', Date.now(), Date.now()).run();

// ---- 造三个镜头：一简单、一复杂（该上 Blender）、一普通 ----
const analysis = {
  schema_version: 'video-dna.v1',
  source: { duration_seconds: 24, aspect_ratio: '9:16', language: 'zh', format_type: '', one_line_summary: '', rights_risks: [] },
  style_dna: { visual: { medium: '实拍', palette: ['冷蓝'], textures: [], atmosphere: '压抑', lighting_logic: '' } },
  source_roles: [], beats: [], preserve_recommendations: [], replace_recommendations: [],
  originality_risks: [], uncertainties: [],
};
const mkBeat = (i, over = {}) => ({
  beat_id: `SH${i}`, start_seconds: i * 8, end_seconds: (i + 1) * 8,
  role_ids: ['ROLE_A'], narrative_function: '', visual_action: `第 ${i + 1} 镜`,
  action_beats: [{ at_seconds: i * 8, actor_ids: ['ROLE_A'], action: '说话' }],
  environment: '室内，办公室', props: [],
  framing: '中景', camera_motion: '固定机位', composition: '',
  lighting: '侧光', color: '', sound: '',
  dialogue: { speaker_role: 'ROLE_A', speaker_on_screen: true, source_text: '台词', semantic_intent: '', delivery: '', approx_characters: 2 },
  transition_in: '', continuity_in: '', continuity_out: '', confidence: 0.9, ...over,
});

const shots = [0, 1, 2].map((i) => buildShotDna(mkBeat(i), analysis, { projectId: PROJECT, idx: i }));
// 第 2 镜做成复杂镜：四人 + 环绕运镜，应该被路由去 Blender
shots[1].actors = ['A', 'B', 'C', 'D'].map((id, n) => ({
  character_id: id, role_in_shot: '', props_held: [], facing: '', wardrobe: '',
  screen_position: ['left', 'center_left', 'center_right', 'right'][n],
  depth_layer: ['foreground', 'midground', 'background', 'midground'][n],
}));
shots[1].camera.movement = 'orbit';
shots[1].action_timeline = [
  { at: 0, actor_ids: ['A'], action: '指', toward_ids: ['B'] },
  { at: 3, actor_ids: ['B'], action: '推', toward_ids: ['C'] },
];

for (const dna of shots) await repo.saveShotDna(dna);
console.log(`已写入 ${shots.length} 个镜头的 Shot DNA`);

// 读回来核对：写进去什么就该读出什么
const roundTrip = await repo.getShotDna('SH1');
if (!roundTrip) throw new Error('Shot DNA 读不回来');
if (roundTrip.actors.length !== 4) throw new Error(`角色数对不上：写入 4，读出 ${roundTrip.actors.length}`);
if (roundTrip.start_time !== 8) throw new Error(`起始时间对不上：期望 8，读出 ${roundTrip.start_time}`);
if (roundTrip.dialogue.text !== '台词') throw new Error('对白丢了');
console.log('Shot DNA 往返读写一致');

// ---- 路由 + 建任务图 ----
const routed = routeShots(shots);
console.log('复杂度路由：', routed.map((r) => `${r.shotId}=${r.complexity.score}${r.needsBlender ? '(Blender)' : ''}`).join(' '));
if (!routed[1].needsBlender) throw new Error('四人环绕镜应该被路由去 Blender');
if (routed[0].needsBlender) throw new Error('单人固定机位镜不该上 Blender');

const plan = planProject({
  projectId: PROJECT, needsPreprocess: false, needsAnalyze: false, previsMode: 'per_shot',
  shots: routed.map(({ shotId, idx, seconds, needsBlender, needsKeyframe, revision }) =>
    ({ shotId, idx, seconds, needsBlender, needsKeyframe, revision })),
});
const queue = new TaskQueue(db);
const rows = await submitPlan(queue, plan);
console.log(`任务图：${rows.length} 个任务（${plan.filter((t) => t.type === 'blender').length} 个 Blender、${plan.filter((t) => t.type === 'keyframe').length} 个关键帧）`);

// ---- 造出片产物：让 video handler 走 Mock，qa/merge 用假 ffmpeg ----
// 这里不起真 worker 子进程，而是在本进程里注册同一套 handler——
// 目的是验证「依赖顺序 + 仓储读写 + handler 串联」，子进程那一层上一批已经验过了。
const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');
const { createVideoHandler } = await load('app/lib/orchestrator/handlers/video.ts');
const H = await load('app/lib/orchestrator/handlers/index.ts');
const { MockBlenderRunner } = await load('app/lib/blender/runner.ts');
const { buildVideoGateway } = await load('app/lib/providers/gateway.ts');
const { MemoryObjectStore } = await load('app/lib/storage/object-store.ts');

const store = new MemoryObjectStore();

// 让 SH2 第一次出片「形象崩了」，第二次正常。
// 用形象漂移而不是时长不对：后者在重试引擎里被判为 provider_rejected（要 8 秒给 3 秒
// 基本是参数问题，重跑还是一样），会直接交人工，验不到自动重试这条路。
// identity_drift 才是真实里最常见、也确实该自动重试的那一类。
const driftOnce = new Set(['SH2']);
const fakeFfmpeg = {
  probe: async () => ({ durationSeconds: 8, width: 720, height: 1280, bytes: 2_000_000, hasAudio: true }),
  cut: async (_s, _a, _b, k) => ({ key: k, bytes: 1000 }),
  extractFrames: async (_k, at) => at.map((t) => `frame@${t}`),
  concat: async (keys, outKey) => ({ key: outKey, bytes: keys.length * 1000, durationSeconds: keys.length * 8 }),
};

const { RetrySupervisor } = await load('app/lib/orchestrator/supervisor.ts');
const supervisor = new RetrySupervisor(queue, repo);

const runtime = new WorkerRuntime(queue, { workerId: 'smoke', onLog: (l) => console.log('  ' + l) })
  .register(H.createBlenderHandler({ repo, store, runner: new MockBlenderRunner(), aspectRatioOf: async () => '9:16' }))
  .register(H.createQaHandler({
    repo, ffmpeg: fakeFfmpeg,
    inspect: async ({ dna }) => {
      const drifted = driftOnce.delete(dna.shot_id);
      return {
        charactersPresent: Object.fromEntries(dna.actors.map((a) => [a.character_id, true])),
        identityMatch: Object.fromEntries(dna.actors.map((a) => [a.character_id, drifted ? 0.3 : 0.9])),
        modelConfidence: 0.9,
      };
    },
  }))
  .register(H.createMergeHandler({ repo, ffmpeg: fakeFfmpeg }))
  .register(H.createKeyframeHandler({
    repo, store, model: 'mock-img', creds: { baseUrl: '', apiKey: '' },
    provider: { name: 'mock-img', estimateCents: () => 0, generate: async () => ({ images: [{ dataUri: 'data:image/png;base64,AA' }] }) },
    decodeDataUri: () => ({ bytes: new ArrayBuffer(128), contentType: 'image/png' }),
  }))
  .register(createVideoHandler({
    gateway: buildVideoGateway([{ provider: 'mock', baseUrl: '', apiKey: '' }]),
    store, sleep: async () => {}, pollIntervalMs: 0,
    prompts: {
      getShotDna: (id) => repo.getShotDna(id),
      compileContext: (pid) => repo.compileContext(pid),
      save: (id, p) => repo.setShotPrompt(id, p),
    },
    persistJobId: async () => {},
    registerAsset: async ({ projectId, shotId, key, bytes, seconds }) =>
      await repo.registerAsset({ projectId, shotId, kind: 'video_result', key, contentType: 'video/mp4', bytes, duration: seconds }),
  }));

// ---- 跑到没活为止 ----
// 不需要手工给质检回填成片 key：质检 handler 自己去资产表取最新那份。
// 这一段以前是手工补的，正因为补了，真实环境里「没人回填」这个洞一直没被测出来。
let guard = 0;
for (;;) {
  if (guard += 1, guard > 100) throw new Error('跑了 100 轮还没跑完，多半是依赖成环了');

  // 督导巡检：质检判废的镜头在这里被重新排上任务
  const sup = await supervisor.reconcile({
    projectId: PROJECT, videoModel: 'mock/video',
    log: (l) => console.log('  [督导] ' + l),
  });
  for (const g of sup.giveUp) console.log(`  [督导] 放弃 ${g.shotId}：${g.reason}`);

  const r = await runtime.runOnce();
  if (r.status === 'idle' && !sup.retried.length) break;
  if (r.status === 'idle') continue;
  if (r.status === 'failed') throw new Error(`任务 ${r.task?.type} 失败：${r.error}`);
}

// ---- 核对 ----
const tasks = await queue.listByProject(PROJECT);
const progress = projectProgress(tasks);
console.log(`\n进度：${progress.succeeded}/${progress.total}（${progress.percent}%）状态=${progress.stage}`);

const byType = {};
for (const t of tasks) byType[t.type] = (byType[t.type] ?? 0) + (t.status === 'succeeded' ? 1 : 0);
console.log('各类任务成功数：', JSON.stringify(byType));

if (progress.succeeded !== progress.total) {
  const stuck = tasks.filter((t) => t.status !== 'succeeded');
  throw new Error(`还有 ${stuck.length} 个任务没成功：${stuck.map((t) => `${t.type}/${t.status}`).join(' ')}`);
}

const finals = await repo.assetsOf(PROJECT, 'final_video');
if (finals.length !== 1) throw new Error(`应该只有一条成片，实际 ${finals.length}`);
if (finals[0].duration !== 24) throw new Error(`成片时长应为 24 秒，实际 ${finals[0].duration}`);

// 三镜 + SH2 重试一次 = 4 份报告；最终每镜的最新结论都必须是 pass
const qaRows = db.prepare('SELECT shot_id, outcome FROM quality_reports ORDER BY created_at ASC').all().results;
if (qaRows.length !== 4) throw new Error(`应有 4 份质检报告（三镜 + SH2 重试一次），实际 ${qaRows.length}`);
const finalOutcome = {};
for (const r of qaRows) finalOutcome[r.shot_id] = r.outcome;
const notPassed = Object.entries(finalOutcome).filter(([, o]) => o !== 'pass');
if (notPassed.length) throw new Error(`最终仍未通过：${JSON.stringify(notPassed)}`);

const blenderAssets = await repo.assetsOf(PROJECT, 'blender_preview');
if (!blenderAssets.length) throw new Error('复杂镜应该产出 Blender 预演文件');

// ⭐ Blender 的意义在于把空间关系喂给视频模型，不是产出几张图。
// 所以必须验证：预演算出的站位真的进了那一镜的出片提示词。
const previs = (await repo.getShotDna('SH1')).complexity.previs;
if (!previs?.blocking) throw new Error('预演结果没有写回 Shot DNA');
const promptRow = db.prepare('SELECT prompt_text FROM shots WHERE id=?').bind('SH1').first();
if (!promptRow?.prompt_text.includes('空间关系')) {
  throw new Error('Blender 镜的提示词里没有空间关系段，预演白做了');
}
if (!promptRow.prompt_text.includes('画面左侧')) {
  throw new Error('提示词里没有具体站位描述');
}
// 逐镜模式下每一镜都该有预演，且都该把空间关系带进提示词
for (const id of ['SH0', 'SH1', 'SH2']) {
  const p = db.prepare('SELECT prompt_text FROM shots WHERE id=?').bind(id).first();
  if (!p?.prompt_text.includes('空间关系')) {
    throw new Error(`${id} 做了逐镜预演，提示词里却没有空间关系段`);
  }
}
// 反过来：预演任务数必须等于镜头数，不能多也不能少
const previsCount = db.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND type='blender'").bind(PROJECT).first().c;
if (previsCount !== 3) throw new Error(`逐镜模式应有 3 个预演任务，实际 ${previsCount}`);
console.log('Blender 空间关系已进入出片提示词');

// ⭐ 闭环验证：SH2 第一次被判废，必须由督导救回来
const sh2Reports = db.prepare("SELECT outcome, decision FROM quality_reports WHERE shot_id='SH2' ORDER BY created_at ASC").all().results;
if (sh2Reports.length < 2) throw new Error(`SH2 应该有两份质检报告（一废一过），实际 ${sh2Reports.length}`);
if (sh2Reports[0].outcome !== 'fail') throw new Error('SH2 第一次应该判废');
if (!sh2Reports[0].decision) throw new Error('判废之后必须记下处置决定，否则查不出系统做了什么');
if (sh2Reports.at(-1).outcome !== 'fail' && sh2Reports.at(-1).outcome !== 'pass') throw new Error('结论异常');
if (sh2Reports.at(-1).outcome !== 'pass') throw new Error('SH2 重试后应该通过');
const retryVideo = db.prepare("SELECT COUNT(*) c FROM tasks WHERE shot_id='SH2' AND type='video'").first();
if (retryVideo.c < 2) throw new Error(`SH2 应该有两个出片任务（原始+重试），实际 ${retryVideo.c}`);
if (sh2Reports[0].decision !== 'regenerate_keyframe') {
  throw new Error(`形象崩了应该先重做关键帧，实际决策是 ${sh2Reports[0].decision}`);
}
// 重试的出片必须带上 retryHint，否则这次和上次没区别
const retryIn = db.prepare("SELECT input_json FROM tasks WHERE shot_id='SH2' AND type='video' ORDER BY created_at DESC LIMIT 1").first();
if (!JSON.parse(retryIn.input_json).retryHint) throw new Error('重试出片没带 retryHint，等于原样重跑');
console.log(`闭环验证通过：SH2 首次判废 → 决策「${sh2Reports[0].decision}」→ 重排关键帧与出片 → 复检通过`);

console.log(`成片 ${finals[0].duration}s、质检报告 ${qaRows.length} 份、Blender 预演 ${blenderAssets.length} 个文件`);
console.log('\n端到端烟测通过：复杂度路由 → 任务图 → 关键帧/Blender/出片/质检/拼接全链路跑通，仓储读写一致，进度 100%。');
