import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { makeBlenderExec } from '../blender-exec.mjs';
import { requirementsFor, validateInput, parsePlanningResponse } from './contract.mjs';
import { batchPlanningPrompt, expandBatchPlan } from './batch.mjs';
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

export async function runAutomaticPrevis({ analysis, source, directory, model, media, signal, recoverSavedResponse = false, onProgress = async () => {} }) {
  await fs.mkdir(directory, { recursive: true });
  const sourceProbe = await media.probe(source);
  analysis = normalizeMinuteSecondTimeline(analysis, sourceProbe.duration);
  validateInput(analysis, sourceProbe.duration);
  signal?.throwIfAborted();
  await saveJson(path.join(directory, 'source-dna.json'), analysis);
  const segments = segmentsFor(analysis, 600);
  const manifest = { version: 'automatic-previs.v2', mode: 'two-call', status: 'planning', sourceProbe, dnaHash: createHash('sha256').update(JSON.stringify(analysis)).digest('hex'), sourceHash: createHash('sha256').update(await fs.readFile(source)).digest('hex'), modelCalls: 0, segments: [], modelComparisonPerformed: false, modelComparisonPassed: false, watchedEntireClip: false };
  const prompt = batchPlanningPrompt(analysis, segments);
  await fs.writeFile(path.join(directory, 'planning-prompt.txt'), prompt);
  await onProgress({ stage: 'planning', total: segments.length, message: recoverSavedResponse ? '正在校验已保存的动作计划，不调用模型' : '仅用 DNA 一次编排全片，不再上传视频' });
  manifest.recoveredFromSavedResponse = recoverSavedResponse;
  manifest.newModelCalls = recoverSavedResponse ? 0 : 1;
  manifest.modelCalls = 1;
  await saveJson(path.join(directory, 'manifest.json'), manifest);
  let plans;
  try {
    let result;
    if (recoverSavedResponse) {
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'planning-response.json'), 'utf8'));
      if (/MAX_TOKENS|截断|长度上限/.test(saved.parseError || '')) throw new Error('已保存结果被截断，不能恢复为完整计划');
      result = saved.data ? saved : { ...saved, ...parsePlanningResponse(saved.raw), parseError: undefined };
      await saveJson(path.join(directory, 'planning-recovery.json'), result);
    } else {
      result = await model({ prompt, videos: [], signal });
      await saveJson(path.join(directory, 'planning-response.json'), result);
    }
    if (result.parseError) throw new Error(result.parseError);
    plans = expandBatchPlan(result.data, segments);
    await saveJson(path.join(directory, 'validation.json'), { passed: true, segments: plans.length });
  } catch (error) {
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
