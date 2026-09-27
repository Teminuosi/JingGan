// 端到端验证：全片预演真的渲出来，并且真的挂到了出片请求上。
//
// 这是整条"复刻"逻辑里最关键、也最容易静默失效的一环——
// 预演视频锁的是运镜曲线和走位轨迹，提示词文字锁不住这两样。
// 挂不上去的话管线照样全绿跑完，只是出来的片子跟原片没关系。
// 所以这里不看日志好不好看，直接抓 Provider 收到的请求体。
//
// 用法：node scripts/verify-previs-e2e.mjs
//   BLENDER_PATH 覆盖 blender 路径；没装 Blender 直接退出（这条验证的前提就是真渲染）

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createBlenderRunner } from '../worker/blender-exec.mjs';
import { createDiskStore, createFfmpeg, createRepo } from '../worker/repo.mjs';
import { applySql, createD1 } from './d1-stub.mjs';

const load = async (p) => {
  const r = await build({ entryPoints: [p], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
if (!fs.existsSync(BLENDER)) throw new Error(`找不到 Blender：${BLENDER}。用 BLENDER_PATH 指定路径`);

const WORK = path.resolve('.previs-e2e');
fs.rmSync(WORK, { recursive: true, force: true });
const objectRoot = path.join(WORK, 'objects');
fs.mkdirSync(objectRoot, { recursive: true });

const db = createD1(path.join(WORK, 'pipeline.sqlite'));
for (const f of fs.readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
  applySql(db, fs.readFileSync(path.join('drizzle', f), 'utf8'));
}

const { buildShotDna } = await load('app/lib/shot-dna/build.ts');
const { planProject, submitPlan } = await load('app/lib/orchestrator/plan.ts');
const { TaskQueue } = await load('app/lib/task/queue.ts');
const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');
const { createVideoHandler } = await load('app/lib/orchestrator/handlers/video.ts');
const H = await load('app/lib/orchestrator/handlers/index.ts');
const { SubprocessBlenderRunner } = await load('app/lib/blender/runner.ts');

const PROJECT = 'PREVISE2E';
const repo = createRepo(db);
const store = createDiskStore(objectRoot);
const ffmpeg = createFfmpeg(objectRoot);

db.prepare('INSERT INTO users (id,email,display_name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .bind('U', 'e2e@local', 'e2e', 'user', 'active', Date.now(), Date.now()).run();
db.prepare('INSERT INTO projects (id,owner_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .bind(PROJECT, 'U', '预演端到端', 'created', Date.now(), Date.now()).run();

// ---- 三镜，每镜 4 秒，带真实空间数据 ----
const analysis = {
  schema_version: 'video-dna.v1',
  source: { duration_seconds: 12, aspect_ratio: '9:16', language: 'zh', format_type: '', one_line_summary: '', rights_risks: [] },
  style_dna: { visual: { medium: '实拍', palette: ['冷蓝'], textures: [], atmosphere: '', lighting_logic: '' } },
  source_roles: [], beats: [], preserve_recommendations: [], replace_recommendations: [],
  originality_risks: [], uncertainties: [],
};
const mkBeat = (i) => ({
  beat_id: `SH${i}`, start_seconds: i * 4, end_seconds: (i + 1) * 4,
  role_ids: ['ROLE_A'], narrative_function: '', visual_action: `第 ${i + 1} 镜`,
  environment: '室内，食堂', props: [], framing: '中景', camera_motion: '固定机位', composition: '',
  lighting: '顶光', color: '', sound: '',
  dialogue: { speaker_role: 'ROLE_A', speaker_on_screen: true, source_text: '台词', semantic_intent: '', delivery: '', approx_characters: 2 },
  transition_in: '', continuity_in: '', continuity_out: '', confidence: 0.9,
});
const shots = [0, 1, 2].map((i) => buildShotDna(mkBeat(i), analysis, { projectId: PROJECT, idx: i }));
for (const [i, dna] of shots.entries()) {
  dna.actors = ['A', 'B', 'C'].slice(0, i + 1).map((id, n) => ({
    character_id: id, role_in_shot: '', props_held: [], facing: '面向镜头', wardrobe: '',
    screen_position: ['left', 'center', 'right'][n], depth_layer: 'midground',
  }));
  await repo.saveShotDna(dna);
}

const plan = planProject({
  projectId: PROJECT, needsPreprocess: false, needsAnalyze: false, previsMode: 'full',
  shots: shots.map((d, i) => ({ shotId: d.shot_id, idx: i, seconds: 4, needsBlender: false, needsKeyframe: false, revision: 1 })),
});
const queue = new TaskQueue(db);
await submitPlan(queue, plan);
console.log(`任务图 ${plan.length} 个，其中全片预演 ${plan.filter((t) => t.type === 'blender').length} 个`);

// ---- 抓请求：Provider 收到什么就记什么 ----
const seen = [];
const spyGateway = {
  estimateCents: () => 0,
  async generate(input) {
    seen.push({ prompt: input.prompt, referenceVideos: input.referenceVideos ?? [] });
    return {
      job: { jobId: `J${seen.length}`, status: 'completed' },
      binding: { provider: { name: 'spy' } },
    };
  },
  async status(jobId) { return { jobId, status: 'completed' }; },
  async download() { return new TextEncoder().encode('FAKE_MP4').buffer; },
};

const logs = [];
const runtime = new WorkerRuntime(queue, { workerId: 'e2e', onLog: (l) => { logs.push(l); console.log(`  ${l}`); } })
  .register(H.createBlenderHandler({
    repo,
    store,
    // 画幅必须跟着源片走。这条验证片是 9:16，预演就得渲 9:16。
    aspectRatioOf: async () => '9:16',
    // 用与 worker 完全相同的工厂拼执行器——这条验证才真的覆盖生产那条路。
    // 之前两边各拼一遍，worker 漏了 encodeFrames，验证脚本却全绿。
    runner: createBlenderRunner(SubprocessBlenderRunner, {
      blenderPath: BLENDER,
      objectRoot,
      ffmpeg,
      fs,
      path,
      onWarn: (m) => console.warn('[blender]', m),
    }),
  }))
  .register(createVideoHandler({
    gateway: spyGateway,
    store,
    sleep: async () => {},
    pollIntervalMs: 0,
    prompts: {
      getShotDna: (id) => repo.getShotDna(id),
      compileContext: (pid) => repo.compileContext(pid),
      save: (id, p) => repo.setShotPrompt(id, p),
    },
    persistJobId: async () => {},
    registerAsset: async (a) => await repo.registerAsset({
      projectId: a.projectId,
      shotId: a.shotId,
      kind: 'video_result',
      key: a.key,
      contentType: 'video/mp4',
      bytes: a.bytes,
      duration: a.seconds,
    }),
    // 与 worker/main.mjs 同一套取片逻辑
    previsVideoFor: async ({ projectId, shotId, startTime, endTime }) => {
      const mp4s = (await repo.assetsOf(projectId, 'blender_preview')).filter((c) => c.key.endsWith('.mp4'));
      if (!mp4s.length) return undefined;
      const own = mp4s.find((c) => c.shotId === shotId);
      let file = own?.key;
      if (!file) {
        const film = mp4s.find((c) => !c.shotId) ?? mp4s[0];
        if (!film || !(endTime > startTime)) return undefined;
        const cutKey = `previs-cut/${shotId}.mp4`;
        await ffmpeg.cut(film.key, startTime, endTime, cutKey);
        file = cutKey;
      }
      const full = path.join(objectRoot, file);
      if (!fs.existsSync(full)) return undefined;
      const bytes = fs.readFileSync(full);
      if (bytes.length > 8 * 1024 * 1024) return undefined;
      return `data:video/mp4;base64,${bytes.toString('base64')}`;
    },
  }))
  .register(H.createQaHandler({
    repo,
    ffmpeg,
    inspect: async ({ dna }) => ({
      charactersPresent: Object.fromEntries(dna.actors.map((a) => [a.character_id, true])),
      identityMatch: Object.fromEntries(dna.actors.map((a) => [a.character_id, 0.95])),
      modelConfidence: 0.95,
    }),
  }))
  .register(H.createMergeHandler({ repo, ffmpeg }));

for (let guard = 0; ; guard += 1) {
  if (guard > 60) throw new Error('跑了 60 轮还没完');
  const r = await runtime.runOnce();
  if (r.status === 'idle') break;
  if (r.status === 'failed' && (r.task?.type === 'blender' || r.task?.type === 'video')) {
    throw new Error(`${r.task.type} 任务失败：${r.error}`);
  }
}

// ---- 核对 ----
const fail = [];
const must = (ok, msg) => { console.log(`  ${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail.push(msg); };

console.log('\n== 核对 ==');
const filmMp4 = path.join(objectRoot, 'blender', `${PROJECT}-film`, 'previs.mp4');
must(fs.existsSync(filmMp4), `全片预演 MP4 落在 key 指向的位置（${path.relative(WORK, filmMp4)}）`);

must(seen.length === 3, `三镜都提交了出片请求（实际 ${seen.length}）`);
const withRef = seen.filter((s) => s.referenceVideos.length > 0);
must(withRef.length === seen.length, `每一镜都带上了参考视频（${withRef.length}/${seen.length}）`);
must(withRef.length > 0 && withRef.every((s) => s.referenceVideos[0].startsWith('data:video/mp4;base64,')),
  '参考视频是可直接提交的 data:video/mp4');
must(logs.some((l) => l.includes('已附带 3D 预演参考视频')), '日志如实记录了附带参考视频');
must(!logs.some((l) => l.includes('没有找到这一镜的 3D 预演')), '没有任何一镜悄悄跳过了参考视频');

// 切出来的必须是那一镜的时间码，不是整条全片
const cut = path.join(objectRoot, 'previs-cut', 'SH1.mp4');
if (fs.existsSync(cut)) {
  const seg = await ffmpeg.probe('previs-cut/SH1.mp4');
  must(Math.abs(seg.durationSeconds - 4) < 0.4, `第 2 镜切出的是 4 秒那一段（实际 ${seg.durationSeconds}s）`);
}
must(new Set(withRef.map((s) => s.referenceVideos[0])).size === withRef.length,
  '三镜拿到的是各自那一段，不是同一条全片喂了三遍');

if (fail.length) {
  console.error(`\n❌ ${fail.length} 项没过`);
  process.exit(1);
}
console.log('\n✅ 全片预演 → 按镜切段 → 挂进出片请求，整条通了');
