'use client';

// 复刻进度页。
//
// 主视觉是一条胶片时间轴：每一镜按时长占宽、按状态着色。
// 这条条子回答的是「整片跑到哪了」——比任何百分比数字都直观，
// 而且它本身就是影视活儿的语言（场记单 + 时间轴），不是通用 dashboard 的语言。
//
// 下面是场记单式的镜头列表。重试历史直接嵌在对应镜头下面，
// 因为「系统为什么又跑了一遍、花了多少」正是用户最需要看见的东西。
//
// 三条刻意的取舍：
//  1. **费用永远可见**，每镜一列、底部一个合计。花钱的产品把价格藏起来就是耍流氓。
//  2. **需要人处理的镜头顶到最上面**。其余的用户不用管，只有这些要他动手。
//  3. 轮询而不是长连接：这台机器上 SSE 走中转踩过坑，进度页没必要为几秒延迟冒这个险。

import { useCallback, useEffect, useRef, useState } from 'react';

interface QaEntry {
  outcome: 'pass' | 'warn' | 'fail';
  score: number;
  primaryFailure: string;
  decision: string;
  decisionNote: string;
  findings: Array<{ message: string; verdict: string }>;
  createdAt: number;
}

interface ShotView {
  shotId: string;
  idx: number;
  startTime: number;
  endTime: number;
  seconds: number;
  summary: string;
  characters: string[];
  complexityScore: number;
  needsBlender: boolean;
  blenderReasons: string[];
  previsBlocking: string;
  previsCameraPath: string;
  status: ShotStatus;
  activity: string;
  attempts: number;
  qa: QaEntry[];
  estimateCents: number;
  chargedCents: number;
  hasClip: boolean;
}

type ShotStatus = 'queued' | 'keyframe' | 'blender' | 'rendering' | 'checking' | 'retrying' | 'done' | 'needs_human';

interface PipelineView {
  projectId: string;
  title: string;
  status: string;
  totalSeconds: number;
  shots: ShotView[];
  tasks: { total: number; succeeded: number; running: number; pending: number; dead: number };
  stage: string;
  cost: { estimateCents: number; chargedCents: number };
  finalVideo?: { assetId: string; key: string; seconds: number };
  previs: {
    mode: 'full' | 'per_shot' | 'none';
    video?: { key: string; seconds: number };
    layout?: string;
    perShot: Record<string, string>;
    blocking: string;
    cameraPath: string;
  };
  blocked: Array<{ shotId: string; idx: number; reason: string }>;
  updatedAt: number;
}

/** 状态的颜色与说法。颜色只用三档：在跑（翡翠）、要人管（琥珀/玫红）、没开始（灰）。 */
const STATE: Record<ShotStatus, { label: string; bar: string; dot: string; text: string }> = {
  queued: { label: '排队中', bar: 'bg-white/8', dot: 'bg-white/25', text: 'text-white/38' },
  keyframe: { label: '关键帧', bar: 'bg-emerald-300/30', dot: 'bg-emerald-300/70', text: 'text-emerald-200/75' },
  blender: { label: '3D 预演', bar: 'bg-sky-300/30', dot: 'bg-sky-300/70', text: 'text-sky-200/75' },
  rendering: { label: '生成中', bar: 'bg-emerald-300/45', dot: 'bg-emerald-300', text: 'text-emerald-200/85' },
  checking: { label: '质检中', bar: 'bg-emerald-300/35', dot: 'bg-emerald-300/80', text: 'text-emerald-200/80' },
  retrying: { label: '重试中', bar: 'bg-amber-300/35', dot: 'bg-amber-300/80', text: 'text-amber-200/80' },
  done: { label: '已完成', bar: 'bg-emerald-400/70', dot: 'bg-emerald-400', text: 'text-emerald-200/90' },
  needs_human: { label: '待处理', bar: 'bg-rose-400/45', dot: 'bg-rose-400', text: 'text-rose-200/85' },
};

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

/** 时间码。影视活儿里时间是 mm:ss.s，不是「8 秒」。 */
function tc(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function PipelinePanel({ projectId, onClose }: { projectId: string; onClose?: () => void }) {
  const [view, setView] = useState<PipelineView | null>(null);
  const [error, setError] = useState('');
  const [openShot, setOpenShot] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/pipeline/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      const data = await res.json() as { pipeline?: PipelineView; error?: string };
      if (!res.ok) throw new Error(data.error ?? '读取进度失败');
      setView(data.pipeline ?? null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      await load();
      if (!alive) return;
      // 跑完了就不再轮询——没有变化还每两秒发一次请求是纯浪费。
      timer.current = setTimeout(tick, 2500);
    };
    void tick();
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  if (error && !view) {
    return (
      <div className="rounded-[24px] border border-rose-300/20 bg-rose-400/[0.05] p-6">
        <p className="text-sm text-rose-200/85">{error}</p>
        <button onClick={() => void load()} className="mt-3 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5">
          重新读取
        </button>
      </div>
    );
  }
  if (!view) return <div className="p-6 text-sm text-white/35">正在读取进度…</div>;

  const running = view.tasks.total > 0 && view.tasks.succeeded < view.tasks.total;

  return (
    <section className="space-y-6">
      {/* ── 标题与一句话状态 ── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.18em] text-emerald-200/50">复刻进度</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white/90">{view.title}</h2>
          <p className={`mt-1.5 text-sm ${view.blocked.length ? 'text-rose-200/80' : 'text-white/45'}`}>
            {view.stage}
            {running && <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300 align-middle" />}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="rounded-xl border border-white/7 bg-black/15 px-4 py-2 text-right">
            <div className="text-[9px] text-white/28">任务</div>
            <div className="text-base font-semibold tabular-nums text-white/80">
              {view.tasks.succeeded}<span className="text-white/25">/{view.tasks.total}</span>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-white/60 hover:bg-white/5">
              返回
            </button>
          )}
        </div>
      </header>

      {/* ── 胶片时间轴：整片一眼看完 ── */}
      <div>
        <div className="flex gap-[3px] overflow-hidden rounded-lg">
          {view.shots.map((shot) => (
            <button
              key={shot.shotId}
              onClick={() => setOpenShot(openShot === shot.shotId ? null : shot.shotId)}
              title={`第 ${shot.idx + 1} 镜 · ${STATE[shot.status].label} · ${shot.seconds}s`}
              // 宽度按时长占比：一条 20 秒的镜头在条子上就该比 5 秒的宽四倍，
              // 这样看到的进度是「片长的进度」而不是「镜头个数的进度」。
              style={{ flexGrow: Math.max(shot.seconds, 0.5) }}
              className={`group relative h-11 min-w-[8px] ${STATE[shot.status].bar}
                transition-[filter] hover:brightness-150
                ${openShot === shot.shotId ? 'ring-1 ring-inset ring-white/45' : ''}`}
            >
              <span className="absolute inset-x-0 bottom-1 text-[9px] tabular-nums text-black/45 opacity-0 group-hover:opacity-100">
                {shot.idx + 1}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-white/25">
          <span>{tc(0)}</span>
          <span>{view.shots.length} 镜 · 共 {tc(view.totalSeconds)}</span>
        </div>
      </div>

      {/* ── 3D 预演：全片模式下这条 MP4 就是喂给出片模型的运镜参考 ── */}
      {view.previs?.mode === 'full' && view.previs.video && (
        <div className="rounded-2xl border border-sky-300/15 bg-sky-300/[0.035] p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-xs font-semibold text-sky-200/85">全片 3D 预演</div>
            <div className="text-[10px] text-white/30">
              {tc(view.previs.video.seconds)} · {Object.keys(view.previs.perShot).length ? '下方已有单镜新版的镜头优先使用新版' : '出片时按镜切段作为参考视频'}
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
            <video
              src={`/api/objects/${view.previs.video.key}`}
              controls
              muted
              playsInline
              className="w-full rounded-xl border border-white/8 bg-black/40"
            />
            {view.previs.layout && (
              <figure className="m-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- 本地对象存储，没有 next/image 的 loader */}
                <img
                  src={`/api/objects/${view.previs.layout}`}
                  alt="俯视布局图：所有角色的平面站位"
                  className="w-full rounded-xl border border-white/8 bg-black/40"
                />
                <figcaption className="mt-1.5 text-[10px] text-white/30">俯视布局：谁站在哪</figcaption>
              </figure>
            )}
          </div>
          {view.previs.blocking && (
            <p className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-5 text-white/45">
              <span className="text-sky-200/60">空间关系：</span>{view.previs.blocking}
            </p>
          )}
          {view.previs.cameraPath && (
            <p className="mt-1 text-[11px] leading-5 text-white/45">
              <span className="text-sky-200/60">机位：</span>{view.previs.cameraPath}
            </p>
          )}
        </div>
      )}

      {/* ── 需要你处理的：顶到最上面，其余用户不用管 ── */}
      {view.blocked.length > 0 && (
        <div className="rounded-2xl border border-rose-300/20 bg-rose-400/[0.05] p-5">
          <div className="text-sm font-semibold text-rose-200/90">
            {view.blocked.some((b) => b.idx < 0)
              ? '有任务失败，后续无法继续'
              : `${view.blocked.length} 个镜头需要你处理`}
          </div>
          <ul className="mt-2.5 space-y-1.5">
            {view.blocked.map((b) => (
              <li key={b.shotId} className="text-xs leading-5 text-rose-100/65">
                {/* idx 为 -1 表示项目级任务（全片预演、拼接），它不属于任何一镜 */}
                {b.idx >= 0 && <span className="tabular-nums text-rose-200/80">第 {b.idx + 1} 镜 · </span>}
                {b.reason}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-5 text-white/35">
            这些不会自动再跑，也不会被拼进成片。处理完可以重新开始。
          </p>
        </div>
      )}

      {/* ── 场记单 ── */}
      <div className="overflow-hidden rounded-2xl border border-white/7">
        <div className="grid grid-cols-[3rem_7.5rem_1fr_5.5rem_4.5rem_5rem] gap-3 border-b border-white/5 bg-white/[0.02] px-4 py-2.5 text-[10px] text-white/30">
          <span>镜</span>
          <span>时间码</span>
          <span>内容</span>
          <span>复杂度</span>
          <span className="text-right">费用</span>
          <span className="text-right">状态</span>
        </div>

        {view.shots.map((shot) => {
          const st = STATE[shot.status];
          const open = openShot === shot.shotId;
          const failed = shot.qa.filter((q) => q.outcome === 'fail');
          return (
            <div key={shot.shotId} className="border-b border-white/5 last:border-b-0">
              <button
                onClick={() => setOpenShot(open ? null : shot.shotId)}
                className="grid w-full grid-cols-[3rem_7.5rem_1fr_5.5rem_4.5rem_5rem] items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02]"
              >
                <span className="text-sm font-semibold tabular-nums text-white/55">{shot.idx + 1}</span>
                <span className="text-[11px] tabular-nums text-white/38">
                  {tc(shot.startTime)}<span className="text-white/20"> → </span>{tc(shot.endTime)}
                </span>
                <span className="truncate text-xs text-white/62">
                  {shot.summary || <span className="text-white/25">（没有镜头描述）</span>}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-white/40">
                  <span className="tabular-nums">{shot.complexityScore}</span>
                  {shot.needsBlender && (
                    <span className="rounded bg-sky-300/12 px-1.5 py-0.5 text-[9px] text-sky-200/80">3D</span>
                  )}
                </span>
                <span className="text-right text-[11px] tabular-nums text-white/45">
                  {shot.chargedCents ? yuan(shot.chargedCents) : <span className="text-white/20">—</span>}
                </span>
                <span className={`flex items-center justify-end gap-1.5 text-[11px] ${st.text}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                  {st.label}
                  {shot.attempts > 1 && <span className="tabular-nums text-amber-200/70">×{shot.attempts}</span>}
                </span>
              </button>

              {/* 展开：这一镜的完整来龙去脉 */}
              {open && (
                <div className="space-y-3 bg-black/20 px-4 pb-4 pt-1">
                  <p className="text-xs leading-5 text-white/50">{shot.activity}</p>

                  {shot.characters.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {shot.characters.map((c) => (
                        <span key={c} className="rounded-md bg-white/5 px-2 py-0.5 text-[10px] text-white/45">{c}</span>
                      ))}
                    </div>
                  )}

                  {view.previs?.perShot?.[shot.shotId] && (
                    <div className="rounded-xl border border-sky-300/12 bg-sky-300/[0.04] p-3">
                      <div className="text-[11px] font-semibold text-sky-200/80">这一镜的 3D 预演</div>
                      <video
                        src={`/api/objects/${view.previs.perShot[shot.shotId]}`}
                        controls muted playsInline
                        className="mt-2 w-full max-w-md rounded-lg border border-white/8 bg-black/40"
                      />
                    </div>
                  )}

                  {(shot.previsBlocking || shot.previsCameraPath) && (
                    <div className="rounded-xl border border-white/8 bg-black/15 p-3">
                      {shot.previsBlocking && (
                        <p className="text-[11px] leading-5 text-white/45">
                          <span className="text-sky-200/60">站位：</span>{shot.previsBlocking}
                        </p>
                      )}
                      {shot.previsCameraPath && (
                        <p className="mt-1 text-[11px] leading-5 text-white/45">
                          <span className="text-sky-200/60">机位：</span>{shot.previsCameraPath}
                        </p>
                      )}
                    </div>
                  )}

                  {shot.needsBlender && shot.blenderReasons.length > 0 && (
                    <div className="rounded-xl border border-sky-300/12 bg-sky-300/[0.04] p-3">
                      <div className="text-[11px] font-semibold text-sky-200/80">为什么这一镜要做 3D 预演</div>
                      <ul className="mt-1.5 space-y-1">
                        {shot.blenderReasons.map((r, i) => (
                          <li key={i} className="text-[11px] leading-5 text-white/45">· {r}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 重试历史：系统判了什么、决定怎么打、花了多少 */}
                  {shot.qa.length > 0 && (
                    <div className="space-y-2">
                      {shot.qa.map((q, i) => (
                        <div
                          key={q.createdAt}
                          className={`rounded-xl border p-3 ${
                            q.outcome === 'fail' ? 'border-amber-300/15 bg-amber-300/[0.04]'
                            : q.outcome === 'warn' ? 'border-white/8 bg-white/[0.02]'
                            : 'border-emerald-300/12 bg-emerald-300/[0.03]'}`}
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span className={`text-[11px] font-semibold ${
                              q.outcome === 'fail' ? 'text-amber-200/85'
                              : q.outcome === 'warn' ? 'text-white/55' : 'text-emerald-200/80'}`}>
                              第 {shot.qa.length - i} 次质检 · {q.outcome === 'pass' ? '通过' : q.outcome === 'warn' ? '通过但有提醒' : '未通过'}
                            </span>
                            <span className="text-[10px] tabular-nums text-white/25">得分 {q.score}</span>
                          </div>
                          {q.findings.filter((f) => f.verdict !== 'pass').map((f, j) => (
                            <p key={j} className="mt-1 text-[11px] leading-5 text-white/45">· {f.message}</p>
                          ))}
                          {q.decision && (
                            <p className="mt-2 border-t border-white/5 pt-2 text-[11px] leading-5 text-white/55">
                              <span className="text-emerald-200/60">系统决定：</span>{q.decisionNote || q.decision}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {failed.length > 0 && shot.chargedCents > 0 && (
                    <p className="text-[11px] text-white/32">
                      这一镜重试了 {shot.attempts} 次，累计 {yuan(shot.chargedCents)}
                      {shot.estimateCents > 0 && `（单次预估 ${yuan(Math.round(shot.estimateCents / shot.attempts))}）`}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 费用与成片 ── */}
      <footer className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/7 bg-white/[0.02] px-5 py-4">
        <div className="flex gap-7">
          <div>
            <div className="text-[9px] text-white/28">预估</div>
            <div className="text-base font-semibold tabular-nums text-white/60">{yuan(view.cost.estimateCents)}</div>
          </div>
          <div>
            <div className="text-[9px] text-white/28">已扣</div>
            <div className="text-base font-semibold tabular-nums text-emerald-200/85">{yuan(view.cost.chargedCents)}</div>
          </div>
          {view.tasks.dead > 0 && (
            <div>
              <div className="text-[9px] text-white/28">失败任务</div>
              <div className="text-base font-semibold tabular-nums text-rose-300/80">{view.tasks.dead}</div>
            </div>
          )}
        </div>
        {view.finalVideo ? (
          <a
            href={`/api/objects/${view.finalVideo.key}`}
            className="rounded-xl bg-emerald-300/90 px-4 py-2 text-xs font-semibold text-emerald-950 hover:bg-emerald-300"
          >
            下载成片（{tc(view.finalVideo.seconds)}）
          </a>
        ) : (
          <span className="text-[11px] text-white/28">成片会在所有镜头通过质检后自动拼接</span>
        )}
      </footer>
    </section>
  );
}
