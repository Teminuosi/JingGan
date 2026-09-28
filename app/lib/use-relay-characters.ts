'use client';

import { useEffect, useRef, useState } from 'react';
import type { CharacterCandidate, CharacterProposals, ReferenceAsset, RemixBrief, RoleDesignSettings, VideoDnaAnalysis } from './types';
import { completedRelayTask, generateRelayImage, generateRelayText, imageFromResult, lastRelayOutcome, loadConnection, recoverRelayTask, relayTaskDiagnostic, requireConnection } from './relay-client';
import { redactRelayError, textFromResult } from './relay-protocol';
import { downloadText } from './export';
import { characterProposalsSchema } from './schemas';
import { buildCharacterDesignInstruction, CHARACTER_DESIGN_SYSTEM_INSTRUCTION } from './prompts';
import { parseCharacterProposals } from './validation';
import { animalAnatomyInstruction, assertAnimalAnatomyText, resolveCharacterEntity } from './entity-profile';

interface ImageJob {
  id: string; status: 'running' | 'completed' | 'failed'; message: string;
  phase: 'design' | 'images' | 'recovery'; startedAt: number; lastSignalAt?: number;
  expectedCount: number; completedImages: string[]; progress: number;
  targetCandidateId?: string;
}
interface Props {
  analysis: VideoDnaAnalysis; brief: RemixBrief; projectId: string;
  proposals: CharacterProposals | null; referenceAssets: ReferenceAsset[];
  onSaveProposals: (value: CharacterProposals) => Promise<void>;
  onSaveImage: (candidate: CharacterCandidate, image: Blob) => Promise<void>;
  onBusy: (value: boolean) => void;
}
async function fingerprint(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
export function useRelayCharacters(props: Props) {
  const [job, setJob] = useState<ImageJob | null>(null);
  const [error, setError] = useState('');
  const [unsavedImages, setUnsavedImages] = useState<{ candidate: CharacterCandidate; image: Blob }[]>([]);
  const current = useRef(props);
  useEffect(() => { current.current = props; });
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const warn = (event: BeforeUnloadEvent) => { if (running.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', warn); };
  }, []);
  const imagePrompt = (candidate: CharacterCandidate) => {
    assertAnimalAnatomyText(candidate);
    return [candidate.reference_image_prompt, animalAnatomyInstruction(resolveCharacterEntity(candidate))].filter(Boolean).join('\n');
  };
  const cacheKey = async (candidate: CharacterCandidate) => `image:${props.projectId}:${candidate.candidate_id}:${await fingerprint(imagePrompt(candidate))}`;
  const saved = (candidate: CharacterCandidate) => current.current.referenceAssets.some(a => !a.retired && a.candidate_id === candidate.candidate_id && a.prompt === candidate.reference_image_prompt);
  const begin = async (action: () => Promise<void>, phase: ImageJob['phase'] = 'images') => {
    if (running.current) return;
    running.current = true; props.onBusy(true); setError('');
    setJob({ id: props.projectId, status: 'running', phase, startedAt: Date.now(), message: '准备任务…', expectedCount: 0, completedImages: [], progress: 0 });
    try { await action(); if (mounted.current) setJob(j => j && ({ ...j, status: 'completed', message: j.phase === 'design' ? '角色文字方案已校验并保存。接下来选择候选，再生成或上传参考图。' : j.phase === 'recovery' ? j.message : '图片任务已结束；已保存的内容可在下方查看。', targetCandidateId: undefined, progress: j.expectedCount ? 100 : 0 })); }
    catch (cause) {
      if (mounted.current) { setError(`${cause instanceof Error ? cause.message : String(cause)} 已保存的结果保留；先检查缓存结果，不要连续重新提交。`); setJob(j => j && ({ ...j, status: 'failed' })); }
    } finally { running.current = false; if (mounted.current) props.onBusy(false); }
  };
  const ensureMounted = () => { if (!mounted.current) throw new Error('页面已切换，结果已缓存，返回后可恢复。'); };
  const retainImage = (candidate: CharacterCandidate, image: Blob) => {
    setUnsavedImages(images => [...images.filter(item => item.candidate.candidate_id !== candidate.candidate_id), { candidate, image }]);
  };
  const saveImage = async (candidate: CharacterCandidate, image: Blob) => {
    retainImage(candidate, image);
    await props.onSaveImage(candidate, image);
    setUnsavedImages(images => images.filter(item => item.candidate.candidate_id !== candidate.candidate_id));
  };
  const downloadRecoveredImage = (candidateId: string) => {
    const item = unsavedImages.find(image => image.candidate.candidate_id === candidateId);
    if (!item) return;
    const uri = URL.createObjectURL(item.image);
    const link = document.createElement('a');
    link.href = uri; link.download = `${candidateId}.${item.image.type === 'image/jpeg' ? 'jpg' : item.image.type === 'image/webp' ? 'webp' : 'png'}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(uri), 60000);
  };
  const generateImages = async (candidates: CharacterCandidate[]) => {
    const missing = candidates.filter(c => !saved(c));
    const completed: string[] = [];
    setJob(j => j && ({ ...j, phase: 'images', expectedCount: missing.length }));
    for (const candidate of missing) {
      ensureMounted();
      const key = await cacheKey(candidate);
      setJob(j => j && ({ ...j, targetCandidateId: candidate.candidate_id, message: `${candidate.design_name}：已提交，等待图片。` }));
      const cached = await completedRelayTask(key);
      const image = cached !== undefined ? await imageFromResult(cached) : await generateRelayImage(imagePrompt(candidate), key, event => {
        if (mounted.current) setJob(j => j && ({ ...j, message: `${candidate.design_name}：${event === 'heartbeat' ? '中转仍在处理（不是完成百分比）' : event === 'completed' ? '图片已返回，正在保存' : '正在生成'}。` }));
      });
      ensureMounted();
      await saveImage(candidate, image);
      completed.push(`${candidate.candidate_id}.png`);
      setJob(j => j && ({ ...j, completedImages: [...completed], progress: Math.round(completed.length / missing.length * 100) }));
    }
  };
  // 候选数是用户选的：提示词、schema、校验三处必须同时按这个数走，任何一处对不上都会白花一次钱。
  const wanted = Math.max(2, Math.min(6, Math.floor(props.brief.candidateCount ?? 4)));
  const characterTask = async (roleId?: string) => {
    const prompt = `${CHARACTER_DESIGN_SYSTEM_INSTRUCTION}\n${buildCharacterDesignInstruction(props.analysis, props.brief, roleId)}\n已确认的故事（剧情动作以此为准，角色身份和身体结构以用户目标设定为准，不回退原片物种或性别）：\n${JSON.stringify(props.brief.storyDraft)}\n只返回符合此 schema 的 JSON，不写文件：\n${JSON.stringify(characterProposalsSchema(wanted))}`;
    return { prompt, key: `characters:${props.projectId}:v2:${await fingerprint(prompt)}` };
  };
  const saveDesignResult = async (raw: string, roleId?: string, designs = props.brief.roleDesigns ?? {}, expectedCount = wanted) => {
    const roles = props.analysis.source_roles.filter(r => !roleId || r.role_id === roleId);
    const next = parseCharacterProposals(raw, roles, expectedCount, true, designs, props.analysis.source_roles.map(r => r.role_id));
    const suffix = (await fingerprint(raw + JSON.stringify(designs))).slice(0, 10);
    next.role_sets.forEach(s => s.candidates.forEach(c => { c.candidate_id = `${c.candidate_id}_${suffix}`; }));
    const old = current.current.proposals;
    const replacing = new Set(next.role_sets.map(s => s.source_role_id));
    const merged: CharacterProposals = {
      ...next,
      role_sets: props.analysis.source_roles.flatMap(r => next.role_sets.find(s => s.source_role_id === r.role_id) ?? old?.role_sets.find(s => s.source_role_id === r.role_id) ?? []),
      archived_role_sets: [...(old?.archived_role_sets ?? []), ...(old?.role_sets.filter(s => replacing.has(s.source_role_id) && !next.role_sets.some(n => n.candidates[0]?.candidate_id === s.candidates[0]?.candidate_id)) ?? [])],
    };
    ensureMounted(); await props.onSaveProposals(merged);
    return merged;
  };
  const design = (roleId?: string) => begin(async () => {
    requireConnection('text');
    const { prompt, key } = await characterTask(roleId);
    localStorage.setItem(`mirror:last-character-design:${props.projectId}`, JSON.stringify({ key, roleId, count: wanted, designs: props.brief.roleDesigns ?? {} }));
    setJob(j => j && ({ ...j, message: '正在设计角色方案；完成后可编辑提示词，再选择生图。' }));
    const cached = await completedRelayTask(key);
    const raw = cached === undefined ? await generateRelayText(prompt, key, event => {
      if (mounted.current) setJob(j => j && ({ ...j, lastSignalAt: Date.now(), message: event.includes('delta') ? '正在接收角色方案内容；完整返回后才会校验和保存。' : event.includes('completed') ? '已收到模型返回，正在校验角色方案。' : '中转已返回响应，正在等待完整角色方案。' }));
    }) : textFromResult(cached);
    setJob(j => j && ({ ...j, message: '已收到完整返回，正在校验并保存角色方案。' }));
    await saveDesignResult(raw, roleId);
    localStorage.removeItem(`mirror:last-character-design:${props.projectId}`);
  }, 'design');
  const recoverCharacterResult = async () => {
    const pending = localStorage.getItem(`mirror:last-character-design:${props.projectId}`);
    if (pending) return recoverRelayTask((JSON.parse(pending) as { key: string }).key);
    const { key } = await characterTask();
    return recoverRelayTask(await lastRelayOutcome(key) ? key : `characters:${props.projectId}`);
  };
  const start = (candidates?: CharacterCandidate[]) => begin(async () => {
    requireConnection('image');
    let plan = props.proposals;
    if (!plan) {
      requireConnection('text');
      setJob(j => j && ({ ...j, message: `文本模型正在为每个角色设计 ${wanted} 个候选，尚未开始生图。` }));
      const { prompt, key } = await characterTask();
      const cached = await completedRelayTask(key);
      const raw = cached === undefined ? await generateRelayText(prompt, key) : textFromResult(cached);
      plan = parseCharacterProposals(raw, props.analysis.source_roles, wanted, true, props.brief.roleDesigns ?? {});
      ensureMounted(); await props.onSaveProposals(plan);
    }
    plan = parseCharacterProposals(JSON.stringify(plan), props.analysis.source_roles.filter(r => plan!.role_sets.some(s => s.source_role_id === r.role_id)), 0, false, undefined, props.analysis.source_roles.map(r => r.role_id));
    const ids = candidates ? new Set(candidates.map(c => c.candidate_id)) : null;
    await generateImages(plan.role_sets.flatMap(s => s.candidates).filter(c => !ids || ids.has(c.candidate_id)));
  });
  const recover = () => begin(async () => {
    setJob(j => j && ({ ...j, message: '正在检查本机已缓存结果，不提交模型请求。' }));
    let plan = props.proposals;
    const originalPlan = plan;
    const issues: string[] = [];
    const completed: string[] = [];
    let trackedImageTask = false;
    let alreadySaved = 0;
    const pending = localStorage.getItem(`mirror:last-character-design:${props.projectId}`);
    if (pending) {
      try {
        const task = JSON.parse(pending) as { key: string; roleId?: string; count?: number; designs: Record<string, RoleDesignSettings> };
        plan = await saveDesignResult(textFromResult(await recoverRelayTask(task.key)), task.roleId, task.designs, task.count ?? wanted);
        localStorage.removeItem(`mirror:last-character-design:${props.projectId}`);
      } catch (cause) { if (!plan) throw cause; }
    }
    if (!plan) {
      plan = parseCharacterProposals(textFromResult(await recoverCharacterResult()), props.analysis.source_roles, wanted);
      ensureMounted(); await props.onSaveProposals(plan);
    }
    const lastRaw = localStorage.getItem(`mirror:last-image-edit:${props.projectId}`);
    if (lastRaw) {
      try {
        const last = JSON.parse(lastRaw) as { candidate: CharacterCandidate; key: string; originalCandidateId?: string };
        const original = plan.role_sets.flatMap(s => s.candidates).find(c => c.candidate_id === last.candidate.candidate_id || c.candidate_id === last.originalCandidateId);
        const blob = await imageFromResult(await recoverRelayTask(last.key));
        ensureMounted();
        retainImage(last.candidate, blob);
        if (original) {
          const next = { ...plan, archived_role_sets: [...(plan.archived_role_sets ?? []), ...plan.role_sets.filter(s => s.source_role_id === original.source_role_id && original.candidate_id !== last.candidate.candidate_id)], role_sets: plan.role_sets.map(s => ({ ...s, candidates: s.candidates.map(c => c.candidate_id === original.candidate_id ? last.candidate : c) })) };
          parseCharacterProposals(JSON.stringify(next), props.analysis.source_roles.filter(r => next.role_sets.some(s => s.source_role_id === r.role_id)), 0, false, undefined, props.analysis.source_roles.map(r => r.role_id));
          await props.onSaveProposals(next); await saveImage(last.candidate, blob);
          completed.push(`${last.candidate.candidate_id}.png`);
          localStorage.removeItem(`mirror:last-image-edit:${props.projectId}`); plan = next;
        } else issues.push(`${last.candidate.design_name}：旧的编辑版本已取到，请直接下载`);
      } catch (cause) { issues.push(`编辑图片：${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    const candidates = [...plan.role_sets, ...(plan.archived_role_sets ?? []), ...(originalPlan?.role_sets ?? []), ...(originalPlan?.archived_role_sets ?? [])].flatMap(s => s.candidates);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.candidate_id)) continue;
      seen.add(candidate.candidate_id);
      if (saved(candidate)) { alreadySaved++; continue; }
      let raw: unknown;
      try { raw = await recoverRelayTask(await cacheKey(candidate)); } catch {
        // Old paid responses used the unwrapped prompt; recovery stays read-only.
        try { raw = await recoverRelayTask(`image:${props.projectId}:${candidate.candidate_id}:${await fingerprint(candidate.reference_image_prompt)}`); } catch {
          const keys = [await cacheKey(candidate), `image:${props.projectId}:${candidate.candidate_id}:${await fingerprint(candidate.reference_image_prompt)}`];
          for (const key of keys) { const task = await relayTaskDiagnostic(key) as { status?: string }; if (task.status !== 'missing') trackedImageTask = true; }
          continue;
        }
      }
      trackedImageTask = true;
      try {
        const image = await imageFromResult(raw);
        ensureMounted();
        if (!plan.role_sets.some(set => set.candidates.some(item => item.candidate_id === candidate.candidate_id))) {
          retainImage(candidate, image);
          issues.push(`${candidate.design_name}：历史候选图片已取到，请直接下载`);
          continue;
        }
        await saveImage(candidate, image);
        completed.push(`${candidate.candidate_id}.png`);
      } catch (cause) { issues.push(`${candidate.design_name}：${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    setJob(j => j && ({ ...j, expectedCount: completed.length, completedImages: completed, message: `已恢复并保存 ${completed.length} 张图片。` }));
    if (issues.length) setError(`已恢复并保存 ${completed.length} 张图片。${issues.join('；')}。已取到但未保存的图片可直接下载，不需要重新生成。`);
    else if (!completed.length && !trackedImageTask && !lastRaw) {
      if (alreadySaved) setJob(j => j && ({ ...j, message: `已有 ${alreadySaved} 张参考图保存在项目中，没有新增图片需要恢复。` }));
      else setError('已有文字候选，但本机未找到生图提交记录。文字方案生成不会自动生图；请先选择候选，再生成这张参考图或上传图片。');
    } else if (!completed.length) setError('本机有生图任务记录，但没有新增的完整图片返回。请下载诊断核对，再凭请求 ID 和扣费记录向中转站查询，不要立即重新提交。');
  }, 'recovery');
  const regenerate = (candidate: CharacterCandidate, adjustments: string[], note: string) => begin(async () => {
    requireConnection('image');
    if (!props.proposals) throw new Error('请先生成角色方案。');
    const changes = [...adjustments, note.trim()].filter(Boolean).join('；');
    const nextCandidate = changes ? { ...candidate, reference_image_prompt: `${candidate.reference_image_prompt}\n最新外观微调（仅在不改变物种、身体结构和剧情动作的范围内优先）：${changes}`, appearance: `${candidate.appearance}\n外观微调（保持物种与身体结构）：${changes}`, wardrobe: `${candidate.wardrobe}\n外观微调（保持原有功能）：${changes}` } : candidate;
    const versionedCandidate = { ...nextCandidate, candidate_id: `${candidate.candidate_id}_v${crypto.randomUUID().slice(0, 8)}` };
    let source: Blob | undefined;
    if (changes) {
      const asset = props.referenceAssets.find(a => !a.retired && a.candidate_id === candidate.candidate_id && a.prompt === candidate.reference_image_prompt);
      if (asset) { const response = await fetch(asset.uri); if (!response.ok) throw new Error('读取当前参考图失败，未提交编辑请求。'); source = await response.blob(); }
    }
    const key = await cacheKey(versionedCandidate);
    localStorage.setItem(`mirror:last-image-edit:${props.projectId}`, JSON.stringify({ candidate: versionedCandidate, originalCandidateId: candidate.candidate_id, key }));
    setJob(j => j && ({ ...j, expectedCount: 1, targetCandidateId: candidate.candidate_id, message: `${candidate.design_name}：正在${source ? '编辑参考图' : '重新生成'}。` }));
    const image = await generateRelayImage(imagePrompt(nextCandidate), key, () => {}, source);
    ensureMounted();
    retainImage(versionedCandidate, image);
    await props.onSaveProposals({ ...props.proposals, archived_role_sets: [...(props.proposals.archived_role_sets ?? []), ...props.proposals.role_sets.filter(s => s.source_role_id === candidate.source_role_id)], role_sets: props.proposals.role_sets.map(s => ({ ...s, candidates: s.candidates.map(c => c.candidate_id === candidate.candidate_id ? versionedCandidate : c) })) });
    try { await saveImage(versionedCandidate, image); }
    catch (cause) { await props.onSaveProposals(props.proposals); throw cause; }
    localStorage.removeItem(`mirror:last-image-edit:${props.projectId}`);
    setJob(j => j && ({ ...j, completedImages: [`${candidate.candidate_id}.png`], progress: 100 }));
  });
  const downloadDiagnostic = async () => {
    try {
      if (job?.phase !== 'design' && props.proposals) {
        const candidates = [...props.proposals.role_sets, ...(props.proposals.archived_role_sets ?? [])].flatMap(set => set.candidates);
        const editRaw = localStorage.getItem(`mirror:last-image-edit:${props.projectId}`);
        const edit = editRaw ? JSON.parse(editRaw) as { candidate: CharacterCandidate; key: string } : null;
        if (edit && !candidates.some(candidate => candidate.candidate_id === edit.candidate.candidate_id)) candidates.push(edit.candidate);
        const seen = new Set<string>();
        const images = await Promise.all(candidates.filter(candidate => { if (seen.has(candidate.candidate_id)) return false; seen.add(candidate.candidate_id); return true; }).map(async candidate => {
          const currentKey = edit?.candidate.candidate_id === candidate.candidate_id ? edit.key : await cacheKey(candidate);
          let task = await relayTaskDiagnostic(currentKey) as { result?: unknown; status?: string; [key: string]: unknown };
          if (task.status === 'missing') task = await relayTaskDiagnostic(`image:${props.projectId}:${candidate.candidate_id}:${await fingerprint(candidate.reference_image_prompt)}`) as typeof task;
          const result = task.result as { data?: { b64_json?: string; url?: string }[] } | undefined;
          const metadata = { ...task };
          delete metadata.result;
          return { candidateId: candidate.candidate_id, saved: saved(candidate), task: metadata, resultFields: result && Object.keys(result), imageCount: result?.data?.length ?? 0, base64Length: result?.data?.[0]?.b64_json?.length ?? 0, hasImageUrl: Boolean(result?.data?.[0]?.url) };
        }));
        const connection = loadConnection('image');
        const pending = localStorage.getItem(`mirror:last-character-design:${props.projectId}`);
        const textKey = pending ? (JSON.parse(pending) as { key: string }).key : (await characterTask()).key;
        const textTask = await relayTaskDiagnostic(textKey) as { result?: unknown; [key: string]: unknown };
        const textMetadata = { ...textTask }; delete textMetadata.result;
        const textConnection = loadConnection('text');
        const characterDesign = { model: textConnection.model, protocol: textConnection.protocol, task: textMetadata, textLength: textFromResult(textTask.result).length };
        const diagnostic = JSON.stringify({ stage: 'character-images', projectId: props.projectId, model: connection.model, error, images, characterDesign }, null, 2);
        downloadText('image-relay-diagnostic.json', redactRelayError(redactRelayError(diagnostic, textConnection.apiKey, Infinity), connection.apiKey, Infinity), 'application/json');
        return;
      }
      const pending = localStorage.getItem(`mirror:last-character-design:${props.projectId}`);
      const key = pending ? (JSON.parse(pending) as { key: string }).key : (await characterTask()).key;
      const task = await relayTaskDiagnostic(key) as { result?: unknown };
      const connection = loadConnection('text');
      const diagnostic = JSON.stringify({ stage: 'character-design', projectId: props.projectId, model: connection.model, protocol: connection.protocol, expectedCandidates: wanted, error, text: textFromResult(task.result), task }, null, 2);
      downloadText('character-relay-diagnostic.json', redactRelayError(diagnostic, connection.apiKey, Infinity), 'application/json');
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return { job, error, setError, start, design, recover, regenerate, downloadDiagnostic, unsavedImages, downloadRecoveredImage };
}
