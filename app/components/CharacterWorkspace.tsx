'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import type { CharacterCandidate, CharacterProposals, ReferenceAsset, VideoDnaAnalysis } from '../lib/types';
import type { ImageJob } from '../lib/use-relay-characters';
import { Modal, overlayButton } from './Overlay';

const secondary = 'min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm text-emerald-100 disabled:opacity-40';
const queueLabels = { queued: '等待提交', processing: '正在处理', saving: '图片已返回，正在保存', saved: '已保存', save_failed: '图片已返回，保存失败', unconfirmed: '结果待核实', failed: '未生成，可重试', not_submitted: '尚未提交' };

function assetFor(assets: ReferenceAsset[], candidate?: CharacterCandidate) {
  return candidate && assets.filter(a => !a.retired && a.character_id === candidate.character_id && a.candidate_id === candidate.candidate_id && a.prompt === candidate.reference_image_prompt).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
}

export function CharacterWorkspace({ analysis, proposals, selections, referenceAssets, busy, job, onGenerate, onDesignAll, onGoPrevis, renderSettings, children }: {
  analysis: VideoDnaAnalysis; proposals: CharacterProposals | null; selections: Record<string, string>; referenceAssets: ReferenceAsset[]; busy: boolean; job: ImageJob | null;
  onGenerate: (candidates: CharacterCandidate[]) => void; onDesignAll: () => void; onGoPrevis: () => void;
  renderSettings: (roleId: string, showCandidates: () => void) => ReactNode; children: (roleId: string) => ReactNode;
}) {
  const [activeId, setActiveId] = useState(analysis.source_roles[0]?.role_id ?? '');
  const [chosenTab, setTab] = useState<'settings' | 'candidates' | null>(null);
  const [batch, setBatch] = useState<'selected' | 'all' | null>(null);
  const roles = analysis.source_roles.map((role, index) => {
    const set = proposals?.role_sets.find(s => s.source_role_id === role.role_id);
    const chosen = set?.candidates.find(c => c.candidate_id === selections[role.role_id]);
    const asset = assetFor(referenceAssets, chosen);
    const count = set?.candidates.filter(c => assetFor(referenceAssets, c)).length ?? 0;
    const processing = job?.status === 'running' && (job.targetRoleId === role.role_id || set?.candidates.some(c => c.candidate_id === job.targetCandidateId));
    const saveFailed = job?.imageQueue?.some(item => item.status === 'save_failed' && set?.candidates.some(c => c.candidate_id === item.candidateId));
    const uncertain = job?.imageQueue?.some(item => item.status === 'unconfirmed' && set?.candidates.some(c => c.candidate_id === item.candidateId));
    const label = /[\u3400-\u9fff]/.test(role.narrative_function) ? role.narrative_function.split(/[：:，,。.;；]/)[0] : `角色 ${index + 1}`;
    return { role, set, chosen, count, label, approved: Boolean(asset?.approved), state: processing ? '处理中' : saveFailed ? '图片待保存' : uncertain ? '结果待核实' : asset?.approved ? '已确认' : count ? '已有图，待确认' : set ? '待生图' : '待设计' };
  });
  const current = roles.find(r => r.role.role_id === activeId) ?? roles[0];
  const tab = chosenTab ?? (current?.set ? 'candidates' : 'settings');
  const confirmed = roles.filter(r => r.approved).length;
  const unselected = roles.filter(r => !r.chosen);
  const all = roles.flatMap(r => r.set?.candidates ?? []);
  const chosen = roles.flatMap(r => r.chosen ?? []);
  const batchCandidates = batch === 'selected' ? chosen : all;
  const missing = batchCandidates.filter(c => !assetFor(referenceAssets, c));
  const blocked = batch === 'selected' ? unselected.length : roles.filter(r => !r.set).length;
  const locateMissing = () => {
    const next = roles.find(r => !r.approved);
    if (next) { setActiveId(next.role.role_id); setTab(next.set ? 'candidates' : 'settings'); }
    else onGoPrevis();
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
      <div><p className="text-sm text-white/80">已确认 {confirmed}/{roles.length} 个角色 · 已保存 {roles.reduce((n, r) => n + r.count, 0)} 张参考图</p><p className="mt-1 text-xs leading-5 text-white/55">选择候选 → 生成或上传图片 → 确认采用。文字方案和图片分别生成。</p></div>
      <button type="button" disabled={busy} onClick={locateMissing} className="min-h-11 rounded-lg bg-emerald-300 px-5 py-2 text-sm font-semibold text-[#082018] disabled:opacity-40">{confirmed === roles.length ? '下一步：分镜预演' : `还需确认 ${roles.length - confirmed} 个角色`}<ChevronRight size={15} className="ml-2 inline" /></button>
      <div className="flex w-full flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !proposals} onClick={() => setBatch('selected')} className={secondary}>每个角色生成已选方案</button>
        <button type="button" disabled={busy || !proposals} onClick={() => setBatch('all')} className={secondary}>生成所有候选</button>
        <button type="button" disabled={busy} onClick={() => { setTab(null); onDesignAll(); }} className="min-h-11 px-2 text-sm text-white/65 disabled:opacity-40">{proposals ? '继续 / 重新设计文字候选' : '逐角色生成文字候选（不生图）'}</button>
      </div>
      {!proposals && <p className="text-xs leading-6 text-white/55">每个角色单独计费，完成一个保存一个；文字候选不会自动生成图片。</p>}
    </div>
    {!!job?.imageQueue?.length && <div className="rounded-lg border border-white/15 bg-black/15 p-4" aria-label="图片生成队列">
      <p className="text-sm font-medium text-white/85">本次生图任务 · 已保存 {job.imageQueue.filter(i => i.status === 'saved').length}/{job.imageQueue.length} 张</p>
      <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">{job.imageQueue.map((item, index) => { const role = roles.find(r => r.set?.candidates.some(c => c.candidate_id === item.candidateId)); return <li key={item.candidateId} className="flex min-w-0 items-center justify-between gap-3 text-xs"><span className="truncate text-white/65">{index + 1}. {role?.label ?? '角色'} · 候选 {(role?.set?.candidates.findIndex(c => c.candidate_id === item.candidateId) ?? 0) + 1}</span><span className={`shrink-0 ${item.status === 'unconfirmed' || item.status === 'save_failed' ? 'text-amber-100' : item.status === 'saved' ? 'text-emerald-200' : 'text-white/55'}`}>{queueLabels[item.status]}</span></li>; })}</ul>
      {job.status === 'failed' && <p className="mt-3 text-xs leading-5 text-amber-100/80">已保存的图片保留。结果待核实的请求先检查缓存；尚未提交的图片未调用模型。</p>}
    </div>}
    <div className="grid items-start gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
      <nav aria-label="角色列表" className="flex gap-2 overflow-x-auto border-b border-white/10 pb-3 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:pr-4">
        {roles.map((r, index) => <button key={r.role.role_id} type="button" aria-pressed={r.role.role_id === current?.role.role_id} onClick={() => { setActiveId(r.role.role_id); setTab(r.set ? 'candidates' : 'settings'); }} className={`min-w-36 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-emerald-200 lg:min-w-0 ${r.role.role_id === current?.role.role_id ? 'border-emerald-200/35 bg-emerald-300/10' : 'border-transparent hover:bg-white/5'}`}>
          <span className="flex items-start justify-between gap-2 text-sm text-white/90"><span className="line-clamp-2">{index + 1}. {r.label}</span>{r.approved && <Check size={15} className="shrink-0 text-emerald-200" />}</span>
          <span className={`mt-2 block text-xs ${r.approved ? 'text-emerald-200' : 'text-white/60'}`}>{r.state}{r.set ? ` · ${r.count}/${r.set.candidates.length} 张` : ''}</span>
        </button>)}
      </nav>
      {current && <div className="min-w-0">
        <div className="mb-4"><h3 className="text-lg font-semibold text-white/90">{current.label}</h3><p className="mt-1 line-clamp-2 text-sm leading-6 text-white/60">{current.role.narrative_function}</p></div>
        <div role="tablist" aria-label="当前角色编辑" className="mb-5 flex gap-5 border-b border-white/10">
          {(['candidates', 'settings'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`min-h-11 border-b-2 px-1 text-sm ${tab === value ? 'border-emerald-200 text-emerald-100' : 'border-transparent text-white/55'}`}>{value === 'candidates' ? '候选与图片' : '角色设定'}</button>)}
        </div>
        <div role="tabpanel" aria-label={tab === 'settings' ? '角色设定' : '候选与图片'}>{tab === 'settings' ? renderSettings(current.role.role_id, () => setTab(null)) : children(current.role.role_id)}</div>
      </div>}
    </div>
    <Modal open={batch !== null} size="md" title={batch === 'selected' ? '生成每个角色的已选方案' : '生成所有角色的全部候选'} onClose={() => setBatch(null)} description="已有图片会跳过。新增图片逐张调用生图模型、逐张计费，不会重新生成文字方案。" footer={<div className="flex justify-end gap-3"><button type="button" onClick={() => setBatch(null)} className={overlayButton.secondary}>取消</button><button type="button" disabled={busy || blocked > 0 || missing.length === 0} className={overlayButton.primary} onClick={() => { setBatch(null); onGenerate(missing); }}>开始生成 {missing.length} 张（生图计费）</button></div>}>
      <p className="text-base text-white/90">新增 {missing.length} 张 · 跳过 {batchCandidates.length - missing.length} 张已有图片</p>
      {blocked > 0 && <p className="mt-3 text-sm text-amber-100">{batch === 'selected' ? `请先为 ${blocked} 个角色选择候选` : `请先完成 ${blocked} 个角色的文字方案`}，再开始批量生图。</p>}
      <ul className="mt-4 space-y-2 text-sm text-white/65">{roles.map(r => { const target = batch === 'selected' ? r.chosen ? [r.chosen] : [] : r.set?.candidates ?? []; return <li key={r.role.role_id}>{r.label}：新增 {target.filter(c => !assetFor(referenceAssets, c)).length} 张{target.length === 0 ? '，尚未准备' : ''}</li>; })}</ul>
    </Modal>
  </div>;
}
