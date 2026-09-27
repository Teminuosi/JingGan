import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGemini, validateConnection } from './gemini.mjs';
import { createMedia, runAutomaticPrevis, saveJson } from './engine.mjs';
import { createRenderRuntime } from './runtime.mjs';
import { setupPage } from './setup-page.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ACTIVE = new Set(['uploading', 'queued', 'cutting', 'planning', 'rendering', 'reviewing', 'merging']);
const UUID = '[a-f0-9-]{36}';
export function findBlender() {
  if (process.env.BLENDER_PATH && existsSync(process.env.BLENDER_PATH)) return process.env.BLENDER_PATH;
  const base = 'C:/Program Files/Blender Foundation';
  return fs.readdir(base).then(names => names.sort().reverse().map(n => path.join(base, n, 'blender.exe')).find(existsSync)).catch(() => undefined);
}

export async function createPrevisServer({ directory = path.join(ROOT, '.worker', 'automatic-previs'), allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'], createModel = createGemini, run = runAutomaticPrevis, blenderPath, runtime } = {}) {
  blenderPath ??= await findBlender();
  await fs.mkdir(directory, { recursive: true });
  const setupToken = randomBytes(32).toString('hex');
  let importing = false;
  if (runtime) {
    await runtime.detect(); blenderPath = runtime.blender();
    try {
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'allowed-origins.json'), 'utf8'));
      for (const value of saved) { const url = new URL(value); if (url.protocol === 'https:' && url.origin === value && !allowedOrigins.includes(value)) allowedOrigins.push(value); }
    } catch { /* First run. */ }
  }
  const jobs = new Map(), secrets = new Map(), controllers = new Map();
  const cutJobs = new Map();
  const persist = job => saveJson(path.join(directory, job.id, 'job.json'), job);
  const readJob = async id => {
    if (jobs.has(id)) return jobs.get(id);
    try {
      const job = JSON.parse(await fs.readFile(path.join(directory, id, 'job.json'), 'utf8'));
      if (ACTIVE.has(job.status)) {
        job.status = 'interrupted'; job.message = '本地服务已重启；原始素材和每轮结果保留，未自动重发模型请求。'; await persist(job);
      }
      jobs.set(id, job); return job;
    } catch { return null; }
  };
  const snapshot = job => Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'token'));
  const authenticate = (req, url, job) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(token), b = Buffer.from(job.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const start = async (job, recoverSavedResponse = false) => {
    if (job.status === 'canceled') return;
    const controller = new AbortController(); controllers.set(job.id, controller);
    const connection = secrets.get(job.id);
    const jobDir = path.join(directory, job.id);
    try {
      const input = JSON.parse(await fs.readFile(path.join(jobDir, 'input.json'), 'utf8'));
      const probeMedia = createMedia({ blenderPath, signal: controller.signal });
      const probe = await probeMedia.probe(path.join(jobDir, 'source'));
      const factor = 960 / Math.max(probe.width, probe.height);
      const width = Math.max(2, Math.round(probe.width * factor / 2) * 2), height = Math.max(2, Math.round(probe.height * factor / 2) * 2);
      const result = await run({
        analysis: input.analysis, source: path.join(jobDir, 'source'), directory: path.join(jobDir, 'output'),
        signal: controller.signal, media: createMedia({ blenderPath, width, height, signal: controller.signal }),
        recoverSavedResponse,
        model: recoverSavedResponse ? async () => { throw new Error('恢复模式禁止调用模型'); } : createModel(connection, { onCall: async record => {
          await fs.appendFile(path.join(jobDir, 'model-calls.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
        } }),
        onProgress: async progress => {
          Object.assign(job, progress, { status: progress.stage, updatedAt: Date.now() }); await persist(job);
        },
      });
      Object.assign(job, { status: result.status, message: result.status === 'rendered_unreviewed' ? '全片预演已生成；编排仅调用模型 1 次，未进行模型视频审核，等待复看。' : '全片候选已生成；本地动作检查发现问题，详见报告。未自动追加模型调用。', hasVideo: true, modelCalls: result.modelCalls, modelComparisonPerformed: false, modelComparisonPassed: false, watchedEntireClip: false });
    } catch (error) {
      job.status = controller.signal.aborted ? 'canceled' : 'failed';
      // Never serialize upstream errors containing credentials or request bodies.
      job.message = String(error.message || error).split(connection?.apiKey || '\0').join('[REDACTED]').slice(0, 1200);
    } finally {
      secrets.delete(job.id); controllers.delete(job.id);
      job.updatedAt = Date.now(); await persist(job);
    }
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) }); res.end(JSON.stringify(value)); };
    try {
      const setupRequest = runtime && /^\/(?:setup(?:\?|$)|runtime\/)/.test(req.url) && origin === `http://${host}`;
      if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && !allowedOrigins.includes(origin) && !setupRequest)) return json(403, { error: '仅允许已批准的镜感页面访问，请在本机助手设置中授权网站' });
      if (req.method === 'OPTIONS') {
        if (!allowedOrigins.includes(origin)) return json(403, { error: '来源不允许' });
        res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' }); return res.end();
      }
      const url = new URL(req.url, `http://${host}`);
      const localOrigin = `http://${host}`;
      if (runtime && url.pathname === '/setup' && req.method === 'GET') {
        if (origin && origin !== localOrigin) return json(403, { error: '请在本机打开助手设置' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'" });
        return res.end(setupPage(setupToken, url.searchParams.get('site') || ''));
      }
      if (runtime && url.pathname.startsWith('/runtime/')) {
        if (origin && origin !== localOrigin) return json(403, { error: '环境设置只能在本机助手页面操作' });
        if (url.pathname === '/runtime/status' && req.method === 'GET') return json(200, { ...runtime.status(), ...(importing ? { phase: 'importing', message: '正在接收离线包' } : {}), origins: allowedOrigins });
        if (req.method !== 'POST' || origin !== localOrigin || req.headers['x-mirror-setup'] !== setupToken) return json(403, { error: '请通过助手设置页面确认操作' });
        if ([...jobs.values()].some(j => ACTIVE.has(j.status))) return json(409, { error: '预演正在运行，请结束后再调整环境' });
        if (importing) return json(409, { error: '正在接收离线包，请稍候' });
        if (url.pathname === '/runtime/import') {
          if (!['missing', 'error'].includes(runtime.status().phase)) return json(409, { error: '环境已就绪或正在准备' });
          importing = true;
          const imported = path.join(directory, 'blender-import.zip');
          try {
            const file = await fs.open(imported, 'w'); let size = 0;
            try { for await (const chunk of req) { size += chunk.length; if (size > 512 * 1024 ** 2) throw new Error('安装包超过大小限制'); await file.writeFile(chunk); } }
            finally { await file.close(); }
            void runtime.prepare(imported).then(() => { blenderPath = runtime.blender(); }).catch(() => {}).finally(() => fs.rm(imported, { force: true }).catch(() => {}));
            return json(202, runtime.status());
          } catch (error) { await fs.rm(imported, { force: true }).catch(() => {}); throw error; }
          finally { importing = false; }
        }
        if (url.pathname === '/runtime/prepare') {
          if (!['missing', 'error', 'ready'].includes(runtime.status().phase)) return json(409, { error: '正在准备，请稍候' });
          void runtime.prepare().then(() => { blenderPath = runtime.blender(); }).catch(() => {}); return json(202, runtime.status());
        }
        if (url.pathname === '/runtime/cancel') { runtime.cancel(); return json(200, runtime.status()); }
        if (url.pathname === '/runtime/origin') {
          let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 2048) throw new Error('网址过长'); }
          const candidate = new URL(JSON.parse(text).site);
          if (candidate.protocol !== 'https:' || candidate.username || candidate.password) throw new Error('请输入镜感网站的 HTTPS 地址');
          if (!allowedOrigins.includes(candidate.origin)) allowedOrigins.push(candidate.origin);
          await saveJson(path.join(directory, 'allowed-origins.json'), allowedOrigins.filter(value => value.startsWith('https:')));
          return json(200, { origin: candidate.origin });
        }
        return json(404, { error: '未知操作' });
      }
      const savedSource = new RegExp(`^/projects/(${UUID})/source$`).exec(url.pathname);
      if (savedSource && req.method === 'GET') {
        if (!allowedOrigins.includes(origin)) return json(403, { error: '读取原片需要项目页面来源' });
        const candidates = [];
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || !new RegExp(`^${UUID}$`).test(entry.name)) continue;
          try {
            const folder = path.join(directory, entry.name);
            const record = JSON.parse(await fs.readFile(path.join(folder, 'job.json'), 'utf8'));
            if (record.projectId !== savedSource[1] || ['uploading', 'queued'].includes(record.status)) continue;
            const source = path.join(folder, 'source');
            const stat = await fs.stat(source);
            if (stat.isFile() && stat.size > 0) candidates.push({ source, size: stat.size, at: record.createdAt || 0 });
          } catch { /* Incomplete or unrelated jobs are not reusable. */ }
        }
        candidates.sort((a, b) => b.at - a.at);
        let found;
        for (const candidate of candidates) {
          try {
            const probe = await createMedia({ blenderPath }).probe(candidate.source);
            const input = JSON.parse(await fs.readFile(path.join(path.dirname(candidate.source), 'input.json'), 'utf8'));
            if (Math.abs(probe.duration - input.analysis.source.duration_seconds) > 0.5) continue;
            found = candidate; break;
          } catch { /* Partial uploads and invalid media cannot be restored. */ }
        }
        if (!found) return json(404, { error: '本机没有该项目的已保存原片' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': found.size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
        await pipeline(createReadStream(found.source), res);
        return;
      }
      if (url.pathname === '/health' && req.method === 'GET') return json(200, { ready: Boolean(blenderPath), blender: Boolean(blenderPath), version: 'automatic-previs.v2', planningCalls: 1, ...(runtime ? { environment: runtime.status(), setup: true } : {}) });
      const body = async () => {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('JSON 请求超过 16MB'); chunks.push(chunk); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      };
      if (url.pathname === '/jobs' && req.method === 'POST') {
        if (!allowedOrigins.includes(origin)) return json(403, { error: '创建任务需要项目页面来源' });
        if (!blenderPath) return json(409, { error: '未找到 Blender，请设置 BLENDER_PATH 后重启本地服务' });
        if ([...jobs.values()].some(j => ACTIVE.has(j.status))) return json(409, { error: '已有预演正在运行，请等待完成或取消，避免重复调用模型' });
        const input = await body();
        const connection = validateConnection(input.connection);
        if (!input.analysis?.beats?.length || !input.analysis?.source_roles) return json(400, { error: '请先完成完整 DNA 分析' });
        if ([...jobs.values()].some(j => ACTIVE.has(j.status))) return json(409, { error: '已有预演正在运行，请勿重复提交' });
        const id = randomUUID(), token = randomBytes(32).toString('hex');
        const job = { id, token, projectId: String(input.projectId || ''), status: 'uploading', message: '正在接收本地参考视频（不会再次发给模型）', createdAt: Date.now(), updatedAt: Date.now(), mode: 'two-call', modelCallLimit: 1, hasVideo: false, watchedEntireClip: false };
        jobs.set(id, job); secrets.set(id, connection);
        await fs.mkdir(path.join(directory, id));
        await saveJson(path.join(directory, id, 'input.json'), { analysis: input.analysis, mode: 'two-call', modelCallLimit: 1, model: connection.model, sourceName: String(input.sourceName || '') });
        await persist(job);
        const expiry = setTimeout(() => {
          if (job.status !== 'uploading') return;
          job.status = 'failed'; job.message = '10 分钟内未收到原视频，上传预留已释放；未调用模型。'; secrets.delete(id); void persist(job);
        }, 10 * 60 * 1000);
        expiry.unref();
        return json(201, { ...snapshot(job), token });
      }
      const match = new RegExp(`^/jobs/(${UUID})(?:/(source|cancel|video|report|recover|shots|shot-\\d+))?$`).exec(url.pathname);
      if (!match) return json(404, { error: '接口不存在' });
      const job = await readJob(match[1]);
      if (!job || !authenticate(req, url, job)) return json(404, { error: '任务不存在或访问令牌无效' });
      const action = match[2];
      if (action === 'shots' && req.method === 'GET') {
        const output = path.join(directory, job.id, 'output');
        if (!existsSync(path.join(output, 'manifest.json'))) return json(200, { shots: [] });
        const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
        const dna = JSON.parse(await fs.readFile(path.join(output, 'source-dna.json'), 'utf8'));
        return json(200, { shots: (manifest.segments || []).map(s => ({ index: s.index, beatId: dna.beats[s.shotIndex]?.beat_id, start: s.start, end: s.end, localChecksPassed: s.localChecksPassed, issues: s.issues || [] })) });
      }
      if (action === 'recover' && req.method === 'POST') {
        if (!allowedOrigins.includes(origin)) return json(403, { error: '恢复任务需要项目页面来源' });
        if (!blenderPath) return json(409, { error: '未找到 Blender' });
        if ([...jobs.values()].some(j => ACTIVE.has(j.status))) return json(409, { error: '已有预演正在运行，请等待完成' });
        if (!['failed', 'interrupted', 'canceled'].includes(job.status)) return json(409, { error: '当前任务不需要恢复' });
        if (!existsSync(path.join(directory, job.id, 'output', 'planning-response.json'))) return json(409, { error: '没有已保存的模型结果，无法免调用恢复' });
        Object.assign(job, { status: 'queued', message: '使用已保存结果恢复，不重新调用模型', updatedAt: Date.now() });
        await persist(job);
        json(202, snapshot(job));
        void start(job, true).catch(() => {});
        return;
      }
      if (!action && req.method === 'GET') return json(200, snapshot(job));
      if (action === 'source' && req.method === 'PUT') {
        if (job.status !== 'uploading' || !secrets.has(job.id)) return json(409, { error: '任务已提交或本地服务已重启，请勿重复上传' });
        job.status = 'queued'; await persist(job);
        let size = 0;
        const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > 512 * 1024 * 1024 ? new Error('源视频超过当前 512MB 上限') : null, chunk); } });
        try {
          await pipeline(req, limit, createWriteStream(path.join(directory, job.id, 'source'), { flags: 'wx' }));
          if (!size) throw new Error('源视频为空');
        } catch (error) {
          job.status = 'failed'; job.message = error.message; secrets.delete(job.id); await persist(job); throw error;
        }
        json(202, snapshot(job));
        void start(job).catch(() => { /* State and result files are the recovery evidence. */ });
        return;
      }
      if (action === 'cancel' && req.method === 'POST') {
        controllers.get(job.id)?.abort();
        if (job.status === 'uploading' || (job.status === 'queued' && !controllers.has(job.id))) { job.status = 'canceled'; job.message = '已取消上传'; secrets.delete(job.id); await persist(job); }
        return json(200, snapshot(job));
      }
      if ((action === 'video' || action === 'report' || action?.startsWith('shot-')) && req.method === 'GET') {
        const shotIndex = action.startsWith('shot-') ? Number(action.slice(5)) : null;
        if (shotIndex !== null && (!Number.isSafeInteger(shotIndex) || shotIndex < 0 || shotIndex > 9999)) return json(404, { error: '镜头不存在' });
        let file = path.join(directory, job.id, 'output', shotIndex !== null ? `segment-${String(shotIndex + 1).padStart(3, '0')}/preview.mp4` : action === 'video' ? 'preview.mp4' : 'manifest.json');
        if (!existsSync(file)) return json(404, { error: '产物尚未生成' });
        if (shotIndex !== null && (url.searchParams.has('from') || url.searchParams.has('to'))) {
          const manifest = JSON.parse(await fs.readFile(path.join(directory, job.id, 'output', 'manifest.json'), 'utf8'));
          const segment = manifest.segments?.find(s => s.index === shotIndex);
          const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
          const total = segment?.end - segment?.start;
          if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(total) || from < 0 || to <= from + 0.5 || to > total + 0.01) return json(400, { error: '分镜裁切时间超出范围' });
          const fromMs = Math.round(from * 1000), toMs = Math.round(to * 1000);
          const cuts = path.join(directory, job.id, 'output', 'cuts');
          await fs.mkdir(cuts, { recursive: true });
          const clip = path.join(cuts, `shot-${shotIndex + 1}-${fromMs}-${toMs}.mp4`);
          if (!existsSync(clip)) {
            if (!cutJobs.has(clip)) cutJobs.set(clip, (async () => {
              const temporary = `${clip}.${randomUUID()}.tmp`;
              try {
                await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-ss', String(fromMs / 1000), '-i', file, '-t', String((toMs - fromMs) / 1000), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-movflags', '+faststart', '-f', 'mp4', '-y', temporary], { windowsHide: true, timeout: 120000 });
                await fs.rename(temporary, clip);
              } finally { await fs.rm(temporary, { force: true }).catch(() => {}); cutJobs.delete(clip); }
            })());
            await cutJobs.get(clip);
          }
          file = clip;
        }
        const stat = await fs.stat(file);
        const headers = { 'Content-Type': action !== 'report' ? 'video/mp4' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', ...(url.searchParams.get('download') === '1' && action !== 'report' ? { 'Content-Disposition': `attachment; filename="${shotIndex !== null ? `shot-${shotIndex + 1}` : 'preview'}.mp4"` } : {}), ...(allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) };
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        let start = 0, end = stat.size - 1;
        if (range) {
          start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
          if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
          headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        }
        res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
        await pipeline(createReadStream(file, { start, end }), res).catch(() => {}); return;
      }
      return json(405, { error: '请求方式不允许' });
    } catch (error) {
      if (!res.headersSent) json(400, { error: String(error.message || error).slice(0, 1000) });
    }
  });
  server.on('close', () => { for (const c of controllers.values()) c.abort(); secrets.clear(); });
  return server;
}

if (path.basename(fileURLToPath(import.meta.url)) === 'server.mjs' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = createRenderRuntime({ directory: path.join(ROOT, '.worker', 'render-runtime'), candidates: [await findBlender()] });
  const server = await createPrevisServer({ runtime });
  const port = Number(process.env.PREVIS_PORT || 43128);
  server.listen(port, '127.0.0.1', () => console.log(`[自动预演] http://127.0.0.1:${port}`));
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { server.close(); server.closeAllConnections(); });
}
