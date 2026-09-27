'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronRight, FileVideo, LoaderCircle, Upload } from 'lucide-react';
import type { VideoDnaAnalysis } from '../lib/types';
import { requireConnection } from '../lib/relay-client';
import { ensureAccount } from '../lib/account-client';
import { normalizeMinuteSecondTimeline } from '../lib/timeline-normalization.mjs';
import { loadSourceVideo, saveSourceVideo } from '../lib/source-video-cache';
import { RenderHelperCard } from './RenderHelperCard';

const BASE = 'http://127.0.0.1:43128';
const finished = new Set(['rendered_unreviewed', 'model_passed', 'needs_review', 'failed', 'canceled', 'interrupted']);
type Job = { id: string; status: string; message: string; hasVideo: boolean; index?: number; total?: number; round?: number; modelComparisonPassed?: boolean };
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
  const [helperStatus, setHelperStatus] = useState<'ready' | 'setup' | 'unavailable' | null>(null);
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
      const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as { ready: boolean; version: string };
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
      setError(cause instanceof TypeError ? '未连接本机渲染助手。请先启动助手，打开助手设置授权当前网站，并允许浏览器访问本地网络；然后点击“检查助手”。没有助手时可跳过预演，继续分镜创作。' : cause instanceof Error ? cause.message : String(cause));
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
        if (!finished.has(value.status)) timer = setTimeout(poll, 2500);
      } catch (cause) {
        if (alive) { setError(cause instanceof Error ? cause.message : '暂时无法连接本地服务'); timer = setTimeout(poll, 8000); }
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法恢复已保存结果'); }
    finally { starting.current = false; setBusy(false); }
  };
  const duration = Math.round(analysis.source.duration_seconds);
  const metadata = `${Math.floor(duration / 60)}分${String(duration % 60).padStart(2, '0')}秒 · ${analysis.source.aspect_ratio} · ${analysis.beats.length} 段`;
  const status = busy ? '正在提交原片' : running ? '生成中' : ready ? '预演待复看' : error || previousFailure ? '预演未完成' : hasVideo ? '可以开始生成' : sourceLoading ? '正在查找原视频' : '需要补选原视频';
  const preparation = (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section aria-label="选择原视频" className="rounded-xl border border-emerald-200/15 bg-emerald-200/[0.035] p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-200/10 text-sm font-semibold text-emerald-200" aria-hidden="true">{hasVideo ? <Check size={16} /> : '1'}</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-white/90">{hasVideo ? '原视频已就绪' : sourceLoading ? '正在查找已保存的原视频…' : '本机未找到原视频，请补选一次'}</h3>
            <p className="mt-1.5 text-sm leading-6 text-emerald-50/70">{hasVideo ? '直接复用本机原片，无需再次选择或交给模型分析。' : sourceLoading ? '正在检查浏览器缓存和本地预演记录。' : '分析结果和角色图仍保留。补选后会缓存原片，供下次打开项目使用。'}</p>
          </div>
        </div>
        <div className="mt-5 flex items-start gap-3 sm:ml-10">
          <FileVideo size={20} className="mt-0.5 shrink-0 text-emerald-200/70" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-xs text-emerald-50/60">{hasVideo ? '本项目原片' : '原片文件名'}</p>
            <p className="mt-1 break-words text-sm font-medium leading-6 text-white/90">{selectedVideo?.name || sourceName || '最初上传并用于 DNA 分析的视频'}</p>
            <p className="mt-1 text-sm text-emerald-50/65">原片信息：{metadata}{selectedVideo ? ` · 已选文件 ${(selectedVideo.size / 1024 / 1024).toFixed(1)} MB` : ''}</p>
          </div>
        </div>
        <div className="mt-5 sm:ml-10">
          <input ref={sourceInput} type="file" accept="video/*" aria-label="选择用于分析的原视频" className="hidden" onChange={event => { const next = event.target.files?.[0]; if (next) { setSource(next); setError(''); } }} />
          <button type="button" onClick={() => sourceInput.current?.click()} disabled={busy || running} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-200/30 px-4 py-2.5 text-sm font-medium text-emerald-100 hover:bg-emerald-200/10 disabled:cursor-not-allowed disabled:opacity-40">
            <Upload size={16} aria-hidden="true" />{hasVideo ? '更换原视频' : '选择原视频'}
          </button>
          <p className="mt-3 text-xs leading-5 text-emerald-50/65">选择最初分析的原片，不是预演成片。本步骤只在本机核对时长与画幅，不会重新交给模型分析。</p>
        </div>
      </section>
      <section aria-label="开始生成" className="flex items-start gap-3 rounded-xl border border-white/10 p-5 sm:p-6">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-200/10 text-sm font-semibold text-emerald-200" aria-hidden="true">2</span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white/90">生成预演</h3>
          <p className="mt-1.5 max-w-[60ch] text-sm leading-6 text-emerald-50/70">使用已保存的分析结果，调用 1 次模型编排，再由本机渲染成视频。无需重新分析原片。</p>
          <button type="button" disabled={busy || running || !hasVideo || helperStatus !== 'ready'} onClick={() => void start()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-300 px-5 py-3 text-sm font-semibold text-[#082018] hover:bg-emerald-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40">
            {busy && <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {busy ? '正在提交原片…' : helperStatus !== 'ready' ? '先连接并检查渲染助手' : ready ? '重新生成预演' : previousFailure ? '重新尝试生成预演' : '开始生成预演'}
          </button>
          {!hasVideo && <p className="mt-2 text-xs text-emerald-50/65">{sourceLoading ? '原片查找完成后即可继续。' : '补选原视频后即可开始。'}</p>}
        </div>
      </section>
    </div>
  );
  return (
    <div hidden={!visible} className="min-w-0 w-full">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-white/95">生成预演</h2>
          <p className="mt-2 max-w-[58ch] text-sm leading-6 text-emerald-50/70">把已分析的镜头制作成可播放的 3D 参考视频，用来检查走位和运镜。</p>
        </div>
        <span role="status" className="pt-1 text-sm text-emerald-200">{status}</span>
      </header>

      <RenderHelperCard onStatusChange={setHelperStatus} />
      {sourceNotice && <p role="status" className="mb-4 text-sm text-amber-100/80">{sourceNotice}</p>}
      {error && <div role="alert" className="mb-5 rounded-xl border border-amber-200/25 bg-amber-200/5 p-4 text-sm leading-6 text-amber-100"><p className="font-semibold">本次操作未完成</p><p className="mt-1">{error}</p></div>}
      {!error && !busy && previousFailure && <div role="alert" className="mb-5 rounded-xl border border-amber-200/25 bg-amber-200/5 p-4 text-sm leading-6 text-amber-100"><p className="font-semibold">最近一次预演未完成</p><p className="mt-2 break-words">{job?.message || '任务已结束，但没有生成预演视频。'}</p><p className="mt-2 text-amber-100/75">原片、分析结果和角色图仍保留。重新尝试会再次调用模型，可能产生费用；本页不会自动重试。</p></div>}
      {previousFailure && ticket && <div className="mb-6"><button type="button" disabled={busy} onClick={() => void recover()} className="min-h-11 rounded-lg border border-emerald-200/40 bg-emerald-200/10 px-5 py-3 text-sm font-medium text-emerald-100 disabled:opacity-40">{busy ? '正在处理…' : '使用已保存结果继续渲染（不调用模型）'}</button><p className="mt-2 text-xs leading-5 text-white/60">优先尝试恢复这次已返回的计划；只有完整计划通过检查才开始渲染，无法恢复时会说明原因。</p></div>}

      {running ? (
        <section role="status" className="rounded-xl border border-emerald-200/20 bg-emerald-200/5 p-6">
          <div className="flex items-center gap-3 text-base font-semibold text-emerald-100"><LoaderCircle size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />正在生成预演</div>
          <p className="mt-3 text-sm leading-6 text-emerald-50/80">{job?.message}{job?.total ? `（${Math.min((job.index ?? 0) + 1, job.total)}/${job.total} 段）` : ''}</p>
          <p className="mt-2 text-sm text-emerald-50/65">完成后将在这里显示视频，请勿重复提交。</p>
          {ticket && <button type="button" onClick={async () => {
            try {
              const response = await fetch(`${BASE}/jobs/${ticket.id}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}` } });
              if (!response.ok) throw new Error('停止请求未成功，请稍后再试。');
            } catch (cause) { setError(cause instanceof Error ? cause.message : '无法停止，请检查本地服务。'); }
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
