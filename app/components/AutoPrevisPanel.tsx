'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, ChevronRight, Clapperboard, Film, LoaderCircle, PersonStanding, Upload } from 'lucide-react';
import type { VideoDnaAnalysis } from '../lib/types';
import { requireConnection } from '../lib/relay-client';
import { ensureAccount } from '../lib/account-client';
import { normalizeMinuteSecondTimeline } from '../lib/timeline-normalization.mjs';
import { loadSourceVideo, saveSourceVideo } from '../lib/source-video-cache';
import { CheckDot, CURRENT_PLANNING, RenderHelperCard } from './RenderHelperCard';

const BASE = 'http://127.0.0.1:43128';
const finished = new Set(['rendered_unreviewed', 'model_passed', 'needs_review', 'failed', 'canceled', 'interrupted']);
type Job = { id: string; status: string; message: string; hasVideo: boolean; index?: number; total?: number; round?: number; modelComparisonPassed?: boolean; mode?: string; createdAt?: number };

// 连不上本机助手时 fetch 抛 TypeError，原文是英文「Failed to fetch」——用户看了只会更懵。
// 所有直连助手的请求都走这一句，免得这里翻译了、那里又漏出英文。
const HELPER_UNREACHABLE = '连不上本机渲染助手：它可能没在运行，或浏览器没允许本页访问本地网络。启动助手后，在下方「渲染助手」那一行点「重新检查」。';
const helperError = (cause: unknown, fallback: string) => cause instanceof TypeError ? HELPER_UNREACHABLE : cause instanceof Error ? cause.message : fallback;

// 进度条上每个阶段叫什么。只用用户听得懂的词，不出现 planning / segment 这类实现名。
const STAGE_LABEL: Record<string, string> = { uploading: '正在把原片交给本机助手', queued: '排队中', planning: '编排动作', rendering: '本机渲染', merging: '串联全片' };
type Ticket = { id: string; token: string };

export function AutoPrevisPanel({ projectId, analysis, file, sourceName, autoStart, visible, onStatus, renderShots }: {
  projectId: string; analysis: VideoDnaAnalysis; file: File | null; sourceName?: string; autoStart: boolean; visible: boolean;
  /** 把预演状态报给流程条。渲完了流程条上那一步才敢显示「已完成」。 */
  onStatus?: (status: { ready: boolean; running: boolean }) => void;
  renderShots?: (ticket: Ticket) => ReactNode;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [busy, setBusy] = useState(false);
  const [helperStatus, setHelperStatus] = useState<'ready' | 'setup' | 'unavailable' | 'outdated' | null>(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState<File | null>(null);
  const [sourceLoading, setSourceLoading] = useState(!file);
  const [sourceNotice, setSourceNotice] = useState('');
  const started = useRef(false);
  const starting = useRef(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const storageKey = `mirror:auto-previs:${projectId}`;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const restore = async () => {
      if (file) {
        try { await saveSourceVideo(projectId, file); }
        catch { if (alive) setSourceNotice('当前原片可直接使用，但本机缓存未保存成功，刷新后可能需要补选。'); }
        if (alive) setSourceLoading(false);
        return;
      }
      try {
        let cached = await loadSourceVideo(projectId).catch(() => null);
        if (!cached) {
          const response = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/source`, { signal: controller.signal });
          if (response.ok) {
            cached = new File([await response.blob()], sourceName || '原视频', { type: 'video/mp4' });
            await saveSourceVideo(projectId, cached).catch(() => {});
          } else if (response.status !== 404) {
            throw new Error('读取本地原片失败');
          }
        }
        if (alive && cached) setSource(current => current || cached);
      } catch {
        if (alive) setSourceNotice('暂时无法读取本地预演服务中的原片，可稍后刷新重试或手动选择。');
      } finally { if (alive) setSourceLoading(false); }
    };
    void restore();
    return () => { alive = false; controller.abort(); };
  }, [file, projectId, sourceName]);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    void saveSourceVideo(projectId, source).catch(() => {
      if (alive) setSourceNotice('当前原片可直接使用，但本机缓存未保存成功，刷新后可能需要补选。');
    });
    return () => { alive = false; };
  }, [source, projectId]);

  useEffect(() => {
    let restored: Ticket | undefined;
    try {
      const value = localStorage.getItem(storageKey);
      if (value) { restored = JSON.parse(value); started.current = true; }
    } catch { /* A missing browser pointer does not delete backend artifacts. */ }
    if (restored) { const value = restored; const timer = setTimeout(() => setTicket(value), 0); return () => clearTimeout(timer); }
  }, [storageKey]);

  const start = useCallback(async () => {
    if (starting.current) return;
    const video = source || file;
    if (!video) { setError('请重新选择这个项目的原视频，以便自动核对动作。'); return; }
    starting.current = true; setBusy(true); setError('');
    let created: Ticket | undefined;
    try {
      const connection = requireConnection('analysis');
      const session = await ensureAccount(connection.accountId);
      if (!session.ok) { const result = await session.json() as { error?: string }; throw new Error(result.error || '请重新登录后生成预演。'); }
      const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as { ready: boolean; version: string; planningCalls?: unknown };
      if (health.planningCalls !== CURRENT_PLANNING) throw new Error('这台电脑上运行的是旧版助手，请先退出它，再下载新版助手启动后重试。');
      if (!health.ready) throw new Error('渲染环境尚未就绪，请打开“助手设置”一键准备 Blender，再重新检查。');
      if (health.version !== 'automatic-previs.v2') throw new Error('请重启本地预演服务，启用两次调用版本。');
      const response = await fetch(`${BASE}/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, analysis: normalizeMinuteSecondTimeline(analysis), connection: { baseUrl: connection.baseUrl, model: connection.model, apiKey: connection.apiKey }, sourceName: video.name }),
      });
      const value = await response.json() as Job & Ticket & { error?: string };
      if (!response.ok) throw new Error(value.error || '预演任务创建失败');
      created = { id: value.id, token: value.token };
      setTicket(created); setJob(value); localStorage.setItem(storageKey, JSON.stringify(created));
      const upload = await fetch(`${BASE}/jobs/${value.id}/source`, { method: 'PUT', headers: { Authorization: `Bearer ${value.token}`, 'Content-Type': 'application/octet-stream' }, body: video });
      const uploaded = await upload.json() as Job & { error?: string };
      if (!upload.ok) throw new Error(uploaded.error || '原视频上传失败');
      setJob(uploaded);
    } catch (cause) {
      // If upload fails before execution, release the reserved slot. Never resubmit silently.
      if (created) await fetch(`${BASE}/jobs/${created.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${created.token}` } }).catch(() => {});
      setError(helperError(cause, String(cause)));
    } finally { starting.current = false; setBusy(false); }
  }, [source, file, projectId, analysis, storageKey]);

  useEffect(() => {
    if (autoStart && !started.current && !sourceLoading && (source || file)) { started.current = true; void start(); }
  }, [autoStart, start, sourceLoading, source, file]);

  useEffect(() => {
    if (!ticket) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${BASE}/jobs/${ticket.id}`, { headers: { Authorization: `Bearer ${ticket.token}` }, signal: controller.signal });
        const value = await response.json() as Job & { error?: string };
        if (!response.ok) throw new Error(value.error || '读取预演进度失败');
        if (!alive) return;
        setJob(value);
        setError(current => current === HELPER_UNREACHABLE ? '' : current);
        if (!finished.has(value.status)) timer = setTimeout(poll, 2500);
      } catch (cause) {
        if (alive) { setError(helperError(cause, '暂时无法连接本地服务')); timer = setTimeout(poll, 8000); }
      }
    };
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [ticket]);

  const running = Boolean(job && !finished.has(job.status));
  // 只有真渲出片子才算就绪。failed / canceled / interrupted 都是结束但没产物，
  // 报成「已完成」等于骗人往下走。
  const ready = Boolean(job && (job.status === 'rendered_unreviewed' || job.status === 'model_passed' || job.status === 'needs_review'));
  useEffect(() => { onStatus?.({ ready, running }); }, [ready, running, onStatus]);
  // 生成中每秒刷新一次「已用时间」；不在跑的时候不走表，免得白白重渲染。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // 前置条件，不是可调项：拿不到原片就根本开不了工。
  const selectedVideo = source || file;
  const hasVideo = Boolean(selectedVideo);
  const output = ticket ? `${BASE}/jobs/${ticket.id}` : '';
  const previousFailure = Boolean(job && ['failed', 'canceled', 'interrupted'].includes(job.status));
  const recover = async () => {
    if (!ticket || starting.current) return;
    starting.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`${BASE}/jobs/${ticket.id}/recover`, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}` }, signal: AbortSignal.timeout(10000) });
      const value = await response.json() as Job & { error?: string };
      if (!response.ok) throw new Error(value.error || '恢复请求未成功');
      setJob(value); setTicket({ ...ticket });
    } catch (cause) { setError(helperError(cause, '无法恢复已保存结果')); }
    finally { starting.current = false; setBusy(false); }
  };
  // 从断点继续：同一个任务目录，已完成的共享库与镜头直接复用，只为没做完的镜头调用模型。
  // 以前界面上只有「新建任务（全部重新计费）」和「禁止调模型的恢复」两条路，续跑走不到。
  const resume = async () => {
    if (!ticket || starting.current) return;
    starting.current = true; setBusy(true); setError('');
    try {
      const connection = requireConnection('analysis');
      const session = await ensureAccount(connection.accountId);
      if (!session.ok) { const result = await session.json() as { error?: string }; throw new Error(result.error || '请重新登录后继续。'); }
      const response = await fetch(`${BASE}/jobs/${ticket.id}/resume`, {
        method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ connection: { baseUrl: connection.baseUrl, model: connection.model, apiKey: connection.apiKey } }),
      });
      const value = await response.json() as Job & { error?: string };
      if (!response.ok) throw new Error(value.error || '续跑请求未成功');
      setJob(value); setTicket({ ...ticket });
    } catch (cause) { setError(helperError(cause, '无法从断点继续')); }
    finally { starting.current = false; setBusy(false); }
  };
  const duration = Math.round(analysis.source.duration_seconds);
  const metadata = `${Math.floor(duration / 60)}分${String(duration % 60).padStart(2, '0')}秒 · ${analysis.source.aspect_ratio} · ${analysis.beats.length} 段`;
  const shotCount = analysis.beats.length;
  // 按镜编排的任务失败后可以从断点继续；老的整片一次编排任务只能用已保存结果免费重渲。
  const resumable = previousFailure && job?.mode === 'per-shot';
  // 只数真缺的。助手还在自动检查（null）时不算缺，免得状态胶囊一进页面先闪一下「还差 1 项」。
  const missing = [
    ...(!hasVideo && !sourceLoading ? ['原视频'] : []),
    ...(helperStatus !== null && helperStatus !== 'ready' ? ['渲染助手'] : []),
  ];
  // 一条进度条走完三段：编排（1 次共享库 + 每镜 1 次）→ 本机渲染每镜 → 串联全片。
  const stage = job ? (STAGE_LABEL[job.status] ?? '处理中') : '';
  const totalShots = job?.total ?? shotCount;
  const shotLabel = job?.index !== undefined && job?.total ? ` 第 ${Math.min(job.index + 1, job.total)}/${job.total} 镜` : '';
  const progressDone = !job ? 0
    : job.status === 'planning' ? (job.index === undefined ? 0 : job.index + 1)
    : job.status === 'rendering' ? totalShots + 1 + (job.index ?? 0)
    : job.status === 'merging' ? totalShots * 2 + 1
    : 0;
  const percent = Math.min(100, Math.round(progressDone / (totalShots * 2 + 2) * 100));
  const elapsed = running && job?.createdAt ? Math.max(0, Math.round((now - job.createdAt) / 1000)) : 0;
  const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
  const status = busy ? '正在提交'
    : running ? `${stage}${shotLabel}`
    : ready ? '预演已生成，待复看'
    : previousFailure ? '上次没做完'
    : sourceLoading ? '正在查找原视频'
    : missing.length ? `还差 ${missing.length} 项`
    : helperStatus === null ? '正在检查助手'
    : '可以开始';

  // 小白进这一页的第一个问题是「这是干嘛的」，不是「助手怎么装」。所以先讲用处，再讲准备。
  const flow = [
    { icon: Film, title: '原片', text: `${shotCount} 段镜头里谁站在哪、镜头怎么动、谁先动谁后动` },
    { icon: PersonStanding, title: '3D 小人演一遍', text: '用简单的 3D 人偶照着原片走位和运镜，渲成一段参考视频' },
    { icon: Clapperboard, title: '出片时当参考', text: '预演按镜切段，和提示词一起交给视频模型，模型照着动' },
  ];
  const explainer = (
    <section aria-label="这一步做什么" className="mb-6 rounded-2xl border border-emerald-200/15 bg-emerald-200/[0.035] p-5 sm:p-6">
      <p className="max-w-[64ch] text-sm leading-7 text-emerald-50/80">视频模型只读文字时，常把谁站在哪、镜头怎么动、谁先动谁后动搞乱。预演就是先用 3D 小人把原片这几件事演一遍，出片时交给模型当参考。</p>
      <ol className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
        {flow.flatMap((step, index) => {
          const Icon = step.icon;
          return [
            ...(index ? [<li key={`arrow-${index}`} aria-hidden="true" className="hidden items-center text-emerald-200/40 sm:flex"><ArrowRight size={18} /></li>] : []),
            <li key={step.title} className="rounded-xl border border-white/10 bg-[#07120f]/60 p-4">
              <Icon size={20} className="text-emerald-200/80" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium text-white/90">{step.title}</p>
              <p className="mt-1 text-xs leading-5 text-emerald-50/60">{step.text}</p>
            </li>,
          ];
        })}
      </ol>
      <p className="mt-5 text-xs leading-5 text-emerald-50/60">这一步可以不做：直接点页面底部的「跳过并导出提示词」，照样能出片，只是动作和镜头更容易跑偏。</p>
    </section>
  );

  const startLabel = busy ? '正在提交原片…' : ready ? '重新生成预演' : resumable ? '从头重新生成（全部重新计费）' : previousFailure ? '重新尝试生成预演' : '开始生成预演';
  const startNote = missing.length ? `还差：${missing.join('、')}。准备好之后这个按钮就能点。`
    : helperStatus === null ? '正在检查渲染助手…'
    : `会调用模型 ${shotCount + 1} 次编排动作（1 次定全片的角色和道具，每镜 1 次），按用量计费；渲染全在你的电脑上，原片不会再发给模型。中途失败可以从断点继续，做完的镜头不重复计费。`;
  const preparation = (
    <section aria-label="开始前的准备" className="rounded-2xl border border-white/10 p-5 sm:p-6">
      <h3 className="text-sm font-medium text-white/80">开始前需要两样东西</h3>
      <div className="mt-1 divide-y divide-white/[0.07]">
        <div className="py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <CheckDot state={hasVideo ? 'ok' : sourceLoading ? 'busy' : 'todo'} />
            <span className="w-20 shrink-0 text-sm font-medium text-white/85">原视频</span>
            <span className="min-w-0 flex-1 break-words text-sm text-emerald-50/70">
              {hasVideo ? <>{selectedVideo?.name || sourceName}<span className="text-emerald-50/45"> · {metadata}</span></> : sourceLoading ? '正在查找已保存的原片…' : '本机没找到，需要补选一次'}
            </span>
            <input ref={sourceInput} type="file" accept="video/*" aria-label="选择用于分析的原视频" className="hidden" onChange={event => { const next = event.target.files?.[0]; if (next) { setSource(next); setError(''); } }} />
            <button type="button" onClick={() => sourceInput.current?.click()} disabled={busy || running} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-200/25 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:cursor-not-allowed disabled:opacity-40">
              <Upload size={15} aria-hidden="true" />{hasVideo ? '更换' : '选择原视频'}
            </button>
          </div>
          {!hasVideo && !sourceLoading && <p className="mt-3 max-w-[66ch] text-xs leading-5 text-emerald-50/60 sm:ml-[34px]">选最初拿去分析的那条原片，不是预演成片。只在本机核对时长和画幅，不会再发给模型。</p>}
        </div>
        <RenderHelperCard active={visible} onStatusChange={setHelperStatus} />
      </div>
      <div className="mt-2 border-t border-white/10 pt-5">
        <button type="button" disabled={busy || running || !hasVideo || helperStatus !== 'ready'} onClick={() => void start()}
          className={resumable
            ? 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/20 px-4 text-sm text-white/75 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40'
            : 'inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-5 py-3 text-sm font-semibold text-[#082018] hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40'}>
          {busy && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {startLabel}
        </button>
        <p className="mt-3 max-w-[64ch] text-xs leading-5 text-emerald-50/60">{startNote}</p>
      </div>
    </section>
  );

  return (
    <div hidden={!visible} className="min-w-0 w-full">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-semibold tracking-tight text-white/95">生成预演</h2>
            <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/55">可跳过</span>
          </div>
          <p className="mt-2 max-w-[58ch] text-sm leading-6 text-emerald-50/70">先用 3D 小人把原片的走位和镜头演一遍，出片时给视频模型当动作参考。</p>
        </div>
        <span role="status" className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/70">{status}</span>
      </header>

      {!running && !ready && explainer}
      {sourceNotice && <p role="status" className="mb-4 text-sm text-amber-100/80">{sourceNotice}</p>}
      {error && <div role="alert" className="mb-5 rounded-xl border border-amber-200/25 bg-amber-200/5 p-4 text-sm leading-6 text-amber-100"><p className="font-semibold">刚才的操作没成功</p><p className="mt-1">{error}</p></div>}
      {!busy && previousFailure && (
        <div role="alert" className="mb-6 rounded-2xl border border-amber-200/25 bg-amber-200/[0.04] p-5 text-sm leading-6 text-amber-100">
          <p className="font-semibold">上次预演没做完</p>
          <p className="mt-2 break-words text-amber-100/85">{job?.message || '任务已结束，但没有生成预演视频。'}</p>
          {resumable ? <>
            <button type="button" onClick={() => void resume()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-5 py-3 text-sm font-semibold text-[#082018] hover:bg-emerald-200">从断点继续</button>
            <p className="mt-2 text-xs leading-5 text-amber-100/70">做完的镜头直接复用，只为没做完的镜头调用模型，不重复计费。原片、分析结果和角色图都还在。</p>
          </> : ticket ? <>
            <button type="button" onClick={() => void recover()} className="mt-4 min-h-11 rounded-lg border border-emerald-200/40 bg-emerald-200/10 px-5 py-3 text-sm font-medium text-emerald-100">使用已保存结果继续渲染（不调用模型）</button>
            <p className="mt-2 text-xs leading-5 text-amber-100/70">复用本机已存下的编排结果继续往下做，不再调用模型、不再计费。只有通过完整检查的计划才会开始渲染；缺哪一镜会直接说明。</p>
          </> : null}
        </div>
      )}

      {running ? (
        <section role="status" className="rounded-2xl border border-emerald-200/20 bg-emerald-200/5 p-6">
          <div className="flex items-center gap-3 text-base font-semibold text-emerald-100"><LoaderCircle size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{stage}{shotLabel}</div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true"><div className="h-full rounded-full bg-emerald-300 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>
          <p className="mt-3 text-sm leading-6 text-emerald-50/80">{job?.message}</p>
          <p className="mt-1 text-xs leading-5 text-emerald-50/55">已用 {elapsedText}。渲染在你的电脑上进行，可以切到别的页面，回来还在；关掉助手会中断，之后可以从断点继续。</p>
          {ticket && <button type="button" onClick={async () => {
            try {
              const response = await fetch(`${BASE}/jobs/${ticket.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}` } });
              if (!response.ok) throw new Error('停止请求未成功，请稍后再试。');
            } catch (cause) { setError(helperError(cause, '无法停止，请检查本地服务。')); }
          }} className="mt-5 min-h-11 rounded-lg border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/5">停止后续生成</button>}
        </section>
      ) : !ready ? preparation : null}

      {job?.hasVideo && ticket && (
        <section className="mt-6" aria-label="预演视频">
          <video controls preload="metadata" className="max-h-[620px] w-full rounded-xl bg-black" src={`${output}/video?token=${ticket.token}`} />
          <p className="mt-3 text-sm leading-6 text-emerald-50/70">请完整播放并对照原片检查。{job.modelComparisonPassed ? '历史任务已通过模型对照，仍需人工复看。' : '本地检查通过不代表动作与原片完全一致。'}</p>
          <a className="mt-2 inline-flex min-h-11 items-center text-sm text-emerald-200 underline underline-offset-4" href={`${output}/report?token=${ticket.token}`} target="_blank" rel="noreferrer">查看本地检查报告</a>
        </section>
      )}
      {visible && job?.hasVideo && ticket && renderShots?.(ticket)}

      {ready && <details className="group mt-6 border-t border-white/10 pt-5"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-emerald-50/75"><ChevronRight size={16} className="group-open:rotate-90" aria-hidden="true" />重新生成预演</summary><div className="mt-4">{preparation}</div></details>}
    </div>
  );
}
