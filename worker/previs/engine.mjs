import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { makeBlenderExec } from '../blender-exec.mjs';
import { requirementsFor, validateInput, parsePlanningResponse } from './contract.mjs';
import { batchPlanningPrompt, expandBatchPlan, normalizeLibrary } from './batch.mjs';
import { LIBRARY_SCHEMA, LIBRARY_VERSION, SHOT_SCHEMA, expandShotPlan, libraryPlanningPrompt, shotPlanningPrompt } from './shot.mjs';
import { normalizeMinuteSecondTimeline } from '../../app/lib/timeline-normalization.mjs';

const exec = promisify(execFile);
const renderer = path.join(import.meta.dirname, 'render.py');
export const saveJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');

export function segmentsFor(analysis, maxSeconds = 12) {
  const segments = [];
  for (const [shotIndex, beat] of analysis.beats.entries()) {
    const count = Math.ceil((beat.end_seconds - beat.start_seconds) / maxSeconds);
    for (let i = 0; i < count; i++) {
      const start = +(beat.start_seconds + i * (beat.end_seconds - beat.start_seconds) / count).toFixed(6);
      const end = +(beat.start_seconds + (i + 1) * (beat.end_seconds - beat.start_seconds) / count).toFixed(6);
      segments.push({ shotIndex, part: i, beat, start, end, requirements: requirementsFor(beat, start, end) });
    }
  }
  return segments;
}

export function endState(plan) {
  return {
    actors: plan.actors.map(a => ({ ...a, keys: [a.keys.at(-1)] })),
    props: plan.props.map(p => ({ ...p, keys: [p.keys.at(-1)] })),
    camera: plan.camera.at(-1),
  };
}

export function createMedia({ blenderPath, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe', signal, width, height }) {
  const run = (bin, args) => exec(bin, args, { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  return {
    async probe(file) {
      const { stdout } = await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
      const info = JSON.parse(stdout), video = info.streams?.find(s => s.codec_type === 'video');
      if (!video) throw new Error('文件中没有可解码视频');
      return { duration: Number(info.format.duration), width: video.width, height: video.height };
    },
    async cut(source, start, end, output) {
      await run(ffmpeg, ['-v', 'error', '-i', source, '-ss', String(start), '-t', String(end - start), '-map', '0:v:0', '-an', '-vf', 'scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-y', output]);
    },
    async render(plan, directory, frameCount) {
      await fs.mkdir(directory, { recursive: true });
      await saveJson(path.join(directory, 'plan.json'), plan);
      await fs.copyFile(renderer, path.join(directory, 'render.py'));
      const result = await makeBlenderExec({ signal })(blenderPath, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(directory, 'render.py'), '--', path.join(directory, 'plan.json'), directory, '24', String(width), String(height), String(frameCount)], directory);
      await fs.writeFile(path.join(directory, 'render.log'), result.stdout + result.stderr);
      signal?.throwIfAborted();
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8').catch(() => { throw new Error(`Blender 未完成：${result.stderr.slice(-700) || result.stdout.slice(-700)}`); }));
      const files = (await fs.readdir(path.join(directory, 'frames'))).filter(f => /^f_\d+\.png$/.test(f)).sort();
      if (files.length !== frameCount || files.some((f, i) => f !== `f_${String(i + 1).padStart(4, '0')}.png`)) throw new Error('渲染帧序列不完整');
      const video = path.join(directory, 'preview.mp4');
      await run(ffmpeg, ['-v', 'error', '-framerate', '24', '-i', path.join(directory, 'frames', 'f_%04d.png'), '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', video]);
      await run(ffmpeg, ['-v', 'error', '-i', video, '-f', 'null', '-']);
      return { video, motionCheck: manifest };
    },
    async concat(videos, directory) {
      // Paths are relative and generated internally, not shell or user input.
      await fs.writeFile(path.join(directory, 'concat.txt'), videos.map(v => `file '${path.relative(directory, v).replaceAll('\\', '/')}'`).join('\n'));
      const video = path.join(directory, 'preview.mp4');
      await run(ffmpeg, ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(directory, 'concat.txt'), '-c', 'copy', '-movflags', '+faststart', '-y', video]);
      await run(ffmpeg, ['-v', 'error', '-i', video, '-f', 'null', '-']);
      return video;
    },
  };
}

const fileExists = async file => { try { await fs.access(file); return true; } catch { return false; } };

/**
 * 读一份落盘的模型返回，拿到可用数据就返回，拿不到返回 undefined（交给调用方决定要不要重调）。
 * 截断的结果一律不复用：缺的内容补不回来，硬用只会渲出半截动作。
 */
async function reusableResponse(file) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; }
  if (saved.data) return saved.data;
  if (/MAX_TOKENS|截断|长度上限/.test(saved.parseError || '')) return undefined;
  try { return parsePlanningResponse(saved.raw).data; } catch { return undefined; }
}

/**
 * 按镜编排：先一次定共享库，再每镜一次。
 *
 * 每次返回都落盘，下次进来先复用——所以失败后重试是「从坏掉那镜继续」，
 * 前面已经拿到的不重复计费。任何一镜失败都不自动重调：花钱的动作必须由用户点。
 */
async function planPerShot({ analysis, segments, directory, model, signal, allowModelCalls, onProgress, manifest }) {
  const obtain = async ({ file, prompt, schema, label }) => {
    const reused = await reusableResponse(file);
    if (reused) { manifest.reusedModelCalls += 1; return reused; }
    if (!allowModelCalls) throw new Error(`${label}没有可复用的已保存结果，无法免调用完成`);
    // 网络层的错（524、超时、连接断）也要带上标签，否则界面只说「全片编排失败」，
    // 看不出是共享库那一次还是第几镜死的。
    let result;
    try { result = await model({ prompt, videos: [], schema, signal }); }
    catch (cause) { throw new Error(`${label}：${cause.message}`); }
    await saveJson(file, result);
    manifest.newModelCalls += 1;
    // 中转不吃 responseSchema 时会退回无约束模式；这不是失败，但用户有权知道这一次少了一层保护。
    if (result.schemaRejected && !manifest.schemaRejected) manifest.schemaRejected = true;
    if (result.parseError) throw new Error(`${label}：${result.parseError}`);
    if (!result.data) throw new Error(`${label}：模型没有返回可用内容`);
    return result.data;
  };

  await onProgress({ stage: 'planning', total: segments.length, message: allowModelCalls ? '第 1 步：编排全片共用的角色、道具与姿态' : '正在校验已保存的动作计划，不调用模型' });
  const libraryData = await obtain({ file: path.join(directory, 'library-response.json'), prompt: libraryPlanningPrompt(analysis, segments), schema: LIBRARY_SCHEMA, label: '共享库编排' });
  if (libraryData?.schema_version !== LIBRARY_VERSION) throw new Error(`共享库必须为 ${LIBRARY_VERSION}`);
  const library = normalizeLibrary(libraryData);

  const plans = [];
  let previousEnd;
  for (const index of segments.keys()) {
    signal?.throwIfAborted();
    await onProgress({ stage: 'planning', index, total: segments.length, message: `第 ${index + 1}/${segments.length} 镜：编排动作` });
    try {
      const data = await obtain({
        file: path.join(directory, `shot-${String(index + 1).padStart(3, '0')}-response.json`),
        prompt: shotPlanningPrompt(analysis, segments, index, library, previousEnd),
        schema: SHOT_SCHEMA, label: `第 ${index + 1} 镜编排`,
      });
      const plan = expandShotPlan(data, library, segments, index);
      plans.push(plan);
      previousEnd = endState(plan);
    } catch (error) {
      throw new Error(`${error.message}。前 ${index} 镜已保存，重试会从第 ${index + 1} 镜继续，不重复计费`);
    }
  }
  return plans;
}

export async function runAutomaticPrevis({ analysis, source, directory, model, media, signal, recoverSavedResponse = false, onProgress = async () => {} }) {
  await fs.mkdir(directory, { recursive: true });
  const sourceProbe = await media.probe(source);
  analysis = normalizeMinuteSecondTimeline(analysis, sourceProbe.duration);
  validateInput(analysis, sourceProbe.duration);
  signal?.throwIfAborted();
  await saveJson(path.join(directory, 'source-dna.json'), analysis);
  const segments = segmentsFor(analysis, 600);
  // 老任务（整片一次编排）盘上有 planning-response.json，仍按老路恢复，不让已经付过的钱作废。
  const legacyBatch = await fileExists(path.join(directory, 'planning-response.json'));
  const manifest = { version: 'automatic-previs.v2', mode: legacyBatch ? 'two-call' : 'per-shot', status: 'planning', sourceProbe, dnaHash: createHash('sha256').update(JSON.stringify(analysis)).digest('hex'), sourceHash: createHash('sha256').update(await fs.readFile(source)).digest('hex'), modelCalls: 0, newModelCalls: 0, reusedModelCalls: 0, plannedModelCalls: legacyBatch ? 1 : segments.length + 1, segments: [], modelComparisonPerformed: false, modelComparisonPassed: false, watchedEntireClip: false };
  manifest.recoveredFromSavedResponse = recoverSavedResponse;
  await fs.writeFile(path.join(directory, 'planning-prompt.txt'), legacyBatch ? batchPlanningPrompt(analysis, segments) : libraryPlanningPrompt(analysis, segments));
  await saveJson(path.join(directory, 'manifest.json'), manifest);
  let plans;
  try {
    if (legacyBatch) {
      await onProgress({ stage: 'planning', total: segments.length, message: recoverSavedResponse ? '正在校验已保存的动作计划，不调用模型' : '仅用 DNA 一次编排全片，不再上传视频' });
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'planning-response.json'), 'utf8'));
      if (/MAX_TOKENS|截断|长度上限/.test(saved.parseError || '')) throw new Error('已保存结果被截断，不能恢复为完整计划');
      const result = saved.data ? saved : { ...saved, ...parsePlanningResponse(saved.raw), parseError: undefined };
      await saveJson(path.join(directory, 'planning-recovery.json'), result);
      manifest.reusedModelCalls = 1;
      if (result.parseError) throw new Error(result.parseError);
      plans = expandBatchPlan(result.data, segments);
    } else {
      plans = await planPerShot({ analysis, segments, directory, model, signal, allowModelCalls: !recoverSavedResponse, onProgress, manifest });
    }
    manifest.modelCalls = manifest.newModelCalls + manifest.reusedModelCalls;
    await saveJson(path.join(directory, 'validation.json'), { passed: true, segments: plans.length });
  } catch (error) {
    manifest.modelCalls = manifest.newModelCalls + manifest.reusedModelCalls;
    await saveJson(path.join(directory, 'validation.json'), { passed: false, issues: [error.message] });
    manifest.status = 'failed';
    await saveJson(path.join(directory, 'manifest.json'), manifest);
    throw new Error(`全片编排失败：${error.message}。已保留结果，未自动追加模型调用。`);
  }
  const selected = [];
  for (const [index, segment] of segments.entries()) {
    signal?.throwIfAborted();
    const segmentDir = path.join(directory, `segment-${String(index + 1).padStart(3, '0')}`);
    await onProgress({ stage: 'rendering', index, total: segments.length, message: `第 ${index + 1} 镜：Blender 本地渲染，不调用模型` });
    const rendered = await media.render(plans[index], segmentDir, Math.round(segment.end * 24) - Math.round(segment.start * 24));
    const issues = [];
    if (rendered.motionCheck.max_limb_length_change > .4) issues.push('肢体长度变化超过40%，需要检查动作计划');
    if (rendered.motionCheck.max_unreachable_target_m > .10) issues.push('手脚目标超出肢体可达范围，需要检查动作计划');
    selected.push(rendered.video);
    manifest.segments.push({ index, shotIndex: segment.shotIndex, start: segment.start, end: segment.end, passed: null, localChecksPassed: issues.length === 0, issues, motionCheck: rendered.motionCheck, video: path.relative(directory, rendered.video).replaceAll('\\', '/') });
    manifest.status = 'rendering';
    await saveJson(path.join(directory, 'manifest.json'), manifest);
  }
  signal?.throwIfAborted();
  await onProgress({ stage: 'merging', total: segments.length, message: '本地串联全片；未进行模型视频审核' });
  await media.concat(selected, directory);
  manifest.status = manifest.segments.every(s => s.localChecksPassed) ? 'rendered_unreviewed' : 'needs_review';
  manifest.video = 'preview.mp4';
  await saveJson(path.join(directory, 'manifest.json'), manifest);
  return manifest;
}
