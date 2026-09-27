'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal, overlayButton } from './Overlay';
import type { ActionBeat, VideoBeat, VideoDnaAnalysis } from '../lib/types';

/**
 * 修正一镜里「发生了什么」。
 *
 * 为什么需要它：模型看不清的地方（指向画面后方的一个手势、坐在后景的角色）会被读成别的意思，
 * 而一份读错的 DNA 会往下污染故事、角色和成片——在有这个编辑器之前，唯一的出路是花钱重跑再赌一次。
 * 看过片的人两分钟就能修好的事，不该让人反复付费去碰运气。
 *
 * 能改的只有三样：整镜概括、逐拍动作、在场角色。
 * 时间边界、镜头数、置信度不给改——那些是取证事实，改了就是伪造证据（服务端也会再拦一道）。
 */
export function BeatEditor({ beat, analysis, onCancel, onSave }: {
  beat: VideoBeat;
  analysis: VideoDnaAnalysis;
  onCancel: () => void;
  onSave: (next: VideoBeat) => void;
}) {
  const [visualAction, setVisualAction] = useState(beat.visual_action);
  const [roleIds, setRoleIds] = useState<string[]>([...beat.role_ids]);
  const [steps, setSteps] = useState<ActionBeat[]>(() => (beat.action_beats ?? []).map((s) => ({ ...s })));
  const [error, setError] = useState('');

  const known = analysis.source_roles.map((role) => role.role_id);
  const roleLabel = (id: string) => {
    const role = analysis.source_roles.find((item) => item.role_id === id);
    return role ? `${id} · ${role.narrative_function.slice(0, 10)}` : id;
  };

  const patchStep = (index: number, patch: Partial<ActionBeat>) =>
    setSteps((old) => old.map((step, n) => (n === index ? { ...step, ...patch } : step)));
  const toggleStepRole = (index: number, field: 'actor_ids' | 'toward_ids', id: string) =>
    setSteps((old) => old.map((step, n) => {
      if (n !== index) return step;
      const current = step[field] ?? [];
      return { ...step, [field]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] };
    }));

  const addStep = () => setSteps((old) => {
    // 新拍点默认排在最后一拍之后、镜头结束之前，省得用户还要自己想一个合法的时间。
    const last = old.at(-1)?.at_seconds ?? beat.start_seconds;
    const at = Math.min(beat.end_seconds, Number((last + 1).toFixed(3)));
    return [...old, { at_seconds: at, actor_ids: [beat.role_ids[0] ?? known[0]].filter(Boolean), action: '' }];
  });

  const submit = () => {
    if (!visualAction.trim()) { setError('整镜概括不能为空。'); return; }
    const cleaned = steps
      .map((step) => ({
        at_seconds: Number(step.at_seconds),
        actor_ids: step.actor_ids.filter(Boolean),
        action: step.action.trim(),
        ...(step.toward_ids?.length ? { toward_ids: step.toward_ids } : {}),
        ...(step.reaction?.trim() ? { reaction: step.reaction.trim() } : {}),
        ...(step.consequence?.trim() ? { consequence: step.consequence.trim() } : {}),
      }))
      .sort((a, b) => a.at_seconds - b.at_seconds);
    for (const [index, step] of cleaned.entries()) {
      const label = `第 ${index + 1} 拍`;
      if (!Number.isFinite(step.at_seconds) || step.at_seconds < beat.start_seconds - 0.01 || step.at_seconds > beat.end_seconds + 0.01) {
        setError(`${label} 的时间要落在本镜 ${beat.start_seconds}–${beat.end_seconds} 秒之间。`); return;
      }
      if (!step.actor_ids.length) { setError(`${label} 要至少选一个发起者。`); return; }
      if (!step.action) { setError(`${label} 的动作不能为空。`); return; }
    }
    if (!roleIds.length) { setError('至少要有一个在场角色。'); return; }
    onSave({
      ...beat,
      visual_action: visualAction.trim(),
      role_ids: roleIds,
      ...(cleaned.length ? { action_beats: cleaned } : { action_beats: [] }),
      corrected_by_user: true,
    });
  };

  const chip = (on: boolean) => `rounded-full border px-2.5 py-1 text-[10px] transition ${on ? 'border-emerald-300/45 bg-emerald-300/10 text-emerald-100' : 'border-white/12 bg-white/[0.02] text-white/40 hover:text-white/70'}`;

  return <Modal
    open
    size="lg"
    onClose={onCancel}
    eyebrow={`${beat.beat_id} · ${beat.start_seconds}–${beat.end_seconds}s`}
    title="修正这一镜发生了什么"
    description="模型看不清的地方由你来定。时间边界、镜头数和置信度是取证事实，不在这里改；改过的镜头会永久标记为「人工修正」，导出的 JSON 里也带着。"
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      {error ? <p role="alert" className="text-xs text-rose-200">{error}</p> : <span />}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className={overlayButton.secondary}>取消</button>
        <button type="button" onClick={submit} className={overlayButton.primary}>保存修正</button>
      </div>
    </div>}
  >
    <label className="block text-xs text-white/55">整镜概括
      <textarea className="mt-1.5 min-h-16 w-full rounded-xl border border-white/12 bg-[#07120f] p-3 text-xs leading-6 text-white/85"
        value={visualAction} onChange={(event) => setVisualAction(event.target.value)} />
    </label>

    <div className="mt-4 text-xs text-white/55">在场角色
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {known.map((id) => <button key={id} type="button" className={chip(roleIds.includes(id))}
          onClick={() => setRoleIds((old) => old.includes(id) ? old.filter((x) => x !== id) : [...old, id])}>{roleLabel(id)}</button>)}
      </div>
      <p className="mt-1 text-[10px] text-white/30">漏掉在场角色是最常见的错：靠山、旁观者只要在画面里就该选上，否则下游会当他不存在。</p>
    </div>

    <div className="mt-5 flex items-center justify-between">
      <p className="text-xs text-white/55">逐拍动作（{steps.length} 拍）</p>
      <button type="button" onClick={addStep} className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-[11px] text-white/60 hover:text-white/90"><Plus size={12} />加一拍</button>
    </div>
    <p className="mt-1 text-[10px] leading-4 text-white/30">一个不间断机位里的每次「动作—反应—后果」写一拍。谁看向谁、谁因为看到谁才退让，就写在这里——这一层决定成片能不能演出因果。</p>

    <div className="mt-3 space-y-3 pb-2">
      {steps.map((step, index) => (
        <div key={index} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <input type="number" step="0.5" min={beat.start_seconds} max={beat.end_seconds}
              className="w-20 rounded-lg border border-white/12 bg-[#07120f] px-2 py-1 text-xs text-white"
              value={step.at_seconds} onChange={(event) => patchStep(index, { at_seconds: Number(event.target.value) })} />
            <span className="text-[10px] text-white/35">秒</span>
            <button type="button" onClick={() => setSteps((old) => old.filter((_, n) => n !== index))}
              className="ml-auto rounded-lg border border-white/10 p-1.5 text-white/35 hover:border-rose-300/30 hover:text-rose-200" aria-label={`删除第 ${index + 1} 拍`}><Trash2 size={12} /></button>
          </div>
          <div className="mt-2 text-[10px] text-white/40">谁做的
            <div className="mt-1 flex flex-wrap gap-1.5">
              {known.map((id) => <button key={id} type="button" className={chip(step.actor_ids.includes(id))} onClick={() => toggleStepRole(index, 'actor_ids', id)}>{id}</button>)}
            </div>
          </div>
          <input className="mt-2 w-full rounded-lg border border-white/12 bg-[#07120f] px-2.5 py-1.5 text-xs text-white/85"
            placeholder="做了什么，例如：傲慢地摆手，抬手指向坐在后方的靠山大哥。"
            value={step.action} onChange={(event) => patchStep(index, { action: event.target.value })} />
          <div className="mt-2 text-[10px] text-white/40">对准谁（看向、指向、冲着谁）
            <div className="mt-1 flex flex-wrap gap-1.5">
              {known.map((id) => <button key={id} type="button" className={chip((step.toward_ids ?? []).includes(id))} onClick={() => toggleStepRole(index, 'toward_ids', id)}>{id}</button>)}
            </div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input className="w-full rounded-lg border border-white/12 bg-[#07120f] px-2.5 py-1.5 text-xs text-white/75"
              placeholder="对方怎么反应" value={step.reaction ?? ''} onChange={(event) => patchStep(index, { reaction: event.target.value })} />
            <input className="w-full rounded-lg border border-white/12 bg-[#07120f] px-2.5 py-1.5 text-xs text-white/75"
              placeholder="造成什么后果" value={step.consequence ?? ''} onChange={(event) => patchStep(index, { consequence: event.target.value })} />
          </div>
        </div>
      ))}
      {steps.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-4 text-center text-[11px] text-white/30">这一镜还没有拍点。点「加一拍」把镜头里的交锋逐条写下来。</p>}
    </div>
  </Modal>;
}
