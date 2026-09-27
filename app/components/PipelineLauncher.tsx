'use client';

// 复刻的入口：没开始时给预估让用户决定，开始后就交给进度页。
//
// 这一屏的全部职责是让用户在花钱之前看清三件事：
// 拆成几镜、哪几镜要多花钱做 3D 预演、一共大概多少钱。
// 看不到这三样就点「开始」，等于闭着眼睛付款。

import { useCallback, useEffect, useState } from 'react';
import { PipelinePanel } from './PipelinePanel';

interface StartResult {
  projectId: string;
  shotCount: number;
  taskCount: number;
  blenderShots: number;
  keyframeShots: number;
  previsMode: PrevisMode;
  previsClips: number;
  estimateCents: number;
  autoFixed: Array<{ shotId: string; message: string }>;
  continuityIssues: Array<{ shotId: string; severity: string; message: string }>;
}

type PrevisMode = 'full' | 'per_shot' | 'off';

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

/**
 * 三种预演模式。文案说的是「这么选会得到什么」，不是「这个开关叫什么」——
 * 用户要决定的是花不花这份渲染时间，而不是理解 Blender 是什么。
 */
const PREVIS_MODES: Array<{ id: PrevisMode; label: string; detail: string }> = [
  {
    id: 'full',
    label: '全片预演',
    detail: '把整条片子先在 3D 里排一遍，渲成一条 MP4，出片时按镜切段当参考视频。运镜和走位锁得最死，渲染最慢。',
  },
  {
    id: 'per_shot',
    label: '逐镜预演',
    detail: '每一镜单独排一遍。渲得快，但镜与镜之间的空间连续性没有保证。',
  },
  {
    id: 'off',
    label: '不做预演',
    detail: '直接出片。最快最省，运镜和多人走位全靠模型自由发挥。',
  },
];

export function PipelineLauncher({
  projectId, projectTitle, videoModelId,
}: { projectId: string; projectTitle: string; videoModelId: string }) {
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<StartResult | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [previsMode, setPrevisMode] = useState<PrevisMode>('full');

  // 已经开始过就直接进进度页，不要每次都让用户再点一遍「开始」。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/pipeline/pl_${encodeURIComponent(projectId)}`, { cache: 'no-store' });
        if (alive && res.ok) setPipelineId(`pl_${projectId}`);
      } catch { /* 没开始过，正常 */ }
      if (alive) setChecked(true);
    })();
    return () => { alive = false; };
  }, [projectId]);

  const start = useCallback(async () => {
    setStarting(true);
    setError('');
    try {
      const res = await fetch('/api/pipeline/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, videoModel: videoModelId, previsMode }),
      });
      const data = await res.json() as { result?: StartResult; error?: string };
      if (!res.ok) throw new Error(data.error ?? '开始失败');
      setResult(data.result ?? null);
      setPipelineId(data.result?.projectId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [projectId, videoModelId, previsMode]);

  if (!checked) return <div className="p-6 text-sm text-white/35">正在检查…</div>;

  if (pipelineId) {
    return (
      <div className="space-y-5">
        {result && (
          <div className="rounded-2xl border border-emerald-200/12 bg-emerald-300/[0.04] p-5">
            <div className="text-xs font-semibold text-emerald-200/85">已排好 {result.taskCount} 个任务</div>
            <div className="mt-3 flex flex-wrap gap-6">
              <Stat label="镜头" value={String(result.shotCount)} />
              <Stat
                label="3D 预演"
                value={result.previsMode === 'off' ? '不做' : result.previsMode === 'full' ? '全片 1 条' : `逐镜 ${result.previsClips} 条`}
                hint={result.previsMode === 'off' ? '运镜和走位由模型自由发挥' : '预演视频会作为参考喂给出片模型'}
              />
              <Stat label="要出关键帧" value={String(result.keyframeShots)} />
              <Stat label="预估费用" value={yuan(result.estimateCents)} hint="按模型单价 × 时长估算，实扣以上游返回为准" />
            </div>
          </div>
        )}
        {result && (result.autoFixed.length > 0 || result.continuityIssues.length > 0) && (
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-5">
            {result.autoFixed.length > 0 && (
              <>
                <div className="text-xs font-semibold text-emerald-200/80">已自动修正 {result.autoFixed.length} 处连续性问题</div>
                <ul className="mt-2 space-y-1">
                  {result.autoFixed.slice(0, 6).map((f, i) => (
                    <li key={i} className="text-[11px] leading-5 text-white/42">· {f.message}</li>
                  ))}
                </ul>
              </>
            )}
            {result.continuityIssues.length > 0 && (
              <>
                <div className={`text-xs font-semibold text-amber-200/80 ${result.autoFixed.length ? 'mt-4' : ''}`}>
                  {result.continuityIssues.length} 处需要你看一眼
                </div>
                <ul className="mt-2 space-y-1">
                  {result.continuityIssues.slice(0, 6).map((f, i) => (
                    <li key={i} className="text-[11px] leading-5 text-white/42">· {f.message}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <PipelinePanel projectId={pipelineId} />
      </div>
    );
  }

  return (
    <section className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
      <div className="xl:col-span-2">
        <div className="text-[10px] font-semibold tracking-[0.18em] text-emerald-200/50">复刻进度</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white/90">开始逐镜复刻</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/45">
          把《{projectTitle || '当前项目'}》的分镜交给生成管线：逐镜出片、自动质检，不合格的换打法重试，全部通过后拼成成片。
          开始之后不需要你盯着，出问题的镜头会单独列出来。
        </p>
      </div>

      <div className="rounded-2xl border border-white/7 bg-white/[0.02] p-5">
        <div className="text-xs font-semibold text-white/60">3D 预演</div>
        <p className="mt-1.5 text-[11px] leading-5 text-white/38">
          先用灰模把走位和机位在 3D 里排一遍，渲成视频交给出片模型当运镜参考。
          文字提示词锁不住运镜曲线和多人走位，参考视频能。
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {PREVIS_MODES.map((mode) => {
            const active = previsMode === mode.id;
            return (
              <button
                key={mode.id}
                onClick={() => setPrevisMode(mode.id)}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-emerald-300/45 bg-emerald-300/[0.08]'
                    : 'border-white/8 bg-black/15 hover:border-white/15'}`}
              >
                <div className={`text-xs font-semibold ${active ? 'text-emerald-200/90' : 'text-white/65'}`}>
                  {mode.label}
                </div>
                <div className="mt-1 text-[10px] leading-4 text-white/35">{mode.detail}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-[24px] border border-emerald-200/12 bg-gradient-to-br from-emerald-300/[0.075] to-transparent p-6 xl:col-start-2 xl:row-start-2">
        <div className="text-xs text-white/50">
          用 <span className="font-semibold text-emerald-200/85">{videoModelId}</span> 出片。
          点开始之后会先在本地拆镜、查连续性、算复杂度——这一步不花钱，会先把镜头数和预估费用列给你。
        </div>
        <button
          onClick={() => void start()}
          disabled={starting}
          className="mt-4 rounded-xl bg-emerald-300/90 px-5 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-40"
        >
          {starting ? '正在排任务…' : '开始复刻'}
        </button>
        {error && <p className="mt-3 text-xs text-rose-200/80">{error}</p>}
      </div>

      <div className="rounded-2xl border border-white/7 bg-white/[0.02] p-5 xl:col-span-2">
        <div className="text-xs font-semibold text-white/60">开始之后会发生什么</div>
        <ol className="mt-3 space-y-2 text-[11px] leading-5 text-white/42">
          <li>拆成 Shot DNA，逐镜记下机位、走位、逐拍动作</li>
          <li>检查跨镜连续性（换装穿帮、越轴、道具消失），能确定的自动修</li>
          <li>
            {previsMode === 'full' ? '把整条片子在 3D 里排一遍，渲成一条预演 MP4'
              : previsMode === 'per_shot' ? '每一镜单独做 3D 预演'
              : '跳过 3D 预演，直接进出片'}
          </li>
          <li>
            逐镜出片{previsMode !== 'off' && '（带上对应的预演片段当参考视频）'} → 自动质检 → 不合格换打法重试
          </li>
          <li>全部通过后按镜号拼接成片</li>
        </ol>
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[9px] text-white/28">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-white/80">{value}</div>
      {hint && <div className="mt-0.5 max-w-[15rem] text-[10px] leading-4 text-white/30">{hint}</div>}
    </div>
  );
}
