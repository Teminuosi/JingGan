'use client';
import { useState } from 'react';
import type { CreativePack, ReferenceAsset } from '../lib/types';
import { VideoTargetPanel } from './VideoTargetPanel';
import { creativePackToMarkdown, downloadText } from '../lib/export';
import { ORIGINAL_PROMPT_CHARACTER_LIMIT } from '../lib/original-story';
import { videoModel } from '../lib/video-models';
import { voiceSpeakers, withPrevisBinding, withVoiceRoles } from '../lib/output-runs';

export function OriginalOutputPanel({ pack, referenceAssets, projectId, videoModelId, onVideoModelChange, preserve = false }: { pack: CreativePack; referenceAssets: ReferenceAsset[]; projectId: string; videoModelId: string; onVideoModelChange: (id: string) => void; preserve?: boolean }) {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const runs = pack.seedance_asset_map?.runs ?? [];
  const originalFullRun = pack.seedance_asset_map?.full_run;
  const fullRun = originalFullRun ? { ...originalFullRun, target_prompt: withPrevisBinding(withVoiceRoles(originalFullRun.target_prompt, pack.character_bible ?? [], voiceSpeakers(pack.beats)), 'full'), character_limit: ORIGINAL_PROMPT_CHARACTER_LIMIT } : undefined;
  if (fullRun) fullRun.within_character_limit = fullRun.target_prompt.length <= ORIGINAL_PROMPT_CHARACTER_LIMIT;
  const exportPack = fullRun ? { ...pack, seedance_asset_map: { ...pack.seedance_asset_map!, full_run: fullRun } } : pack;
  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id); setError(''); } catch { setError('复制失败，请使用下载按钮。'); }
  };
  return <div className="grid min-w-0 items-start gap-5 text-white/80"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">分镜创作 · {runs.length} 段</h2><details className="max-w-3xl text-sm"><summary className="cursor-pointer text-white/60">查看故事摘要</summary><p className="mt-3 leading-7">{pack.concept_summary}</p></details></div>
    <p className="text-sm leading-7 text-white/65">按分镜编辑提示词、下载素材，或通过 API 生成。API 自动携带角色图和提示词；3D 参考视频需下载后在平台手动绑定。每次提交前会显示费用与携带素材。</p>
    <div className="flex flex-wrap gap-3"><button className="rounded-xl border border-white/15 px-4 py-2" onClick={() => downloadText('同类型原创-完整创作包.json', JSON.stringify(exportPack, null, 2), 'application/json')}>下载项目 JSON</button><button className="rounded-xl border border-white/15 px-4 py-2" onClick={() => downloadText('同类型原创-完整创作包.md', creativePackToMarkdown(exportPack), 'text/markdown')}>下载完整说明</button></div>
    {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
    <div className="min-w-0"><VideoTargetPanel key={projectId} pack={pack} referenceAssets={referenceAssets} projectId={projectId} videoModelId={videoModelId} onVideoModelChange={onVideoModelChange} preserve={preserve} /></div>
    {fullRun
      ? <details className="min-w-0 rounded-xl border border-white/15 p-5"><summary className="cursor-pointer font-semibold text-white/85">整片导出 · {fullRun.duration_seconds} 秒 · 仅复制或下载</summary>
        <p className="mt-3 text-sm leading-7 text-amber-100">{videoModelId && fullRun.duration_seconds > videoModel(videoModelId).maxSeconds ? `当前模型单次上限 ${videoModel(videoModelId).maxSeconds} 秒，不能整片直接提交。请使用上方分镜生成。` : '整片导出用于手动平台；使用前请确认平台支持该时长。此处不会提交生成。'}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3>新片 {fullRun.source_start_seconds}–{fullRun.source_end_seconds}s · {fullRun.beat_ids.length} 镜 · <span className={fullRun.target_prompt.length <= ORIGINAL_PROMPT_CHARACTER_LIMIT ? '' : 'text-amber-200'}>{fullRun.target_prompt.length.toLocaleString()}</span> / {ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字符</h3>
          <button disabled={fullRun.target_prompt.length > ORIGINAL_PROMPT_CHARACTER_LIMIT} className="rounded-xl bg-emerald-300 px-4 py-2 text-[#082018] disabled:opacity-40" onClick={() => copy(fullRun.run_id, fullRun.target_prompt)}>{copied === fullRun.run_id ? '已复制' : '复制整片到即梦'}</button>
        </div>
        <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm leading-7">{fullRun.target_prompt}</pre>
        <p className="mt-3 text-xs leading-6 text-white/55">3D 参考对应整片预演视频。请从预演页下载后在平台绑定；这里的复制与文本导出不会自动上传视频。</p>
        <p className="mt-3 text-sm text-amber-100/75">{fullRun.target_prompt.length > ORIGINAL_PROMPT_CHARACTER_LIMIT ? '整片内容超过即梦 4,000 字符上限，请使用分镜提示词。内容未截断，可下载完整文本。' : '请确认平台支持整片时长；生成后需核对动作、对白和镜头连续性。'}</p>
        <button className="mt-3 text-sm underline" onClick={() => downloadText('整片-即梦提示词.txt', fullRun.target_prompt, 'text/plain')}>下载整片提示词</button>
      </details>
      : runs.length > 0 && <p className="text-sm text-amber-100/65">这是旧版导出的生成包，只有分段提示词。在角色页重新导出即可拿到整片一次生成的提示词，已保存的项目和分段不会被改写。</p>}
  </div>;
}
