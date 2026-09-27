import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { build } from 'esbuild';
import { createRepo } from '../worker/repo.mjs';
import { applyReviewCorrections } from '../worker/blender-review-corrections.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const { positionals: [command], values: args } = parseArgs({ allowPositionals: true, options:
  Object.fromEntries(['shot', 'session', 'source', 'code', 'version', 'review', 'repo', 'db', 'blender', 'port', 'frame'].map((k) => [k, { type: 'string' }])) });
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2), 'utf8');
const digest = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const posix = (p) => p.replaceAll('\\', '/');
const pystr = (p) => JSON.stringify(posix(p));
const psstr = (p) => `'${p.replaceAll("'", "''")}'`;
const load = async (p) => {
  const result = await build({ entryPoints: [path.join(ROOT, p)], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const dbPath = () => args.db ?? process.env.WORKER_DB ?? fs.readdirSync(path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject'))
  .filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
  .map((f) => path.join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject', f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
function reader(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const repo = repoFor(db);
  return { db, repo };
}
const repoFor = (db) => createRepo({ prepare: (sql) => ({ bind: (...v) => ({ first: () => db.prepare(sql).get(...v) }) }) });
function fingerprint(dna) {
  const input = structuredClone(dna);
  delete input.complexity.previs;
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function versionDir(s) {
  const version = args.version ?? 'baseline';
  if (!/^[a-zA-Z0-9_-]+$/.test(version)) throw new Error('版本名只能包含字母、数字、下划线和横线');
  return path.join(s.directory, version);
}
async function call(s, tool, parameters) {
  const id = crypto.randomUUID();
  const request = path.join(s.directory, `request-${id}.json`);
  write(request, { port: s.port, tool, arguments: parameters, result: path.join(s.directory, `response-${id}.json`) });
  let result;
  try { result = await exec(s.python, [path.join(ROOT, 'worker/blender-mcp-client.py'), request], {
    cwd: ROOT, windowsHide: true, timeout: 210000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', BLENDER_MCP_DISABLE_TELEMETRY: '1' },
  }); } catch (error) {
    const response = path.join(s.directory, `response-${id}.json`);
    throw new Error(fs.existsSync(response) ? json(response).content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : error.stderr?.slice(-2000) || error.message);
  }
  console.log(result.stdout.trim());
}
async function runCode(s, code) {
  await call(s, 'execute_blender_code', { code, user_prompt: '按原片和 Gemini 分析检查并修正这一镜头的场景、动作与运镜，保留可回退版本。' });
}

if (command === 'prepare') {
  if (!args.shot || !args.repo) throw new Error('prepare 需要 --shot 和 --repo（已克隆的 mcp-for-blender 目录）');
  const file = path.resolve(dbPath());
  const { db, repo } = reader(file);
  const dna = await repo.getShotDna(args.shot);
  if (!dna) throw new Error('找不到镜头');
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(dna.project_id);
  db.close();
  const upstream = path.resolve(args.repo);
  const objectRoot = path.resolve(process.env.WORKER_OBJECTS ?? path.join(ROOT, '.worker/objects'));
  const directory = path.join(objectRoot, 'blender-review', dna.shot_id, crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const { buildScene } = await load('app/lib/blender/protocol.ts');
  const { generateBlenderPython } = await load('app/lib/blender/python.ts');
  const scene = buildScene(dna, { aspectRatio: project.aspect_ratio });
  write(path.join(directory, 'dna.json'), dna);
  write(path.join(directory, 'scene.json'), scene);
  fs.writeFileSync(path.join(directory, 'baseline.py'), generateBlenderPython(scene, { outputDir: posix(directory), buildOnly: true }));
  const session = { directory, objectRoot, db: file, shotId: dna.shot_id, projectId: dna.project_id,
    inputHash: fingerprint(dna), source: args.source ? path.resolve(args.source) : null,
    port: Number(args.port ?? 9877), addon: path.join(upstream, 'addon.py'),
    python: path.join(upstream, '.venv/Scripts/python.exe'),
    blender: args.blender ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe',
    ready: path.join(directory, 'ready.json'), fps: scene.fps, frames: Math.round(scene.durationSeconds * scene.fps),
    aspectRatio: project.aspect_ratio, status: 'prepared' };
  if (!Number.isInteger(session.port) || session.port < 1024 || session.port > 65535) throw new Error('端口无效');
  write(path.join(directory, 'session.json'), session);
  write(path.join(directory, 'diagnosis.json'), {
    summary: dna.summary, camera: dna.camera, actions: dna.action_timeline, expressions: dna.expression_timeline,
    limitations: ['模板未表达骨骼动作和面部表情', '道具默认方块', '运镜轨迹来自规则而非实测'],
    previousDownstreamDescription: dna.complexity.previs ?? null,
    sourceAvailable: Boolean(session.source && fs.existsSync(session.source)),
  });
  console.log(path.join(directory, 'session.json'));
} else if (command) {
  if (!args.session) throw new Error('需要 --session <session.json>');
  const s = json(args.session);
  if (command === 'start') {
    if (fs.existsSync(s.ready)) throw new Error('会话已启动过；使用新的会话或先核对原进程，避免重复启动');
    const startup = path.join(ROOT, 'worker/blender-mcp-start.py');
    // 上游插件依赖 GUI 事件循环；独立隐藏进程，不能使用 -b。
    const launchArgs = ['--factory-startup', '--python', startup, '--', path.resolve(args.session)];
    const ps = `$env:BLENDER_USER_CONFIG=${psstr(path.join(s.directory, 'config'))}; $p = Start-Process -FilePath ${psstr(s.blender)} -ArgumentList @(${launchArgs.map((x) => psstr('"' + x + '"')).join(',')}) -WindowStyle Hidden -PassThru -RedirectStandardOutput ${psstr(path.join(s.directory, 'blender.log'))} -RedirectStandardError ${psstr(path.join(s.directory, 'blender-error.log'))}`;
    fs.mkdirSync(path.join(s.directory, 'config'), { recursive: true });
    const log = fs.openSync(path.join(s.directory, 'launcher.log'), 'a');
    const launcher = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', log, log] });
    launcher.unref();
    fs.closeSync(log);
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(s.ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    if (!fs.existsSync(s.ready)) throw new Error(`Blender 未就绪，查看 ${s.directory}/blender-error.log`);
    await call(s, 'get_scene_info', { user_prompt: '验证独立 Blender 镜头检查会话连接。' });
  } else if (command === 'load') {
    const { generateBlenderPython } = await load('app/lib/blender/python.ts');
    const script = generateBlenderPython(json(path.join(s.directory, 'scene.json')), { outputDir: posix(s.directory), buildOnly: true });
    fs.writeFileSync(path.join(s.directory, 'baseline.py'), script);
    await runCode(s, script);
  } else if (command === 'inspect') {
    await call(s, 'get_scene_info', { user_prompt: '检查当前镜头场景。' });
  } else if (command === 'snapshot') {
    const frame = Number(args.frame ?? 1);
    if (!Number.isInteger(frame) || frame < 1 || frame > s.frames) throw new Error('帧号超出本镜范围');
    const out = path.join(s.directory, `snapshot-${frame}-${crypto.randomUUID()}.png`);
    await runCode(s, `import bpy\ns=bpy.context.scene\ns.frame_set(${frame})\ns.render.resolution_percentage=50\ns.render.image_settings.file_format='PNG'\ns.render.filepath=${pystr(out)}\nbpy.ops.render.render(write_still=True)`);
    console.log(out);
  } else if (command === 'apply') {
    if (!args.code) throw new Error('需要 --code <本地可信 Python 文件>');
    const code = fs.readFileSync(args.code, 'utf8');
    fs.copyFileSync(args.code, path.join(s.directory, `edit-${crypto.randomUUID()}.py`));
    await runCode(s, code);
  } else if (command === 'render') {
    const dir = versionDir(s);
    if (fs.existsSync(dir)) throw new Error('版本已存在，请用新 --version，避免覆盖已成功结果');
    fs.mkdirSync(dir, { recursive: true });
    const blend = path.join(dir, 'scene.blend');
    await runCode(s, `import bpy\nbpy.context.scene.frame_start=1\nbpy.context.scene.frame_end=${s.frames}\nbpy.context.scene.render.fps=${s.fps}\nbpy.ops.wm.save_as_mainfile(filepath=${pystr(blend)})`);
    fs.mkdirSync(path.join(dir, 'frames'));
    const script = path.join(dir, 'render.py');
    fs.writeFileSync(script, `import bpy,json\nfrom pathlib import Path\ns=bpy.context.scene\ns.render.resolution_percentage=50\ns.render.image_settings.file_format='PNG'\ns.render.filepath=${pystr(path.join(dir, 'frames/f_'))}\nbpy.ops.render.render(animation=True)\nPath(${pystr(path.join(dir, 'result.json'))}).write_text(json.dumps({'frames':s.frame_end,'fps':s.render.fps}))\n`);
    const { makeBlenderExec } = await import('../worker/blender-exec.mjs');
    // 独立离线渲染，不让 MCP socket 等待长任务。
    const rendering = makeBlenderExec();
    const result = await rendering(s.blender, ['-b', blend, '--python-exit-code', '1', '--python', script], dir);
    fs.writeFileSync(path.join(dir, 'render.log'), result.stdout + result.stderr);
    if (!fs.existsSync(path.join(dir, 'result.json'))) throw new Error('渲染未完成，旧版本保持有效');
    const frames = fs.readdirSync(path.join(dir, 'frames')).filter((f) => /^f_\d+\.png$/.test(f)).sort();
    if (frames.length !== s.frames || frames.some((f, i) => f !== `f_${String(i + 1).padStart(4, '0')}.png`)) throw new Error('渲染帧缺失或序号不连续');
    await exec('ffmpeg', ['-v', 'error', '-framerate', String(s.fps), '-i', path.join(dir, 'frames/f_%04d.png'), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'preview.mp4')], { windowsHide: true });
    const videoHash = digest(path.join(dir, 'preview.mp4'));
    write(path.join(dir, 'complete.json'), { frames: s.frames, fps: s.fps, inputHash: s.inputHash, videoHash });
    write(path.join(dir, 'review-template.json'), { version: path.basename(dir), videoHash,
      watchedEntireClip: false, comparedWithSource: false, issues: ['尚未完成原片对比和全片复看'], blocking: '', cameraPath: '' });
    console.log(path.join(dir, 'preview.mp4'));
  } else if (command === 'reference') {
    const source = args.source ? path.resolve(args.source) : s.source;
    if (!source || !fs.existsSync(source)) throw new Error('需要可访问的 --source 原视频路径');
    const dna = json(path.join(s.directory, 'dna.json'));
    const out = path.join(s.directory, 'reference.mp4');
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', source, '-ss', String(dna.start_time), '-t', String(dna.end_time - dna.start_time), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { windowsHide: true });
    s.source = source; write(args.session, s);
    console.log(out);
  } else if (command === 'publish') {
    if (!args.review) throw new Error('需要 --review，包含完整复看结果与该镜头空间描述');
    const dir = versionDir(s);
    const review = json(args.review);
    const complete = json(path.join(dir, 'complete.json'));
    if (review.videoHash !== complete.videoHash || digest(path.join(dir, 'preview.mp4')) !== complete.videoHash) throw new Error('复看记录与当前视频版本不匹配');
    if (review.version !== path.basename(dir) || review.watchedEntireClip !== true || review.comparedWithSource !== true || !Array.isArray(review.issues) || review.issues.length || !review.blocking || !review.cameraPath) throw new Error('复看未通过或描述缺失，不能进入下游');
    if (!fs.existsSync(path.join(s.directory, 'reference.mp4'))) throw new Error('缺少原片对比素材');
    const { db: check, repo } = reader(s.db);
    const dna = await repo.getShotDna(s.shotId); check.close();
    if (!dna || fingerprint(dna) !== s.inputHash || complete.inputHash !== s.inputHash) throw new Error('分析已变化，旧预演不能覆盖新分析');
    const corrected = applyReviewCorrections(dna, review);
    const { validateShotDna } = await load('app/lib/shot-dna/validate.ts');
    const errors = validateShotDna(corrected, dna.actors.map((a) => a.character_id)).filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(`执行数据未通过校验：${JSON.stringify(errors)}`);
    const key = posix(path.relative(s.objectRoot, path.join(dir, 'preview.mp4')));
    if (key.startsWith('../') || path.isAbsolute(key)) throw new Error('产物不在对象库内');
    const bytes = fs.statSync(path.join(dir, 'preview.mp4')).size;
    if (!bytes || bytes > 8 * 1024 * 1024) throw new Error('产物为空或超过下游 8MB 限制');
    const db = new DatabaseSync(s.db);
    db.exec('PRAGMA busy_timeout=8000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedDna = await repoFor(db).getShotDna(s.shotId);
      if (!lockedDna || fingerprint(lockedDna) !== s.inputHash) throw new Error('镜头已变化，请重新检查');
      const current = db.prepare('SELECT complexity_json,revision FROM shot_dna WHERE shot_id=?').get(s.shotId);
      if (current.revision !== dna.revision) throw new Error('镜头已变化，请重新检查');
      const complexity = JSON.parse(current.complexity_json);
      complexity.previs = { blocking: review.blocking, camera_path: review.cameraPath, rendered_at: Date.now(), reviewed_revision: current.revision + 1 };
      const assetId = crypto.randomUUID();
      db.prepare('INSERT INTO assets (id,project_id,kind,store,object_key,content_type,bytes,duration,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(assetId, s.projectId, 'blender_preview', 'local', key, 'video/mp4', bytes, s.frames / s.fps,
          JSON.stringify({ shotId: s.shotId, output: 'path_animation', mode: 'per_shot', review: true, version: path.basename(dir),
            evidence: review.evidence, originalInputHash: s.inputHash, source: s.source, videoHash: complete.videoHash }), Date.now());
      db.prepare('UPDATE shot_dna SET complexity_json=?,camera_json=?,actors_json=?,objects_json=?,environment_json=?,action_timeline=?,expression_timeline=?,summary=?,revision=revision+1,updated_at=? WHERE shot_id=?')
        .run(JSON.stringify(complexity), JSON.stringify(corrected.camera), JSON.stringify(corrected.actors), JSON.stringify(corrected.objects),
          JSON.stringify(corrected.environment), JSON.stringify(corrected.action_timeline), JSON.stringify(corrected.expression_timeline), corrected.summary, Date.now(), s.shotId);
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(Date.now(), s.projectId);
      db.exec('COMMIT');
      write(path.join(dir, 'review.json'), review);
      console.log(`已登记 ${assetId}；下一次该镜头出片会使用此版本，未发起付费生成。`);
    } catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  } else if (command === 'stop') {
    await runCode(s, 'import bpy\ndef stop_review():\n    bpy.ops.wm.quit_blender()\n    return None\nbpy.app.timers.register(stop_review, first_interval=1.0)');
    console.log('已请求关闭本次独立 Blender 会话');
  } else throw new Error(`未知命令 ${command}`);
} else {
  console.log('prepare --shot ID --repo PATH [--source VIDEO]; start/load/inspect/apply/render/reference/publish/stop --session FILE');
}
