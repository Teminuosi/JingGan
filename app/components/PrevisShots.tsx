'use client';

import { useEffect, useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import type { CharacterCandidate, ReferenceAsset, RemixBrief, VideoDnaAnalysis } from '../lib/types';
import { compileOriginalStory } from '../lib/original-story';
import { downloadText } from '../lib/export';
import { CREATIVE_PROMPT_LIMIT, withPrevisBinding } from '../lib/output-runs';

type Shot = { index: number; beatId: string; start: number; end: number; localChecksPassed: boolean; issues: string[] };
const button = 'inline-flex min-h-11 items-center rounded-lg border border-emerald-200/25 px-4 py-2 text-sm text-emerald-100 disabled:opacity-40';

function PromptEditor({ prompt, name }: { prompt: string; name: string }) {
  const [text, setText] = useState(prompt);
  const [message, setMessage] = useState('');
  return <div className="min-w-0"><label className="text-sm font-medium text-white/85">本镜出片提示词<textarea aria-label={`${name}提示词`} value={text} onChange={e => { setText(e.target.value); setMessage(''); }} className="mt-3 min-h-80 w-full rounded-xl border border-white/15 bg-black/20 p-4 text-sm leading-7 text-white/80" /></label><p className={`mt-2 text-xs ${text.length > CREATIVE_PROMPT_LIMIT ? 'text-amber-100' : 'text-white/55'}`}>{text.length.toLocaleString()} / 4,000 字符{text.length > CREATIVE_PROMPT_LIMIT ? ' · 超过即梦上限，请精简；内容未截断。' : ''}</p><div className="mt-3 flex flex-wrap gap-3"><button className={button} disabled={text.length > CREATIVE_PROMPT_LIMIT} onClick={async () => { try { await navigator.clipboard.writeText(text); setMessage('已复制'); } catch { setMessage('复制失败，请下载提示词'); } }}>复制提示词</button><button className={button} onClick={() => downloadText(`${name}-提示词.txt`, text, 'text/plain')}>下载提示词</button>{text !== prompt && <button className={button} onClick={() => setText(prompt)}>恢复原提示词</button>}</div><p role="status" className="mt-2 text-xs text-emerald-200">{message}</p><p className="mt-2 text-xs leading-5 text-white/55">这里的编辑用于本次测试，刷新后还原；不会改写故事或重新渲染 3D。需要长期保留请下载。</p></div>;
}

export function PrevisShots({ ticket, analysis, brief, characters, assets }: {
  ticket: { id: string; token: string }; analysis: VideoDnaAnalysis; brief: RemixBrief; characters: CharacterCandidate[]; assets: ReferenceAsset[];
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const base = `http://127.0.0.1:43128/jobs/${ticket.id}`;
  const compiled = useMemo(() => {
    try {
      if (!brief.storyDraft) throw new Error('请先确认故事，再获取使用新角色和对白的测试提示词。');
      return { pack: compileOriginalStory(brief.storyDraft, analysis, brief, characters, assets, true), error: '' };
    } catch (cause) { return { pack: null, error: cause instanceof Error ? cause.message : String(cause) }; }
  }, [analysis, brief, characters, assets]);
  const selected = characters.map(character => ({ character, asset: assets.filter(a => !a.retired && a.approved && a.character_id === character.character_id && a.candidate_id === character.candidate_id && a.prompt === character.reference_image_prompt).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] })).filter(item => item.asset);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${base}/shots`, { headers: { Authorization: `Bearer ${ticket.token}` }, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('分镜读取失败，请确认本地预演服务已更新并运行。');
      const result = await response.json() as { shots: Shot[] };
      if (!controller.signal.aborted) setShots(result.shots);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, ticket.token]);
  const downloadRoles = async () => {
    setDownloading(true); setError('');
    try {
      const files: Record<string, Uint8Array> = {};
      for (const { character, asset } of selected) {
        const response = await fetch(asset.uri);
        if (!response.ok) throw new Error(`读取 ${character.design_name} 失败`);
        const ext = asset.mime_type === 'image/jpeg' ? 'jpg' : asset.mime_type === 'image/webp' ? 'webp' : 'png';
        files[`${character.character_id}-${character.design_name.replace(/[\\/:*?"<>|]/g, '-')}.${ext}`] = new Uint8Array(await response.arrayBuffer());
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: 'application/zip' }));
      const link = document.createElement('a'); link.href = url; link.download = '分镜测试-已确认角色图.zip'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDownloading(false); }
  };
  const runs = compiled.pack?.seedance_asset_map?.runs ?? [];
  const matchingRuns = (shot: Shot) => brief.storyMode === 'preserve' ? runs.filter(run => run.beat_ids.length === 1 && (run.beat_ids[0] === shot.beatId || run.beat_ids[0].startsWith(`${shot.beatId}_`)) && run.source_start_seconds >= shot.start - .01 && run.source_end_seconds <= shot.end + .01) : [];
  const unmatchedRuns = runs.filter(run => !shots.some(shot => matchingRuns(shot).includes(run)));
  return <section className="mt-8 border-t border-white/10 pt-7" aria-label="逐镜测试">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-xl font-semibold text-white/90">逐镜测试</h3><p className="mt-2 max-w-3xl text-sm leading-7 text-white/65">下载本镜 3D 和角色图，再复制提示词到出片平台。3D 提供原片走位与运镜参考，角色身份以确认图为准，动作调整以文字为准。</p></div><button className={button} disabled={downloading || selected.length === 0} onClick={() => void downloadRoles()}>{downloading ? '正在打包角色图…' : `下载已确认角色图（${selected.length}）`}</button></div>
    {selected.length > 0 && <p className="mt-3 text-xs leading-6 text-white/60">图片文件名与提示词角色对应：{selected.map(({ character }) => `${character.character_id} · ${character.design_name}`).join('；')}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-amber-100">{error}</p>}
    {compiled.error && <p className="mt-4 text-sm text-amber-100">提示词暂未就绪：{compiled.error} 视频仍可单独下载。</p>}
    {loading && <p role="status" className="mt-4 text-sm text-white/60">正在读取已生成的分镜…</p>}
    {!loading && !error && shots.length === 0 && <p className="mt-4 text-sm text-white/60">当前预演没有可读取的分镜文件。</p>}
    <div className="mt-6 space-y-6">{shots.map((shot, index) => {
      const matched = matchingRuns(shot);
      const name = `分镜${String(index + 1).padStart(2, '0')}`;
      return <article key={shot.index} className="rounded-2xl border border-white/10 p-5 sm:p-6"><div className="mb-4 flex flex-wrap items-baseline gap-3"><h4 className="font-semibold text-white/90">{name}</h4><span className="text-sm tabular-nums text-white/60">{shot.start}–{shot.end}s · {+(shot.end - shot.start).toFixed(3)} 秒</span>{matched.length > 1 && <span className="text-xs text-amber-100">超过模型单次上限，按动作顺序拆为 {matched.length} 段测试</span>}</div><div className="space-y-5">{(matched.length ? matched : [undefined]).map((run, part) => {
        const from = run ? +(run.source_start_seconds - shot.start).toFixed(3) : 0;
        const to = run ? +(run.source_end_seconds - shot.start).toFixed(3) : +(shot.end - shot.start).toFixed(3);
        const clipName = matched.length > 1 ? `${name}-${part + 1}` : name;
        const video = `${base}/shot-${shot.index}?token=${encodeURIComponent(ticket.token)}${matched.length > 1 ? `&from=${from}&to=${to}` : ''}`;
        const prompt = run ? withPrevisBinding(run.target_prompt) : '';
        return <div key={run?.run_id ?? shot.index} className="grid items-start gap-6 xl:grid-cols-[minmax(240px,0.7fr)_minmax(0,1.3fr)]">{matched.length > 1 && <p className="text-sm font-medium text-emerald-100 xl:col-span-2">第 {part + 1} 段 · {run?.source_start_seconds}–{run?.source_end_seconds}s · {run?.duration_seconds} 秒</p>}<div><video controls preload="none" className="max-h-[460px] w-full rounded-xl bg-black" src={video} /><a className={`${button} mt-3`} href={`${video}&download=1`}>下载{matched.length > 1 ? '本段' : '本镜'} 3D 视频</a>{!shot.localChecksPassed && <p className="mt-3 text-xs leading-6 text-amber-100">需复看：{shot.issues.join('；')}</p>}<p className="mt-3 text-xs leading-6 text-white/55">请核对测试平台支持的单次时长；拆分保留了全部动作和总时长。</p></div>{run ? <PromptEditor key={prompt} name={clipName} prompt={prompt} /> : <p className="text-sm leading-7 text-amber-100/85">{compiled.error ? '完成故事和角色确认后，这里会显示对应提示词。' : '当前故事与这一段原片预演无法逐镜对应，未强行绑定。请使用下方故事分镜提示词单独测试。'}</p>}</div>;
      })}</div></article>;
    })}</div>
    {unmatchedRuns.length > 0 && <div className="mt-8 space-y-5"><h4 className="font-semibold text-white/85">故事分镜提示词 · 暂无对应 3D</h4>{unmatchedRuns.map((run, i) => <article key={run.run_id} className="rounded-xl border border-white/10 p-5"><h5 className="mb-4 text-sm text-white/80">故事镜头 {i + 1} · {run.duration_seconds} 秒</h5><PromptEditor key={run.target_prompt} prompt={run.target_prompt} name={`故事镜头-${run.beat_ids[0]}`} /></article>)}</div>}
  </section>;
}
