'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight, Clapperboard, Film as FilmIcon, LoaderCircle, PersonStanding, Upload } from 'lucide-react';
import type { VideoDnaAnalysis } from '../lib/types';
import { requireConnection } from '../lib/relay-client';
import { currentAccountId, ensureAccount } from '../lib/account-client';
import { confirmAction } from '../lib/confirm';
import { loadSourceVideo, saveSourceVideo } from '../lib/source-video-cache';
import { probeVideo } from '../lib/video-prep';
import { loadFilm, loadRun, plannedCalls, runBrowserPrevis, type PrevisRun } from '../lib/previs/browser-run';
import type { Film } from '../lib/previs/film';
import { CheckDot } from './RenderHelperCard';
import { AutoPrevisPanel } from './AutoPrevisPanel';
import { PrevisViewer } from './PrevisViewer';
import type { PrevisSource } from './PrevisShots';

const primary = 'inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-5 py-3 text-sm font-semibold text-[#082018] hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40';
const secondary = 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/20 px-4 text-sm text-white/75 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * 生成预演（默认：浏览器版）。
 * 编排：浏览器直连用户的中转（不支持跨域时经镜感服务器转发），每次返回存本机，失败从断点继续。
 * 渲染：页面里用 WebGL 实时播放，下载时逐帧编码成视频，不需要安装任何东西。
 * 本机 Blender 助手保留在「高级」里，流程不变。
 */
export function BrowserPrevisPanel({ projectId, analysis, file, sourceName, autoStart, visible, onStatus, renderShots }: {
  projectId: string; analysis: VideoDnaAnalysis; file: File | null; sourceName?: string; autoStart: boolean; visible: boolean;
  onStatus?: (status: { ready: boolean; running: boolean }) => void;
  renderShots?: (source: PrevisSource) => ReactNode;
}) {
  const [run, setRun] = useState<PrevisRun | null>(null);
  const [film, setFilm] = useState<Film | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState<File | null>(null);
  const [sourceLoading, setSourceLoading] = useState(!file);
  const [sourceNotice, setSourceNotice] = useState('');
  const [helperStatus, setHelperStatus] = useState({ ready: false, running: false });
  // 以前用本机助手做过预演的项目，默认展开高级区，让旧结果照常可见；
  // 没用过的不挂载助手面板——它会去连 127.0.0.1，部分浏览器会因此弹「访问本地网络」授权。
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem(`mirror:auto-previs:${projectId}`)) { const timer = setTimeout(() => setAdvancedOpen(true), 0); return () => clearTimeout(timer); } } catch { /* 读不到就按没用过处理 */ }
  }, [projectId]);
  const abort = useRef<AbortController | null>(null);
  const autoAsked = useRef(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());

  // 原片：本次会话有就用；否则读本机缓存（与之前的预演面板同一份缓存）。
  useEffect(() => {
    let alive = true;
    (async () => {
      if (file) { await saveSourceVideo(projectId, file).catch(() => { if (alive) setSourceNotice('当前原片可直接使用，但本机缓存未保存成功，刷新后可能需要补选。'); }); if (alive) setSourceLoading(false); return; }
      const cached = await loadSourceVideo(projectId).catch(() => null);
      if (alive) { if (cached) setSource(current => current || cached); setSourceLoading(false); }
    })();
    return () => { alive = false; };
  }, [file, projectId]);

  // 上次的结果：刷新页面后还在。编排中途刷新的，按「没做完」处理，可从断点继续。
  useEffect(() => {
    let alive = true;
    const account = currentAccountId();
    if (!account) return;
    (async () => {
      const saved = await loadRun(account, projectId).catch(() => undefined);
      if (!alive || !saved) return;
      const restored = saved.status === 'planning' ? { ...saved, status: 'failed' as const, message: '页面刷新或关闭打断了编排。已经拿到的镜头结果都在，可以从断点继续。' } : saved;
      setRun(restored);
      if (restored.status === 'ready' || restored.status === 'needs_review') { const next = await loadFilm(restored).catch(() => null); if (alive) setFilm(next); }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const running = busy || run?.status === 'planning';
  const ready = Boolean(film && run && (run.status === 'ready' || run.status === 'needs_review'));
  useEffect(() => { onStatus?.({ ready: ready || helperStatus.ready, running: running || helperStatus.running }); }, [ready, running, helperStatus, onStatus]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => abort.current?.abort(), []);

  const selectedVideo = source || file;
  const start = useCallback(async ({ resume = false, offline = false }: { resume?: boolean; offline?: boolean } = {}) => {
    if (abort.current) return;
    if (!selectedVideo) { setError('请重新选择这个项目的原视频，用来核对时长和画幅。'); return; }
    setBusy(true); setError('');
    try {
      const connection = requireConnection('analysis');
      const account = connection.accountId || currentAccountId();
      if (!account) throw new Error('请先登录，再生成预演。');
      const probe = await probeVideo(selectedVideo);
      if (!offline) {
        const estimate = await plannedCalls(account, projectId, analysis, probe.duration);
        if (estimate.toCall > 0) {
          const ok = await confirmAction({
            title: resume ? '从断点继续生成预演' : '生成 3D 预演',
            message: `将调用「${connection.model}」${estimate.toCall} 次编排动作（共 ${estimate.total} 次：1 次定全片角色和道具，每镜 1 次${estimate.saved ? `；已保存的 ${estimate.saved} 次直接复用，不重复计费` : ''}）。只发送文字，不上传视频；按你的中转用量计费。渲染在本页完成，不花钱。`,
            confirmLabel: `调用 ${estimate.toCall} 次并开始`, danger: true,
          });
          if (!ok) return;
        }
      }
      const session = await ensureAccount(connection.accountId);
      if (!session.ok) { const result = await session.json() as { error?: string }; throw new Error(result.error || '请重新登录后生成预演。'); }
      const controller = new AbortController(); abort.current = controller;
      setFilm(null);
      const result = await runBrowserPrevis({ projectId, analysis, source: probe, connection, accountId: account, allowModelCalls: !offline, signal: controller.signal, onUpdate: setRun });
      if (result.status === 'ready' || result.status === 'needs_review') setFilm(await loadFilm(result));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { abort.current = null; setBusy(false); }
  }, [selectedVideo, projectId, analysis]);

  // 「分析后自动生成预演」：仍然先弹付费确认，不静默花钱。
  useEffect(() => {
    if (!autoStart || autoAsked.current || sourceLoading || !selectedVideo || run) return;
    autoAsked.current = true;
    void start();
  }, [autoStart, sourceLoading, selectedVideo, run, start]);

  const shotCount = analysis.beats.length;
  const failed = run?.status === 'failed' || run?.status === 'canceled';
  const duration = Math.round(analysis.source.duration_seconds);
  const metadata = `${Math.floor(duration / 60)}分${String(duration % 60).padStart(2, '0')}秒 · ${analysis.source.aspect_ratio} · ${shotCount} 段`;
  const total = run?.total ?? shotCount;
  const doneCalls = run?.index === undefined ? 0 : run.index + 1;
  const percent = run?.status === 'planning' ? Math.min(100, Math.round(doneCalls / (total + 1) * 100)) : 0;
  const elapsed = running && run?.createdAt ? Math.max(0, Math.round((now - run.createdAt) / 1000)) : 0;
  const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
  const status = running ? (run?.status === 'planning' ? `编排动作${run.index !== undefined ? ` 第 ${Math.min(run.index + 1, total)}/${total} 镜` : ''}` : '正在准备')
    : ready ? (run?.status === 'needs_review' ? '已生成，有镜头需复看' : '预演已生成，待复看')
    : failed ? '上次没做完' : sourceLoading ? '正在查找原视频' : selectedVideo ? '可以开始' : '还差原视频';

  const flow = [
    { icon: FilmIcon, title: '原片', text: `${shotCount} 段镜头里谁站在哪、镜头怎么动、谁先动谁后动` },
    { icon: PersonStanding, title: '3D 小人演一遍', text: '在浏览器里用简单的 3D 人偶照着原片走位和运镜，可拖动、可转视角' },
    { icon: Clapperboard, title: '出片时当参考', text: '按镜下载 3D 视频，在出片平台绑定为动作参考' },
  ];

  const preparation = <section aria-label="开始前的准备" className="rounded-2xl border border-white/10 p-5 sm:p-6">
    <h3 className="text-sm font-medium text-white/80">开始前只需要原视频</h3>
    <div className="mt-1 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <CheckDot state={selectedVideo ? 'ok' : sourceLoading ? 'busy' : 'todo'} />
        <span className="w-20 shrink-0 text-sm font-medium text-white/85">原视频</span>
        <span className="min-w-0 flex-1 break-words text-sm text-emerald-50/70">{selectedVideo ? <>{selectedVideo.name || sourceName}<span className="text-emerald-50/45"> · {metadata}</span></> : sourceLoading ? '正在查找已保存的原片…' : '本机没找到，需要补选一次'}</span>
        <input ref={sourceInput} type="file" accept="video/*" aria-label="选择用于分析的原视频" className="hidden" onChange={event => { const next = event.target.files?.[0]; if (next) { setSource(next); setError(''); void saveSourceVideo(projectId, next).catch(() => {}); } }} />
        <button type="button" onClick={() => sourceInput.current?.click()} disabled={running} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-200/25 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:cursor-not-allowed disabled:opacity-40"><Upload size={15} aria-hidden="true" />{selectedVideo ? '更换' : '选择原视频'}</button>
      </div>
      {!selectedVideo && !sourceLoading && <p className="mt-3 max-w-[66ch] text-xs leading-5 text-emerald-50/60 sm:ml-[34px]">选最初拿去分析的那条原片。只在本机读取时长和画幅，不会再发给模型。</p>}
    </div>
    <div className="border-t border-white/10 pt-5">
      <button type="button" disabled={running || !selectedVideo} onClick={() => void start()} className={failed ? secondary : primary}>
        {busy && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {ready ? '重新生成预演' : failed ? '重新开始（已保存的镜头仍会复用）' : '开始生成预演'}
      </button>
      <p className="mt-3 max-w-[64ch] text-xs leading-5 text-emerald-50/60">会调用你的视频分析模型 {shotCount + 1} 次编排动作（1 次定全片角色和道具，每镜 1 次），只发文字、按用量计费，开始前会再确认一次。3D 渲染在本页完成，不用安装任何软件。中途失败可从断点继续，做完的镜头不重复计费。</p>
    </div>
  </section>;

  return <div hidden={!visible} className="min-w-0 w-full">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5"><h2 className="text-xl font-semibold tracking-tight text-white/95">生成预演</h2><span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/55">可跳过</span></div>
        <p className="mt-2 max-w-[58ch] text-sm leading-6 text-emerald-50/70">先用 3D 小人把原片的走位和镜头演一遍，出片时给视频模型当动作参考。</p>
      </div>
      <span role="status" className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70">{status}</span>
    </header>

    {!running && !ready && <section aria-label="这一步做什么" className="mb-6 rounded-2xl border border-emerald-200/15 bg-emerald-200/[0.035] p-5 sm:p-6">
      <p className="max-w-[64ch] text-sm leading-7 text-emerald-50/80">视频模型只读文字时，常把谁站在哪、镜头怎么动、谁先动谁后动搞乱。预演就是先用 3D 小人把原片这几件事演一遍，出片时交给模型当参考。</p>
      <ol className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">{flow.flatMap((step, index) => {
        const Icon = step.icon;
        return [...(index ? [<li key={`arrow-${index}`} aria-hidden="true" className="hidden items-center text-emerald-200/40 sm:flex"><ArrowRight size={18} /></li>] : []),
          <li key={step.title} className="rounded-xl border border-white/10 bg-[#07120f]/60 p-4"><Icon size={20} className="text-emerald-200/80" aria-hidden="true" /><p className="mt-3 text-sm font-medium text-white/90">{step.title}</p><p className="mt-1 text-xs leading-5 text-emerald-50/60">{step.text}</p></li>];
      })}</ol>
      <p className="mt-5 text-xs leading-5 text-emerald-50/60">这一步可以不做：直接点页面底部的「跳过并导出提示词」，照样能出片，只是动作和镜头更容易跑偏。</p>
    </section>}

    {sourceNotice && <p role="status" className="mb-4 text-sm text-amber-100/80">{sourceNotice}</p>}
    {error && <div role="alert" className="mb-5 rounded-xl border border-amber-200/25 bg-amber-200/5 p-4 text-sm leading-6 text-amber-100"><p className="font-semibold">刚才的操作没成功</p><p className="mt-1 break-words">{error}</p></div>}
    {!running && failed && <div role="alert" className="mb-6 rounded-2xl border border-amber-200/25 bg-amber-200/[0.04] p-5 text-sm leading-6 text-amber-100">
      <p className="font-semibold">上次预演没做完</p>
      <p className="mt-2 break-words text-amber-100/85">{run?.message}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={!selectedVideo} onClick={() => void start({ resume: true })} className={primary}>从断点继续</button>
        <button type="button" disabled={!selectedVideo} onClick={() => void start({ offline: true })} className={secondary}>只用已保存结果（不调用模型）</button>
      </div>
      <p className="mt-2 text-xs leading-5 text-amber-100/70">做完的镜头直接复用，只为没做完或没通过检查的镜头调用模型。</p>
    </div>}

    {running ? <section role="status" className="rounded-2xl border border-emerald-200/20 bg-emerald-200/5 p-6">
      <div className="flex items-center gap-3 text-base font-semibold text-emerald-100"><LoaderCircle size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{status}</div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true"><div className="h-full rounded-full bg-emerald-300 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>
      <p className="mt-3 text-sm leading-6 text-emerald-50/80">{run?.message}</p>
      <p className="mt-1 text-xs leading-5 text-emerald-50/55">已用 {elapsedText}{run?.transport ? ` · ${run.transport === 'direct' ? '浏览器直连中转' : '经镜感服务器转发（中转不支持浏览器直连）'}` : ''}。编排期间请保持本页打开；关掉或刷新会中断，之后可从断点继续。</p>
      <button type="button" onClick={() => abort.current?.abort()} className={`${secondary} mt-5`}>停止后续生成</button>
    </section> : !ready ? preparation : null}

    {ready && film && run && <section className="mt-2" aria-label="预演画面">
      <PrevisViewer film={film} downloadName="全片-3D预演" />
      <p className="mt-3 text-sm leading-6 text-emerald-50/70">请完整播放并对照原片检查。{run.status === 'needs_review' ? `有 ${run.shots.filter(s => !s.localChecksPassed).length} 镜没通过本地动作检查，下方已标出。` : '本地检查通过不代表动作与原片完全一致。'}</p>
      <p className="mt-1 text-xs leading-5 text-white/45">本次调用模型 {run.newModelCalls} 次、复用 {run.reusedModelCalls} 次 · {run.model}{run.transport ? ` · ${run.transport === 'direct' ? '浏览器直连' : '服务器转发'}` : ''}{run.schemaRejected ? ' · 中转不支持结构约束，已退回普通模式' : ''}</p>
    </section>}
    {visible && ready && film && run && renderShots?.({ kind: 'browser', film, shots: run.shots })}

    {ready && <details className="group mt-6 border-t border-white/10 pt-5"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-emerald-50/75"><ChevronRight size={16} className="group-open:rotate-90" aria-hidden="true" />重新生成预演</summary><div className="mt-4">{preparation}</div></details>}

    <details className="group mt-8 border-t border-white/10 pt-5" open={advancedOpen} onToggle={event => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-white/55"><ChevronRight size={16} className="group-open:rotate-90" aria-hidden="true" />高级：用本机 Blender 渲染（需要安装渲染助手，仅 Windows）</summary>
      {advancedOpen && <div className="mt-4">
        <AutoPrevisPanel embedded projectId={projectId} analysis={analysis} file={selectedVideo} sourceName={sourceName} autoStart={false} visible={visible && advancedOpen} onStatus={setHelperStatus} renderShots={ticket => renderShots?.({ kind: 'helper', ticket })} />
      </div>}
    </details>
  </div>;
}
