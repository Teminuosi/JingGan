'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CreativeBeat, SeedanceRun, VideoDnaAnalysis } from '../lib/types';
import { MOMENT_KIND_LABELS } from '../lib/moments';
import { buildTimeline, type SegmentInput } from '../lib/post/timeline';
import { buildOverlays, captionBase, defaultCaptionLines, DEFAULT_TOGGLES, effectiveCaptionLines, momentOutputTime, momentSegments, type CaptionEdit, type PostToggles } from '../lib/post/package';
import { FRESHNESS_LABEL, isStale, segmentKeepSeconds, type SegmentFreshness } from '../lib/post/segments';
import { measureBlob, saveSegment, type SegmentRecord } from '../lib/post/segment-store';

/** 包装设置按项目记在本机浏览器里（每个人自己的偏好，不跟项目走）。 */
interface PostSettings {
  toggles: PostToggles;
  captions: Record<string, CaptionEdit>;
  /** 时刻手动修正：时刻 ID → 成片里第几秒。优先于自动换算。 */
  moments: Record<string, number>;
  pops: Record<string, string>;
  /** 每段手动"只保留前 N 秒"。 */
  trims: Record<string, number>;
  bgmGain: number;
}
const EMPTY: PostSettings = { toggles: DEFAULT_TOGGLES, captions: {}, moments: {}, pops: {}, trims: {}, bgmGain: 0.25 };
const settingsKey = (projectId: string) => `mirror:post-settings:${projectId}`;
function loadSettings(projectId: string): PostSettings {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey(projectId)) || '{}') as Partial<PostSettings>;
    return { ...EMPTY, ...saved, toggles: { ...DEFAULT_TOGGLES, ...saved.toggles } };
  } catch { return EMPTY; }
}

const timestamp = () => Date.now();
const fmt = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const chip = 'rounded-lg border border-white/12 px-2.5 py-1 text-[11px] text-white/60 transition hover:border-white/25 hover:text-white/85 disabled:opacity-30';

export function PostPanel({ projectId, title, runs, labels, beats, analysis, preserve, segments, freshness }: {
  projectId: string;
  title: string;
  runs: SeedanceRun[];
  labels: Record<string, string>;
  beats: CreativeBeat[];
  /** 保留原剧情时传入：关键时刻挂在原片镜头上，重写新故事时对不上，不传。 */
  analysis?: VideoDnaAnalysis;
  preserve: boolean;
  segments: Record<string, SegmentRecord>;
  freshness: Record<string, SegmentFreshness>;
}) {
  const [settings, setSettings] = useState<PostSettings>(() => loadSettings(projectId));
  const update = (patch: (old: PostSettings) => PostSettings) => setSettings(old => {
    const next = patch(old);
    try { localStorage.setItem(settingsKey(projectId), JSON.stringify(next)); } catch { /* 存不下本次仍然生效 */ }
    return next;
  });
  const [bgm, setBgm] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ value: number; stage: 'audio' | 'video' } | null>(null);
  const [result, setResult] = useState<{ url: string; extension: string; seconds: number; width: number; height: number; hasAudio: boolean; size: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef('');
  useEffect(() => () => { abortRef.current?.abort(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const missing = runs.filter(run => !segments[run.run_id]);
  // 缺段时用设计时长占位，只用来预览时刻和字幕落在哪；导出必须每段都在。
  const inputs: SegmentInput[] = runs.map(run => {
    const record = segments[run.run_id];
    if (!record) return { id: run.run_id, durationSeconds: Math.max(0.1, run.duration_seconds) };
    return { id: run.run_id, durationSeconds: record.durationSeconds, trimTo: segmentKeepSeconds(record, settings.trims[run.run_id]) };
  });
  const captionDefaults = useMemo(() => Object.fromEntries(runs.map(run => [run.run_id, defaultCaptionLines(run, beats)])), [runs, beats]);
  const captions = Object.fromEntries(runs.map(run => [run.run_id, effectiveCaptionLines(captionDefaults[run.run_id], settings.captions[run.run_id])]));
  const draft = buildTimeline(inputs, [], { fps: 30 });
  const mapped = momentSegments(runs, draft.segments);
  const moments = (preserve && analysis?.moments ? analysis.moments : []).map(moment => ({ moment, ...momentOutputTime(analysis!, moment, mapped, settings.moments) }));
  const overlays = buildOverlays({ toggles: settings.toggles, segments: draft.segments, captions, moments, popText: settings.pops });

  const addLocal = async (run: SeedanceRun, file: File | undefined) => {
    if (!file) return;
    setBusy(`file:${run.run_id}`); setError('');
    try {
      const durationSeconds = await measureBlob(file);
      await saveSegment(projectId, {
        runId: run.run_id, beatIds: run.beat_ids, sourceStart: run.source_start_seconds, sourceEnd: run.source_end_seconds, plannedSeconds: run.duration_seconds,
        requestHash: '', promptHash: '', model: '', padded: 0, origin: 'local', fileName: file.name, durationSeconds, createdAt: timestamp(),
      }, file);
    } catch (cause) { setError(`${labels[run.run_id] ?? run.run_id}：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setBusy(''); }
  };

  const exportFilm = async () => {
    if (missing.length || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy('export'); setError(''); setProgress({ value: 0, stage: 'audio' });
    try {
      const { composeFilm } = await import('../lib/post/compose');
      const timeline = buildTimeline(inputs, overlays, { fps: 30 });
      const out = await composeFilm({
        segments: runs.map(run => segments[run.run_id].blob),
        timeline,
        audio: bgm ? { blob: bgm, gain: settings.bgmGain } : undefined,
        signal: controller.signal,
        onProgress: (value, stage) => setProgress({ value, stage }),
      });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(out.blob);
      setResult({ url: urlRef.current, extension: out.extension, seconds: out.seconds, width: out.width, height: out.height, hasAudio: out.hasAudio, size: out.blob.size });
    } catch (cause) {
      setError(controller.signal.aborted ? '已取消导出。' : `导出失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      abortRef.current = null;
      setBusy(''); setProgress(null);
    }
  };

  const toggle = (key: keyof PostToggles, label: string, hint: string) => (
    <label className="flex items-start gap-2 text-xs text-white/75">
      <input type="checkbox" className="mt-0.5" checked={settings.toggles[key]} onChange={event => update(old => ({ ...old, toggles: { ...old.toggles, [key]: event.target.checked } }))} />
      <span><span className="font-medium text-white/85">{label}</span><span className="block text-[11px] leading-4 text-white/40">{hint}</span></span>
    </label>
  );

  return <section aria-label="成片包装" className="border-t border-white/8 px-4 py-5 sm:px-5">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-base font-semibold text-white/90">成片包装 · 拼接导出</h3>
      <span className="text-xs text-emerald-100/75">导出在你的浏览器里完成，不调用模型、不扣费。改字幕、特效、时刻只重算这一层。</span>
    </div>
    <p className="mt-1 text-[11px] leading-5 text-white/40">生成完成的段落会自动存到本机浏览器；链接过期或在别处生成的，可以用本机视频文件补上。没有音效；背景音乐只能用你自己上传、有权使用的文件，默认不加。</p>

    {/* 段落：顺序、有没有、实测时长、裁剪 */}
    <ol className="mt-4 grid gap-3">
      {runs.map((run, index) => {
        const record = segments[run.run_id];
        const placed = draft.segments[index];
        const keep = record ? segmentKeepSeconds(record, settings.trims[run.run_id]) : undefined;
        const state = freshness[run.run_id];
        const defaults = captionDefaults[run.run_id];
        const edit = settings.captions[run.run_id];
        const text = edit && edit.base === captionBase(defaults) ? edit.lines.join('\n') : defaults.map(line => line.text).join('\n');
        return <li key={run.run_id} className="rounded-xl border border-white/10 bg-black/20 p-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="font-medium text-white/85">{labels[run.run_id] ?? run.run_id}</span>
            <span className="font-mono text-[11px] text-white/40">{run.run_id}</span>
            {record
              ? <span className="rounded-md bg-emerald-300/15 px-2 py-0.5 text-[11px] text-emerald-100">{record.origin === 'local' ? `本机文件${record.fileName ? ` · ${record.fileName}` : ''}` : '已存到本机'}</span>
              : <span className="rounded-md bg-amber-300/15 px-2 py-0.5 text-[11px] text-amber-100">缺这一段</span>}
            {record && state && isStale(state) && <span className="rounded-md bg-amber-300/15 px-2 py-0.5 text-[11px] text-amber-100" title="旧视频仍可用于包装；重新生成要在上面手动点「提交生成」">{FRESHNESS_LABEL[state]}</span>}
            <span className="tabular-nums text-white/50">
              {record ? `实测 ${record.durationSeconds.toFixed(2)}s` : `设计 ${run.duration_seconds}s`}
              {placed && ` · 成片 ${fmt(placed.outputStart)}–${fmt(placed.outputEnd)}`}
            </span>
            <label className="ml-auto cursor-pointer">
              <span className={chip}>{busy === `file:${run.run_id}` ? '读取中…' : record ? '用本机文件替换' : '用本机文件补上'}</span>
              <input type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" disabled={busy !== ''} onChange={event => { void addLocal(run, event.target.files?.[0]); event.target.value = ''; }} />
            </label>
          </div>
          {record && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-white/50">
            <span>拼接时保留前</span>
            <input type="number" min={0.1} step={0.1} aria-label={`${run.run_id}保留秒数`} className="w-20 rounded-md border border-white/12 bg-[#07120f] px-2 py-1 text-white"
              value={settings.trims[run.run_id] ?? (keep ?? record.durationSeconds).toFixed(2)}
              onChange={event => { const value = Number(event.target.value); update(old => { const trims = { ...old.trims }; if (event.target.value === '' || !(value > 0)) delete trims[run.run_id]; else trims[run.run_id] = value; return { ...old, trims }; }); }} />
            <span>秒</span>
            {record.padded > 0.001 && settings.trims[run.run_id] === undefined && <span className="text-emerald-100/70">模型多交 {record.padded}s，拼接时裁掉，保留设计的 {run.duration_seconds}s</span>}
            {settings.trims[run.run_id] !== undefined && <button type="button" className="underline" onClick={() => update(old => { const trims = { ...old.trims }; delete trims[run.run_id]; return { ...old, trims }; })}>恢复自动</button>}
          </div>}
          {settings.toggles.captions && <label className="mt-2 block text-[11px] text-white/45">
            字幕（一行一句；默认取这一段实际用的台词{preserve ? '（翻译后的对白）' : '（新台词）'}）
            <textarea aria-label={`${run.run_id}字幕`} rows={Math.max(2, Math.min(5, text.split('\n').length))} value={text}
              placeholder="这一段没有台词。要加字幕就在这里写，一行一句。"
              onChange={event => update(old => ({ ...old, captions: { ...old.captions, [run.run_id]: { base: captionBase(defaults), lines: event.target.value.split('\n') } } }))}
              className="mt-1 w-full resize-y rounded-lg border border-white/12 bg-black/25 p-2.5 text-sm leading-6 text-white/85" />
            {edit && edit.base === captionBase(defaults) && <button type="button" className="mt-1 underline" onClick={() => update(old => { const next = { ...old.captions }; delete next[run.run_id]; return { ...old, captions: next }; })}>恢复默认字幕</button>}
          </label>}
        </li>;
      })}
    </ol>

    {/* 开关 */}
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      {toggle('captions', '字幕', '白字黑边，放在底部安全区上沿')}
      {toggle('flash', '闪白', '只在强度 3 的关键时刻白一下')}
      {toggle('pop', '弹字', '强度 ≥ 2 的时刻弹出一句短字，默认关')}
    </div>

    {/* 关键时刻 */}
    <div className="mt-5">
      <h4 className="text-sm font-medium text-white/80">关键时刻 · 成片里的时间</h4>
      {!preserve
        ? <p className="mt-1 text-[11px] leading-5 text-white/40">重写新故事时，原片的关键时刻对不上新剧情，不自动加闪白和弹字。字幕照常可用。</p>
        : moments.length === 0
          ? <p className="mt-1 text-[11px] leading-5 text-white/40">这次分析没有标出关键时刻（旧项目没有这一项）。字幕照常可用。</p>
          : <>
            <p className="mt-1 text-[11px] leading-5 text-white/40">按「时刻在原片这一镜的位置 × 新段落实际时长」推算；对不准就直接改秒数，手动值优先，存在本机。</p>
            <ol className="mt-2 grid gap-1.5">
              {moments.map(({ moment, seconds, manual }) => <li key={moment.id} className="flex flex-wrap items-center gap-2 text-xs text-white/70">
                <input type="number" min={0} step={0.1} aria-label={`${moment.id}成片秒数`} className={`w-20 rounded-md border bg-[#07120f] px-2 py-1 tabular-nums ${manual ? 'border-emerald-300/50 text-emerald-100' : 'border-white/12 text-white'}`}
                  value={seconds === undefined ? '' : manual ? settings.moments[moment.id] : seconds.toFixed(2)}
                  placeholder="对不上"
                  onChange={event => { const value = Number(event.target.value); update(old => { const next = { ...old.moments }; if (event.target.value === '' || !(value >= 0)) delete next[moment.id]; else next[moment.id] = value; return { ...old, moments: next }; }); }} />
                <span className="w-8 text-[11px] text-white/35">秒</span>
                <span className="w-10 text-[11px] text-amber-100/80">{MOMENT_KIND_LABELS[moment.kind] ?? moment.kind}</span>
                <span className="min-w-0 flex-1">{moment.label}<span className="ml-2 text-[11px] text-white/35">{moment.beat_id} · 强度 {moment.emphasis}{moment.emphasis === 3 && settings.toggles.flash ? ' · 闪白' : ''}{moment.emphasis >= 2 && settings.toggles.pop ? ' · 弹字' : ''}</span></span>
                {manual && <button type="button" className="text-[11px] underline text-white/50" onClick={() => update(old => { const next = { ...old.moments }; delete next[moment.id]; return { ...old, moments: next }; })}>恢复自动</button>}
                {settings.toggles.pop && moment.emphasis >= 2 && <input aria-label={`${moment.id}弹字`} className="w-full rounded-md border border-white/12 bg-[#07120f] px-2 py-1 text-white sm:ml-28" value={settings.pops[moment.id] ?? moment.label} onChange={event => update(old => ({ ...old, pops: { ...old.pops, [moment.id]: event.target.value } }))} />}
              </li>)}
            </ol>
          </>}
    </div>

    {/* 背景音乐：只能自己上传 */}
    <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-white/65">
      <span className="font-medium text-white/80">背景音乐</span>
      <label className="cursor-pointer"><span className={chip}>{bgm ? '换一首' : '上传音乐文件'}</span><input type="file" accept="audio/*" className="sr-only" onChange={event => { setBgm(event.target.files?.[0] ?? null); event.target.value = ''; }} /></label>
      {bgm ? <>
        <span className="text-white/55">{bgm.name}</span>
        <label className="flex items-center gap-2">音量<input type="range" min={0} max={1} step={0.05} value={settings.bgmGain} onChange={event => update(old => ({ ...old, bgmGain: Number(event.target.value) }))} /><span className="tabular-nums">{Math.round(settings.bgmGain * 100)}%</span></label>
        <button type="button" className="underline text-white/45" onClick={() => setBgm(null)}>不要音乐</button>
      </> : <span className="text-white/35">默认不加；生成的视频本身带原声。音乐文件只在这次打开页面期间有效，不存本机。</span>}
    </div>

    {/* 导出 */}
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button type="button" className="rounded-lg bg-emerald-300 px-4 py-2 text-sm font-semibold text-[#082018] transition hover:bg-emerald-200 disabled:bg-white/10 disabled:text-white/30"
        disabled={missing.length > 0 || busy !== '' || runs.length === 0} onClick={() => void exportFilm()}>{busy === 'export' ? '导出中…' : '导出整片'}</button>
      {busy === 'export' && <button type="button" className={chip} onClick={() => abortRef.current?.abort()}>取消</button>}
      <span className="text-xs tabular-nums text-white/50">{runs.length} 段 · 预计 {fmt(draft.duration)} · {overlays.length} 条包装</span>
    </div>
    {missing.length > 0 && <p className="mt-2 text-xs leading-5 text-amber-100">还缺 {missing.map(run => labels[run.run_id] ?? run.run_id).join('、')}。每一段都齐了才能导出整片：先在上面生成，或用本机视频文件补上。</p>}
    {progress && <div className="mt-3">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-emerald-300 transition-all" style={{ width: `${Math.round(progress.value * 100)}%` }} /></div>
      <p className="mt-1 text-[11px] text-white/45">{progress.stage === 'audio' ? '混音中' : '逐帧合成中'} {Math.round(progress.value * 100)}% · 在本机浏览器里算，不上传、不扣费。电脑慢时 10 秒的片子可能要几十秒。</p>
    </div>}
    {error && <p role="alert" className="mt-2 whitespace-pre-wrap text-xs leading-5 text-rose-100">{error}</p>}
    {result && <div className="mt-4 space-y-2">
      <video className="max-h-[28rem] w-full rounded-xl border border-white/10 bg-black" src={result.url} controls playsInline preload="metadata" />
      <p className="text-xs text-white/50">
        <a className="text-emerald-100/85 underline" href={result.url} download={`${title || '成片'}-包装.${result.extension}`}>下载成片 {result.extension.toUpperCase()}</a>
        {` · ${result.seconds.toFixed(2)} 秒 · ${result.width}×${result.height} · ${result.hasAudio ? '有声音' : '无声音'} · ${(result.size / 1024 / 1024).toFixed(1)} MB`}
      </p>
    </div>}
  </section>;
}
