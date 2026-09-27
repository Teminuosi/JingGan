// Worker 进程入口（Node 侧）。
//
// 为什么需要独立进程：Cloudflare Workers 有 CPU 时间上限、没有文件系统、起不了子进程，
// 跑不了 FFmpeg 和 Blender，也留不住一个要等六分钟的视频任务。
// 所以站点仍在 Workers 上，长任务搬到这里。两边共用同一个 D1 数据库和同一套队列表。
//
// 用法：
//   npm run worker                       处理所有类型
//   WORKER_TYPES=video,qa npm run worker  只处理指定类型（Blender 机器单独跑一份）
//
// 退出：收到 SIGINT/SIGTERM 后不立刻杀，而是跑完手上这一个再退。
// 视频任务一旦提交给上游，钱就已经在花了，中途硬杀等于白扔。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import { createBlenderRunner } from './blender-exec.mjs';
import { selectPrevisClip } from './previs-selection.mjs';
import { applySql, createD1 } from '../scripts/d1-stub.mjs';
import { createDiskStore, createFfmpeg, createRepo } from './repo.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 复用测试里那套 esbuild 即时编译，免得为 worker 单独配一条构建链。 */
async function load(rel) {
  const r = await build({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, platform: 'node', format: 'esm',
  });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找 miniflare 给 D1 落的那个 sqlite 文件。找不到返回 undefined，调用方退回本地库。 */
function findLocalD1(root) {
  const dir = path.join(root, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!files.length) return undefined;
  // 多个的话取最近改动的那个——它才是当前在用的库
  return files
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => path.join(dir, x.f))[0];
}

async function main() {
  // 本地开发用 node:sqlite 落盘；接真 D1 时把这里换成 wrangler 的绑定即可，
  // 队列和 handler 一行都不用改——它们只认 D1Database 接口。
  // 默认直接用网站那个 miniflare D1 文件，而不是另开一个库。
  // 分两个库的话 worker 写的东西网站看不见，进度页永远是空的——
  // 这是本地开发最容易踩的一脚，所以默认就走同一个。
  const dbPath = process.env.WORKER_DB ?? findLocalD1(ROOT) ?? path.join(ROOT, '.worker', 'pipeline.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  console.log(`[worker] 数据库：${dbPath}`);
  const db = createD1(dbPath);
  for (const f of fs.readdirSync(path.join(ROOT, 'drizzle')).filter((f) => f.endsWith('.sql')).sort()) {
    applySql(db, fs.readFileSync(path.join(ROOT, 'drizzle', f), 'utf8'));
  }

  const { TaskQueue } = await load('app/lib/task/queue.ts');
  const { WorkerRuntime } = await load('app/lib/orchestrator/runtime.ts');
  const { createVideoHandler } = await load('app/lib/orchestrator/handlers/video.ts');
  const H = await load('app/lib/orchestrator/handlers/index.ts');
  const { MockBlenderRunner, SubprocessBlenderRunner } = await load('app/lib/blender/runner.ts');
  const { MockImageProvider } = await load('app/lib/providers/mock-image.ts');
  const { RetrySupervisor } = await load('app/lib/orchestrator/supervisor.ts');
  const { buildVideoGateway } = await load('app/lib/providers/gateway.ts');
  const { Wallet } = await load('app/lib/billing/wallet.ts');

  const queue = new TaskQueue(db);
  const types = process.env.WORKER_TYPES?.split(',').map((s) => s.trim()).filter(Boolean);
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

  // Provider 配置从环境来，代码里不写死上游地址与密钥。
  // 没配 Key 就只挂 Mock：宁可跑假的，也不要因为缺配置就整条管线起不来。
  const providers = process.env.OPENROUTER_API_KEY
    ? [{ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY }]
    : [{ provider: 'mock', baseUrl: '', apiKey: '' }];
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[worker] 未设置 OPENROUTER_API_KEY，视频任务将走 Mock，不会产生真实费用也不会有真成片');
  }

  const objectRoot = process.env.WORKER_OBJECTS ?? path.join(ROOT, '.worker', 'objects');
  const store = createDiskStore(objectRoot);
  const repo = createRepo(db);
  const ffmpeg = createFfmpeg(objectRoot);

  const gateway = buildVideoGateway(providers, {
    // Mock 出片时用 ffmpeg 合成一段同长的黑场，让下游拿到的是真能解析的文件
    mock: { generationMs: 0, renderBytes: (seconds) => ffmpeg.synthClip(seconds) },
    onCall: async (call) => {
      await db.prepare(
        `INSERT INTO provider_requests
           (id,task_id,provider,model,operation,upstream_job_id,request_json,response_json,
            http_status,latency_ms,provider_cost_cents,error_text,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), '', call.provider, call.model, call.operation,
        call.upstreamJobId ?? '', JSON.stringify(call.request), JSON.stringify(call.response ?? null),
        call.httpStatus, call.latencyMs, call.providerCostCents, call.error ?? '', Date.now()).run();
    },
  });


  // 装了 Blender 就用真的，没装用 Mock。
  // Mock 一样能产出空间关系描述——那部分是本地算的，不依赖渲染。
  const blenderPath = process.env.BLENDER_PATH;
  const blenderRunner = blenderPath
    ? createBlenderRunner(SubprocessBlenderRunner, {
        blenderPath, objectRoot, ffmpeg, fs, path,
        onWarn: (msg) => console.warn(`[worker] ${msg}`),
      })
    : new MockBlenderRunner({
        writeFile: async (key, bytes) => { await store.put(key, bytes.buffer, 'application/octet-stream'); },
      });
  if (!blenderPath) console.warn('[worker] 未设置 BLENDER_PATH，3D 预演走 Mock（空间描述仍然有效，只是没有渲染图）');
  if (!process.env.IMAGE_MODEL) console.warn('[worker] 未配置图片 Provider，关键帧走 Mock（产出占位图，不花钱）');

  const runtime = new WorkerRuntime(queue, { workerId, types, onLog: (l) => console.log(l) })
    .register(H.createPreprocessHandler({
      repo, ffmpeg,
      sourceKeyOf: async (projectId) => {
        const row = await db.prepare("SELECT object_key FROM assets WHERE project_id=? AND kind='source_video' ORDER BY created_at DESC LIMIT 1")
          .bind(projectId).first();
        return row?.object_key ?? '';
      },
    }))
    .register(H.createBlenderHandler({ repo, store, runner: blenderRunner, aspectRatioOf: (id) => repo.aspectRatioOf(id) }))
    .register(H.createKeyframeHandler({
      repo, store,
      // 还没有真的图片 Provider，先挂 Mock。
      // 缺配置就让关键帧任务无人认领的话，依赖它的出片会永远卡在队列里，
      // 用户看到的是「不动」而不是「缺配置」——那是最难排查的一种故障。
      provider: new MockImageProvider(),
      creds: { baseUrl: '', apiKey: '' },
      model: process.env.IMAGE_MODEL ?? 'mock/image',
      decodeDataUri: (uri) => {
        const [head, data] = uri.split(',');
        return {
          bytes: Buffer.from(data ?? '', 'base64').buffer,
          contentType: /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/png',
        };
      },
    }))
    .register(H.createQaHandler({ repo, ffmpeg }))
    .register(H.createMergeHandler({ repo, ffmpeg }))
    .register(createVideoHandler({
      gateway,
      wallet: new Wallet(db),
      store,
      sleep,
      // 取这一镜的预演片段。全片模式要按镜切段，逐镜模式直接用那一镜的。
      // 返回 data URI 而不是 https：本地开发没有公网地址，而实测 data URI 也过 URL 校验。
      previsVideoFor: async ({ projectId, shotId, startTime, endTime }) => {
        const clips = await repo.assetsOf(projectId, 'blender_preview');
        const selected = selectPrevisClip(clips, shotId);
        if (!selected) return undefined;
        const own = selected.shotId === shotId ? selected : undefined;
        let file = own?.key;
        if (!file) {
          // 没有本镜专属的就用全片那条，按时间码切出这一镜
          const film = selected;
          if (!film || !(endTime > startTime)) return undefined;
          const cutKey = `previs-cut/${shotId}.mp4`;
          await ffmpeg.cut(film.key, startTime, endTime, cutKey);
          file = cutKey;
        }
        const full = path.join(objectRoot, file);
        if (!fs.existsSync(full)) return undefined;
        const bytes = fs.readFileSync(full);
        // 太大的话 data URI 会把请求体撑爆；超过 8MB 就不带，并让日志说清楚
        if (bytes.length > 8 * 1024 * 1024) {
          console.warn(`[worker] ${shotId} 的预演片段 ${(bytes.length / 1048576).toFixed(1)}MB，超过 8MB 上限，本次不带参考视频`);
          return undefined;
        }
        return `data:video/mp4;base64,${bytes.toString('base64')}`;
      },
      prompts: {
        getShotDna: (id) => repo.getShotDna(id),
        compileContext: (pid) => repo.compileContext(pid),
        save: (id, p) => repo.setShotPrompt(id, p),
      },
      // jobId 必须在提交成功那一刻就落库。丢过一次 1.03 美元，成片再也找不回来。
      persistJobId: async (taskId, provider, jobId) => {
        await db.prepare('UPDATE tasks SET output_json=? , updated_at=? WHERE id=?')
          .bind(JSON.stringify({ provider, jobId }), Date.now(), taskId).run();
      },
      registerAsset: async ({ projectId, shotId, key, bytes, seconds }) => {
        const id = crypto.randomUUID();
        await db.prepare(
          `INSERT INTO assets (id,project_id,owner_id,kind,store,object_key,content_type,bytes,width,height,duration,meta_json,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(id, projectId, '', 'video_result', 'local', key, 'video/mp4', bytes, 0, 0, seconds,
          JSON.stringify({ shotId }), Date.now()).run();
        return id;
      },
    }));

  // 重试督导：把质检结论接到重试引擎上，挂在循环里定期巡检。
  // 它是整条管线最后一块「自动」——没有它，质检说了这镜废了，然后就没有然后了。
  const supervisor = new RetrySupervisor(queue, repo);
  runtime.reconcile({
    name: '重试督导',
    run: async () => {
      // 只巡还在跑的项目。已完成/已失败的项目再巡也不会有新结论。
      const res = await db.prepare(
        "SELECT id FROM projects WHERE status NOT IN ('completed','failed','canceled')",
      ).all();
      for (const row of res.results ?? []) {
        const out = await supervisor.reconcile({
          projectId: row.id,
          videoModel: process.env.VIDEO_MODEL,
          hasFallbackProvider: providers.length > 1,
          log: (l) => console.log(`[督导] ${l}`),
        });
        for (const g of out.giveUp) console.warn(`[督导] ${g.shotId} 需要人工处理：${g.reason}`);
      }
    },
  });

  let stopped = false;
  const shutdown = (sig) => {
    if (stopped) { console.log('[worker] 再次收到信号，强制退出'); process.exit(1); }
    stopped = true;
    console.log(`[worker] 收到 ${sig}，跑完手上的任务后退出（视频任务不中断，否则钱白花）`);
    runtime.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`[worker] ${workerId} 启动，处理类型：${types?.join(',') ?? '全部'}，库：${dbPath}`);
  await runtime.loop(sleep);
  console.log('[worker] 已退出');
}

main().catch((err) => { console.error('[worker] 启动失败', err); process.exit(1); });
