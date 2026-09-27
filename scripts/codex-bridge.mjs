import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 43127;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JOB_DIR = join(ROOT, 'data', 'codex-jobs');
const ALLOWED_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const jobs = new Map();

function codexExecutable() {
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const desktopBin = join(localAppData, 'OpenAI', 'Codex', 'bin');
  const desktopCandidates = existsSync(desktopBin)
    ? readdirSync(desktopBin, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(desktopBin, entry.name, 'codex.exe'))
        .filter((candidate) => existsSync(candidate))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  const candidates = [
    ...desktopCandidates,
    join(appData, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'codex';
}

function send(response, status, body, origin = '') {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  response.end(JSON.stringify(body));
}

function persistJob(job) {
  mkdirSync(JOB_DIR, { recursive: true });
  writeFileSync(join(JOB_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
}

function loadJob(id) {
  const jobPath = join(JOB_DIR, `${id}.json`);
  if (!existsSync(jobPath)) return null;
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const resultDir = join(JOB_DIR, id);
  if (job.status === 'running' && job.kind === 'story' && existsSync(join(resultDir, 'story-draft.json')) && !jobs.has(id)) {
    try { JSON.parse(readFileSync(join(resultDir, 'story-draft.json'), 'utf8')); job.status = 'completed'; job.message = '新故事文件已恢复，请在页面校验。'; }
    catch { job.status = 'failed'; job.message = '故事文件不完整，请重新设计。'; }
    persistJob(job);
  } else if (job.status === 'running' && job.kind === 'single-image' && job.targetCandidateId && existsSync(join(resultDir, `${job.targetCandidateId}.png`))) {
    job.status = 'completed';
    job.message = '单张角色参考图已生成，正在写回页面…';
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  } else if (job.status === 'running' && existsSync(join(resultDir, 'character-proposals.json'))) {
    const pngCount = existsSync(resultDir) ? readdirSync(resultDir).filter((name) => /^[A-Z0-9_]+\.png$/i.test(name)).length : 0;
    const proposals = JSON.parse(readFileSync(join(resultDir, 'character-proposals.json'), 'utf8'));
    const expectedCount = job.expectedCount || proposals.role_sets?.reduce((total, roleSet) => total + (roleSet.candidates?.length || 0), 0) || 0;
    if (expectedCount > 0 && pngCount === expectedCount) {
      job.status = 'completed';
      job.message = `Codex 已生成 ${pngCount} 张参考图，正在把现有结果恢复到页面…`;
      job.finishedAt = new Date().toISOString();
      persistJob(job);
    }
  } else if (job.status === 'running' && !jobs.has(id)) {
    job.status = 'failed';
    job.message = '本地桥曾重启或任务进程已中断，且没有生成可恢复文件。请重新生成。';
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  }
  jobs.set(id, job);
  return job;
}

function jobSnapshot(job) {
  const resultDir = join(JOB_DIR, job.id);
  const completedImages = existsSync(resultDir) ? readdirSync(resultDir).filter((name) => /^[A-Z0-9_]+\.png$/i.test(name)).sort() : [];
  let expectedCount = job.expectedCount || 0;
  const proposalsPath = join(resultDir, 'character-proposals.json');
  if (!expectedCount && existsSync(proposalsPath)) {
    try {
      const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));
      expectedCount = proposals.role_sets?.reduce((total, roleSet) => total + (roleSet.candidates?.length || 0), 0) || 0;
    } catch {}
  }
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    expectedCount,
    completedImages,
    progress: job.status === 'completed' ? 100 : expectedCount > 0 ? Math.round((completedImages.length / expectedCount) * 100) : 0,
    kind: job.kind || 'full-design',
    targetCandidateId: job.targetCandidateId || undefined,
  };
}

function startJob(projectId, task, expectedCount, kind = 'full-design', targetCandidateId = '') {
  const activeJob = [...jobs.values()].find((job) => job.projectId === projectId && job.status === 'running');
  if (activeJob) {
    if (activeJob.kind !== kind) throw new Error('此项目还有另一类任务在运行，请等它结束后再启动。');
    return activeJob;
  }
  const id = randomUUID();
  const resultDir = join(JOB_DIR, id);
  mkdirSync(JOB_DIR, { recursive: true });
  mkdirSync(resultDir, { recursive: true });
  const taskPath = join(JOB_DIR, `${id}-task.txt`);
  writeFileSync(taskPath, task, 'utf8');
  const job = {
    id,
    projectId,
    status: 'running',
    message: kind === 'story' ? '本地 GPT 已启动，正在设计同类型新故事…' : '本地 Codex 已启动，正在设计角色并生成参考图…',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    expectedCount,
    kind,
    targetCandidateId,
    output: '',
  };
  jobs.set(id, job);
  persistJob(job);

  const prompt = kind === 'story'
    ? `这是本地后台单代理编剧任务，禁止调用子代理。读取 ${taskPath}，只设计新故事与分镜，不生图、不调用 Gemini、不修改源码、不调用 localhost API。将完整 creative-draft.v1 JSON 写到 ${join(resultDir, 'story-draft.json')}。完成前自行检查 JSON 格式、角色ID和时间轴。只有文件实际写入才算完成。`
    : kind === 'single-image'
    ? `这是一个本地后台单代理任务。禁止创建、委派或调用任何子代理/协作代理。读取任务文件 ${taskPath} 并完整执行。不要修改项目源码，也不要调用 localhost API。只生成任务指定的这一张角色参考图，并把最终 PNG 写到 ${join(resultDir, `${targetCandidateId}.png`)}。不要生成 character-proposals.json，不要更改 candidate_id，不要只返回提示词。文件真实存在后才算完成。`
    : `这是一个本地后台单代理任务。禁止创建、委派或调用任何子代理/协作代理，必须由你按顺序独立完成。读取任务文件 ${taskPath} 并完整执行。不要修改项目源码，也不要调用 localhost API。先完成全部角色方案并立即把完整 character-proposals.v1 JSON 写到 ${join(resultDir, 'character-proposals.json')}，然后严格按照 JSON 中的候选顺序逐张生成图片；每完成一张就立刻把 PNG 写到 ${resultDir}，文件名必须严格等于 candidate_id 加 .png，不要等全部生成后再统一保存。不要只在回复里打印 JSON、diff、补丁或提示词。仅当 JSON 和全部候选 PNG 已真实存在于该目录后才算完成。最后用一句中文总结写入了多少张图。`;
  const child = spawn(codexExecutable(), [
    '-a', 'never',
    '-s', 'workspace-write',
    '-C', ROOT,
    'exec', '--ephemeral', '--ignore-rules',
    prompt,
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let reconnectTimer = null;
  const taskTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    job.status = 'failed';
    job.message = '本地 Codex 运行超过 45 分钟，已停止本次任务；已生成的中间结果仍保留。';
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  }, 45 * 60 * 1000);

  const failAfterReconnects = () => {
    if (settled || reconnectTimer) return;
    job.message = 'Codex 连接已连续中断 5 次，正在结束本次任务；已生成的内容不会丢失。';
    persistJob(job);
    reconnectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      job.status = 'failed';
      job.message = 'Codex 网络连接中断，任务已停止。请直接重试，已生成的角色方案仍保留。';
      job.finishedAt = new Date().toISOString();
      persistJob(job);
    }, 5000);
  };

  const append = (chunk) => {
    job.output = `${job.output}${chunk.toString('utf8')}`.slice(-24000);
    const lines = job.output.trim().split(/\r?\n/).filter(Boolean);
    const latest = lines.findLast((line) => !/^(warning:|\d{4}-\d{2}-\d{2}.*ERROR codex_models_manager)/i.test(line));
    if (latest) job.message = latest.slice(0, 240);
    if (/Reconnecting\.\.\.\s*5\/5/i.test(job.output)) failAfterReconnects();
    persistJob(job);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(taskTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    job.status = 'failed';
    job.message = `无法启动本地 Codex：${error.message}`;
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  });
  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(taskTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (kind === 'story') {
      let valid = false;
      try { valid = JSON.parse(readFileSync(join(resultDir, 'story-draft.json'), 'utf8')).schema_version === 'creative-draft.v1'; } catch {}
      job.status = code === 0 && valid ? 'completed' : 'failed';
      job.message = valid ? '新故事已写入，正在返回页面校验。' : `新故事未完成（退出码 ${code ?? '未知'}），旧故事和图片保留。`;
      job.finishedAt = new Date().toISOString();
      persistJob(job);
      return;
    }
    if (kind === 'single-image') {
      const hasImage = existsSync(join(resultDir, `${targetCandidateId}.png`));
      job.status = code === 0 && hasImage ? 'completed' : 'failed';
      job.message = job.status === 'completed' ? '单张角色参考图已生成，正在刷新页面…' : `单张角色参考图生成失败（退出码 ${code ?? '未知'}）`;
      job.finishedAt = new Date().toISOString();
      persistJob(job);
      return;
    }
    let imageCount = 0;
    let expectedCount = 0;
    const proposalsPath = join(resultDir, 'character-proposals.json');
    if (existsSync(proposalsPath)) {
      try {
        const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));
        expectedCount = proposals.role_sets?.reduce((total, roleSet) => total + (roleSet.candidates?.length || 0), 0) || 0;
        imageCount = readdirSync(resultDir).filter((name) => /^[A-Z0-9_]+\.png$/i.test(name)).length;
      } catch {}
    }
    const hasCompleteResult = expectedCount > 0 && imageCount === expectedCount;
    job.status = code === 0 && hasCompleteResult ? 'completed' : 'failed';
    job.message = job.status === 'completed'
      ? `角色方案和 ${imageCount} 张参考图已生成，正在刷新本地项目…`
      : code === 0
        ? `Codex 已结束，但结果不完整：需要 ${expectedCount || '有效方案中的'} 张图，实际 ${imageCount} 张。请重试。`
        : `本地 Codex 任务失败（退出码 ${code ?? '未知'}）`;
    job.finishedAt = new Date().toISOString();
    persistJob(job);
  });
  return job;
}

createServer((request, response) => {
  const origin = request.headers.origin || '';
  if (request.method === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return send(response, 403, { error: '来源无效。' });
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    return response.end();
  }
  if (request.url === '/health' && request.method === 'GET') return send(response, 200, { ready: true }, origin);
  if (!ALLOWED_ORIGINS.has(origin)) return send(response, 403, { error: '只接受本地工作台请求。' });
  const latestMatch = request.url?.match(/^\/projects\/([0-9a-f-]+)\/(latest-result|latest-story)$/i);
  if (latestMatch && request.method === 'GET') {
    mkdirSync(JOB_DIR, { recursive: true });
    const latest = readdirSync(JOB_DIR)
      .filter((name) => /^[0-9a-f-]+\.json$/i.test(name))
      .map((name) => jobs.get(name.slice(0, -5)) || loadJob(name.slice(0, -5)))
      .filter((job) => job?.projectId === latestMatch[1] && (latestMatch[2] === 'latest-story' ? job.kind === 'story' : !job.kind || job.kind === 'full-design'))
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
    if (!latest) return send(response, 404, { error: '没有找到这个项目的本地 Codex 结果。' }, origin);
    if (!existsSync(join(JOB_DIR, latest.id, latestMatch[2] === 'latest-story' ? 'story-draft.json' : 'character-proposals.json'))) return send(response, 409, { error: latest.message || '最近一次任务没有生成可恢复文件。' }, origin);
    return send(response, 200, { job: jobSnapshot(latest) }, origin);
  }
  if (request.url === '/jobs' && request.method === 'POST') {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) request.destroy();
    });
    request.on('end', () => {
      try {
        const input = JSON.parse(raw);
        if (typeof input.projectId !== 'string' || !/^[0-9a-f-]{20,}$/i.test(input.projectId) || typeof input.task !== 'string' || input.task.length < 100 || !Number.isInteger(input.expectedCount) || input.expectedCount < 1) {
          return send(response, 400, { error: 'Codex 任务数据不完整。' }, origin);
        }
        const kind = input.kind === 'story' ? 'story' : input.kind === 'single-image' ? 'single-image' : 'full-design';
        const targetCandidateId = kind === 'single-image' && typeof input.targetCandidateId === 'string' && /^[A-Z0-9_]+$/i.test(input.targetCandidateId) ? input.targetCandidateId : '';
        if (kind === 'single-image' && !targetCandidateId) return send(response, 400, { error: '单图任务缺少候选角色 ID。' }, origin);
        const job = startJob(input.projectId, input.task, input.expectedCount, kind, targetCandidateId);
        return send(response, 202, { job: jobSnapshot(job) }, origin);
      } catch (error) {
        return send(response, 400, { error: error instanceof Error ? error.message : String(error) }, origin);
      }
    });
    return;
  }
  const match = request.url?.match(/^\/jobs\/([0-9a-f-]+)$/i);
  if (match && request.method === 'GET') {
    const job = jobs.get(match[1]) || loadJob(match[1]);
    if (!job) return send(response, 404, { error: '任务不存在或本地桥已重启。' }, origin);
    return send(response, 200, { job: jobSnapshot(job) }, origin);
  }
  const resultMatch = request.url?.match(/^\/jobs\/([0-9a-f-]+)\/result$/i);
  if (resultMatch && request.method === 'GET') {
    const resultDir = join(JOB_DIR, resultMatch[1]);
    const job = jobs.get(resultMatch[1]) || loadJob(resultMatch[1]);
    if (job?.kind === 'story') {
      try { return send(response, 200, { draft: JSON.parse(readFileSync(join(resultDir, 'story-draft.json'), 'utf8')) }, origin); }
      catch { return send(response, 409, { error: '新故事文件尚未写完或格式不完整。' }, origin); }
    }
    if (job?.kind === 'single-image') {
      const images = readdirSync(resultDir).filter((name) => /^[A-Z0-9_]+\.png$/i.test(name));
      return send(response, 200, { images, targetCandidateId: job.targetCandidateId }, origin);
    }
    const proposalsPath = join(resultDir, 'character-proposals.json');
    if (!existsSync(proposalsPath)) return send(response, 404, { error: '尚未找到可恢复的角色方案。' }, origin);
    const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));
    const images = readdirSync(resultDir).filter((name) => /^[A-Z0-9_]+\.png$/i.test(name));
    return send(response, 200, { proposals, images }, origin);
  }
  const fileMatch = request.url?.match(/^\/jobs\/([0-9a-f-]+)\/files\/([A-Z0-9_]+\.png)$/i);
  if (fileMatch && request.method === 'GET') {
    const filePath = join(JOB_DIR, fileMatch[1], fileMatch[2]);
    if (!existsSync(filePath)) return send(response, 404, { error: '图片不存在。' }, origin);
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    });
    return response.end(readFileSync(filePath));
  }
  return send(response, 404, { error: 'Not found' }, origin);
}).listen(PORT, HOST, () => {
  process.stdout.write(`Codex local bridge ready at http://${HOST}:${PORT}\n`);
});
