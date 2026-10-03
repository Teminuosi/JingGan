'use client';

import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  Copy,
  Dna,
  Download,
  FileJson,
  FileText,
  ImageIcon,
  LoaderCircle,
  PackageCheck,
  Play,
  RotateCcw,
  Pencil,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
  Video,
  VolumeX,
  WandSparkles,
  X,
  ZoomIn,
  Clapperboard,
} from 'lucide-react';
import { zipSync } from 'fflate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_ANALYSIS, DEMO_CREATIVE_PACK } from '../lib/demo-data';
import { compileCreativePrompts as compileNativeAudioPrompts } from '../lib/compiler';
import { analysisPreview, analyzeRelayVideo as analyzeVideo, supportedVideoMimeType } from '../lib/gemini';
import { ProductionSettingsDrawer } from './ProductionSettingsDrawer';
import { ConfirmHost } from './ConfirmHost';
import { BeatEditor } from './BeatEditor';
import { PipelineLauncher } from './PipelineLauncher';
import { roleForCandidate } from '../lib/role-design';
import { RoleDesignEditor } from './RoleDesignEditor';
import { AutoPrevisPanel } from './AutoPrevisPanel';
import { PrevisShots } from './PrevisShots';
import { FlowRail, type FlowStep } from './FlowRail';
import { StepShell } from './StepShell';
import { Drawer, Modal, overlayButton } from './Overlay';
import { CharacterTaskStatus } from './CharacterTaskStatus';
import { CharacterWorkspace } from './CharacterWorkspace';
import { loadConnection, recoverRelayTask, requireConnection, saveConnection } from '../lib/relay-client';
import { useRelayCharacters } from '../lib/use-relay-characters';
import { creativePackToMarkdown, downloadText, formatTime } from '../lib/export';
import type {
  AnalysisSettings,
  CharacterCandidate,
  CharacterProposals,
  CreativePack,
  LocalVideoMetadata,
  ProgressStage,
  ReferenceAsset,
  RemixBrief,
  SavedVideoProject,
  SavedVideoProjectSummary,
  VideoBeat,
  UsageStats,
  VideoDnaAnalysis,
} from '../lib/types';
import { DEFAULT_LOCKS, DEFAULT_SETTINGS } from '../lib/types';
import { parseReferenceDna, validateCompiledCreativePack, validateCompiledOriginalPack } from '../lib/validation';
import { createSilentVideo } from '../lib/video-prep';
import {
  normalizeVideoDnaEntityProfiles,
  resolveCharacterCastingEnvelope,
  resolveCharacterEntity,
  resolveSourceRoleCastingEnvelope,
  resolveSourceRoleEntity,
  castingDriftField,
  sameEntityProfile,
} from '../lib/entity-profile';
import { SettingsDialog } from './RelaySettingsDialog';
import { ReferenceImage } from './ReferenceImage';
import { RenderHelperCard } from './RenderHelperCard';
import { AccountMenu, useAccountConfig } from './AccountWorkspace';
import { accountFetch, accountStorageKey, allowLegacyProjectCache } from '../lib/account-client';
import { StoryPanel } from './StoryPanel';
import { OriginalOutputPanel } from './OriginalOutputPanel';
import { buildDraftPrompts, compileOriginalStory, isTextOnlyPack, ORIGINAL_WORKFLOW, projectPreservedDraft, withFullRunPrompt } from '../lib/original-story';
import { normalizeLanguage } from '../lib/dialogue-languages';
import { PromptTabs } from './PromptCopyPanel';

// 五步主轴。previs 是这次从「参考 DNA」里拆出来的独立一步——
// 它以前寄生在分析结果页里，用户根本找不到。
// pipeline 保留为出片步内部的一个出口，不再是并列的第五项。
type ActivePanel = 'dna' | 'remix' | 'characters' | 'previs' | 'output' | 'pipeline';

const SETTINGS_STORAGE_KEY = 'mirror-vibe:settings';
const LAST_PROJECT_STORAGE_KEY = 'mirror-vibe:last-project-id';
const MAX_FILE_BYTES = 1.9 * 1024 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_MODELS = new Set([
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
]);

const EMPTY_USAGE: UsageStats = {
  promptTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  totalTokens: 0,
};

const INITIAL_BRIEF: RemixBrief = {
  mode: 'character_swap',
  storyMode: 'preserve',
  workflow: ORIGINAL_WORKFLOW,
  sourceRightsScope: 'owned_or_authorized',
  newConcept: '',
  characterBrief: '',
  dialogueBrief: '创作自然的新对白，服务新故事和人物关系；不沿用原片台词。语言按下方“对白语言”的选择来写。对白可由我修改。',
  voiceBrief: '',
  settingBrief: '',
  targetModel: 'Seedance 2.5',
  aspectRatio: '9:16',
  outputLanguage: 'English',
  locks: { ...DEFAULT_LOCKS },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function referenceAssetForCandidate(
  assets: ReferenceAsset[],
  candidate: CharacterCandidate,
): ReferenceAsset | undefined {
  return assets
    .filter((asset) =>
      !asset.retired &&
      asset.character_id === candidate.character_id &&
      asset.candidate_id === candidate.candidate_id &&
      asset.prompt === candidate.reference_image_prompt,
    )
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .at(-1);
}

function storedSettings(): AnalysisSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(accountStorageKey(SETTINGS_STORAGE_KEY));
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AnalysisSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      model: parsed.model && SUPPORTED_MODELS.has(parsed.model) ? parsed.model : DEFAULT_SETTINGS.model,
      fps: DEFAULT_SETTINGS.fps,
      mediaResolution: DEFAULT_SETTINGS.mediaResolution,
      transcribeDialogue: DEFAULT_SETTINGS.transcribeDialogue,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function stageLabel(stage: ProgressStage | null): string {
  switch (stage) {
    case 'uploading':
      return '正在通过中转上传完整视频…';
    case 'processing':
      return 'Gemini 正在处理音画轨…';
    case 'analyzing':
      return '正在提取视频 DNA 与逐镜头证据…';
    case 'cleaning':
      return '正在删除 Gemini 临时文件…';
    case 'restoring':
      return '正在恢复本地项目记录…';
    case 'saving':
      return '正在保存项目记录…';
    case 'remixing':
      return '正在编译新故事、角色图与 Seedance 分段包…';
    case 'done':
      return '已完成';
    default:
      return '';
  }
}

function CopyButton({ text, label = '复制', prominent = false }: { text: string; label?: string; prominent?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className={prominent ? 'inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-300 to-[#d9c278] px-4 py-2.5 text-xs font-semibold text-[#082018]' : 'inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-white/[0.035] px-2.5 py-1.5 text-[10px] text-white/45 transition hover:border-emerald-200/20 hover:text-white/75'}
    >
      {copied ? <Check size={12} className="text-emerald-300" /> : <Copy size={12} />}
      {copied ? '已复制' : label}
    </button>
  );
}

const CHARACTER_TUNING_OPTIONS = ['五官更精致', '发型更准确', '服装更合适', '体型比例更自然', '年龄气质更贴合', '表情更自然', '转面布局更清楚'] as const;

function PillList({ items, tone = 'green' }: { items: string[]; tone?: 'green' | 'gold' | 'neutral' }) {
  const toneClass =
    tone === 'gold'
      ? 'border-[#d9b76c]/16 bg-[#d9b76c]/[0.07] text-[#e8cb8a]/70'
      : tone === 'neutral'
        ? 'border-white/8 bg-white/[0.03] text-white/45'
        : 'border-emerald-200/13 bg-emerald-300/[0.055] text-emerald-100/60';
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className={`rounded-full border px-2.5 py-1 text-[10px] leading-4 ${toneClass}`}>
          {item}
        </span>
      ))}
    </div>
  );
}

function SectionTitle({ eyebrow, title, note }: { eyebrow: string; title: string; note?: string }) {
  return (
    <div>
      <p className="text-[9px] font-semibold tracking-[0.18em] text-emerald-200/42">{eyebrow}</p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight text-white/90">{title}</h2>
        {note && <p className="text-[10px] text-white/30">{note}</p>}
      </div>
    </div>
  );
}

function DnaPanel({ analysis, brief, onEditBeat, onContinue, busy }: { analysis: VideoDnaAnalysis; brief: RemixBrief; onEditBeat?: (beat: VideoBeat) => void; onContinue: () => void; busy: boolean }) {
  const dna = analysis.style_dna;
  // 拆解页的提示词就是原片原样：剧情、镜头、动作、时长、台词都照原片，台词保持原片语言。
  let replica: ReturnType<typeof buildDraftPrompts> | undefined;
  let replicaError = '';
  try { replica = buildDraftPrompts(projectPreservedDraft(analysis), analysis, { ...brief, storyMode: 'preserve', translateDialogue: true, outputLanguage: normalizeLanguage(analysis.source.language) }); }
  catch (error) { replicaError = error instanceof Error ? error.message : String(error); }
  return (
    <StepShell title="拆解原片" intent="分析已完成。核对原片内容后，继续选择保留剧情或改写新故事。" status="分析完成" action={<div className="flex flex-wrap items-center gap-4"><button type="button" disabled={busy} onClick={onContinue} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-emerald-300 px-6 py-3 text-sm font-semibold text-[#062018] disabled:opacity-40">下一步：改编故事<ChevronRight size={16} /></button><p className="text-sm text-white/60">无需逐段确认，之后仍可返回查看和修正。</p></div>}>
      <section className="mb-8 flex flex-wrap items-start justify-between gap-5 border-b border-white/10 pb-6">
        <div className="min-w-0 flex-1"><p className="text-xs text-emerald-200">原片概览</p><h3 className="mt-2 max-w-[60ch] text-xl font-semibold leading-8 text-white/90">{analysis.source.one_line_summary}</h3></div>
        <dl className="flex shrink-0 gap-6 text-sm"><div><dt className="text-xs text-white/50">时长</dt><dd className="mt-2 font-medium text-white/85">{formatTime(analysis.source.duration_seconds)}</dd></div><div><dt className="text-xs text-white/50">画幅</dt><dd className="mt-2 font-medium text-white/85">{analysis.source.aspect_ratio}</dd></div><div><dt className="text-xs text-white/50">分析段落</dt><dd className="mt-2 font-medium text-white/85">{analysis.beats.length} 段</dd></div></dl>
      </section>
      <div className="mb-8"><PromptTabs prompts={replica} error={replicaError} /></div>
      <div className="space-y-8">
        <details className="rounded-xl border border-white/10 px-5">
          <summary className="cursor-pointer py-4 text-sm font-medium text-white/85">拍摄风格与改编建议<span className="ml-3 text-xs font-normal text-white/55">展开查看六个风格维度及建议</span></summary>
          <div className="space-y-6 pb-5">
          <section>
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
              {[
                { title: '开场与叙事', text: dna.hook_pattern, tags: dna.narrative_arc },
                { title: '剪辑节奏', text: dna.pacing.description, tags: dna.pacing.energy_curve },
                { title: '景别与运镜', text: dna.cinematography.lens_feel, tags: [...dna.cinematography.framing_pattern, ...dna.cinematography.camera_motion_pattern] },
                { title: '画面与光色', text: dna.visual.lighting_logic, tags: dna.visual.palette },
                { title: '角色表演', text: dna.performance.energy, tags: [dna.performance.gesture_language] },
                { title: '音乐与音效', text: dna.audio.music_logic, tags: dna.audio.sound_effects },
              ].map(card => <details key={card.title} className="py-1"><summary className="cursor-pointer py-3 text-sm font-medium text-white/85">{card.title}<span className="mt-2 block text-sm font-normal leading-6 text-white/60">{card.text}</span></summary><ul className="list-disc space-y-2 pb-4 pl-5 text-sm leading-6 text-white/65">{card.tags.map((tag, i) => <li key={i}>{tag}</li>)}</ul></details>)}
            </div>
          </section>
          <details className="rounded-xl border border-white/10 px-4"><summary className="min-h-12 cursor-pointer py-4 text-sm text-white/75">改编建议与分析信息</summary><div className="space-y-4 pb-5 text-sm leading-6 text-white/65"><p>这些是原片分析建议，角色身份、性别和物种可以在角色页自行设定。</p><div><h4 className="mb-2 font-medium text-emerald-100">建议保留</h4><ul className="list-disc space-y-1 pl-5">{analysis.preserve_recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul></div><div><h4 className="mb-2 font-medium text-amber-100">建议调整</h4><ul className="list-disc space-y-1 pl-5">{analysis.replace_recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul></div><p className="break-words text-xs text-white/50">分析类型：{analysis.source.format_type}</p></div></details>
        </div>
        </details>
        <section className="min-w-0">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3"><h3 className="text-base font-semibold text-white/90">原片时间线 · {analysis.beats.length} 个分析段落</h3><p className="text-xs text-white/55">按时间顺序展开核对细节；一个段落可能包含多个镜头。</p></div>
          <div className="space-y-3">
            {analysis.beats.map((beat, index) => <details key={beat.beat_id} className="rounded-xl border border-white/10 bg-white/[0.02]">
              <summary className="flex cursor-pointer list-none items-start gap-4 p-5 [&::-webkit-details-marker]:hidden">
                <span className="shrink-0 text-lg font-medium tabular-nums text-emerald-200">{String(index + 1).padStart(2, '0')}</span>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h4 className="text-sm font-semibold text-white/90">{beat.narrative_function}</h4><span className="text-xs tabular-nums text-white/55">{formatTime(beat.start_seconds)}–{formatTime(beat.end_seconds)}</span>{beat.corrected_by_user && <span className="text-xs text-emerald-200">已修正</span>}</div><p className="mt-2 line-clamp-2 text-sm leading-6 text-white/65">{beat.visual_action}</p></div><span aria-hidden="true" className="text-white/50">⌄</span>
              </summary>
              <div className="space-y-5 border-t border-white/10 px-5 py-5 sm:pl-14">
                <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-white/55">{beat.beat_id} · {beat.transition_in} · 分析置信度 {Math.round(beat.confidence * 100)}%</p>{onEditBeat && <button type="button" onClick={() => onEditBeat(beat)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-200/25 px-4 py-2 text-sm text-emerald-100"><Pencil size={14} />修正这一段</button>}</div>
                <p className="text-sm leading-7 text-white/80">{beat.visual_action}</p>
                {!!beat.action_beats?.length && <div><h5 className="mb-3 text-sm font-medium text-white/85">动作顺序</h5><ol className="space-y-3 border-l border-emerald-200/20 pl-4 text-sm leading-6 text-white/65">{beat.action_beats.map((step, n) => <li key={n}><span className="mr-2 tabular-nums text-emerald-200">{step.at_seconds}s</span>{[step.actor_ids.join('、'), step.action].filter(Boolean).join(' ')}{step.toward_ids?.length ? ` → ${step.toward_ids.join('、')}` : ''}{step.reaction ? `｜${step.reaction}` : ''}{step.consequence ? `｜${step.consequence}` : ''}</li>)}</ol></div>}
                <dl className="grid gap-4 text-sm leading-6 sm:grid-cols-2">
                  {([['场景', beat.environment || beat.composition], ['道具', (beat.props ?? []).join('、') || '未单独识别'], ['镜头', `${beat.framing}，${beat.camera_motion}`], ['光色', beat.lighting], ['声音', beat.sound]]).map(([label, value]) => <div key={label}><dt className="text-xs text-white/50">{label}</dt><dd className="mt-1 text-white/75">{value}</dd></div>)}
                </dl>
                {beat.dialogue.source_text && <blockquote className="border-l-2 border-amber-200/35 pl-4 text-sm leading-7 text-amber-100/85">“{beat.dialogue.source_text}”<span className="ml-2 text-xs text-white/55">{beat.dialogue.delivery}</span></blockquote>}
              </div>
            </details>)}
          </div>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6"><p className="text-sm text-white/60">看完分析了？下一步选择故事方向，再设计角色。</p><button type="button" disabled={busy} onClick={onContinue} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-emerald-300 px-6 py-3 text-sm font-semibold text-[#062018] disabled:opacity-40">下一步：改编故事<ChevronRight size={16} /></button></div>
      </div>
    </StepShell>
  );
}

function CharactersPanel({
  analysis,
  brief,
  projectId,
  proposals,
  selections,
  referenceAssets,
  onSaveProposals,
  onSaveImage,
  onBusy,
  onSelect,
  onUploadReference,
  onApproveReference,
  onDiscardReference,
  onGoPrevis,
  onBriefChange,
  onOpenSettings,
  busy,
  error,
}: {
  analysis: VideoDnaAnalysis;
  brief: RemixBrief;
  projectId: string;
  onOpenSettings: () => void;
  proposals: CharacterProposals | null;
  selections: Record<string, string>;
  referenceAssets: ReferenceAsset[];
  onSaveProposals: (value: CharacterProposals) => Promise<void>;
  onSaveImage: (candidate: CharacterCandidate, image: Blob) => Promise<void>;
  /** 角色齐了之后往下走一步。这里不直接导出——导出跳过了第④步预演。 */
  onGoPrevis: () => void;
  onBusy: (value: boolean) => void;
  onSelect: (sourceRoleId: string, candidateId: string) => void;
  onUploadReference: (candidate: CharacterCandidate, file: File) => void;
  onApproveReference: (candidate: CharacterCandidate) => void;
  onDiscardReference: (candidate: CharacterCandidate) => void;
  onBriefChange: (value: RemixBrief) => void;
  busy: boolean;
  progress: ProgressStage | null;
  error: string;
}) {
  // 报错框在面板顶上，按钮在下面：一出错就把报错滚到眼前。
  const bridgeBox = useRef<HTMLDivElement>(null);
  const missingModels = [
    !(() => { const c = loadConnection('text'); return c.apiKey && c.model; })() ? '「故事与角色设计」' : '',
    !(() => { const c = loadConnection('image'); return c.apiKey && c.model; })() ? '「生图」' : '',
  ].filter(Boolean);
  const { job: bridgeJob, error: bridgeError, setError: setBridgeError, start: startCodexDesign, design: designCharacters, recover: recoverLatestCodexResult, regenerate, downloadDiagnostic, unsavedImages, downloadRecoveredImage, partialText, downloadPartialText } = useRelayCharacters({ analysis, brief, projectId, proposals, referenceAssets, onSaveProposals, onSaveImage, onBusy });
  useEffect(() => { if (bridgeError) bridgeBox.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [bridgeError]);
  // 点了哪张就在哪张下面说进度和结果：顶上的提示框离按钮太远，点完看不到就以为没反应。
  const [lastImageCandidate, setLastImageCandidate] = useState('');
  const imageStatusText: Record<string, string> = { queued: '排队中', processing: '正在生成图片，通常要一两分钟，请别关页面', saving: '图片已返回，正在保存', saved: '已保存', save_failed: '图片已返回但保存失败，结果已缓存，点顶上「检查已缓存结果」找回', unconfirmed: '提交后没收到完整结果，可能已扣费，先点顶上「检查已缓存结果」，别重复点', failed: '这次没有生成出来，原因见上方提示；等一会儿可以直接再点', not_submitted: '未提交' };
  const [previewImage, setPreviewImage] = useState<{ asset: ReferenceAsset; candidate: CharacterCandidate } | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  // 改参考图提示词：写回 proposals 即可，图与候选是靠 prompt 相等来配对的，
  // 词一改旧图自然不再匹配，界面会退回“待生成”，这正是我们要的效果，不用额外去清理资产。
  const savePrompt = async (candidate: CharacterCandidate, value: string) => {
    const next = value.trim();
    if (!proposals || !next || next === candidate.reference_image_prompt) return;
    await onSaveProposals({
      ...proposals,
      archived_role_sets: [...(proposals.archived_role_sets ?? []), ...proposals.role_sets.filter(s => s.source_role_id === candidate.source_role_id)],
      role_sets: proposals.role_sets.map((set) => ({
        ...set,
        candidates: set.candidates.map((item) => item.candidate_id === candidate.candidate_id ? { ...item, reference_image_prompt: next } : item),
      })),
    });
  };
  const [tuningCandidate, setTuningCandidate] = useState<CharacterCandidate | null>(null);
  const [tuningOptions, setTuningOptions] = useState<string[]>([]);
  const [tuningNote, setTuningNote] = useState('');
  const selectedCharacters = analysis.source_roles.map((role) => proposals?.role_sets.find((set) => set.source_role_id === role.role_id)?.candidates.find((candidate) => candidate.candidate_id === selections[role.role_id])).filter((candidate): candidate is CharacterCandidate => Boolean(candidate));
  const selectedDownloadable = selectedCharacters.map((candidate) => ({ candidate, asset: referenceAssetForCandidate(referenceAssets, candidate) })).filter((item): item is { candidate: CharacterCandidate; asset: ReferenceAsset } => Boolean(item.asset));
  const allSelectedImagesReady = selectedCharacters.length === analysis.source_roles.length && selectedDownloadable.length === analysis.source_roles.length;
  const downloadAllReferences = async () => {
    if (!allSelectedImagesReady || downloadingAll) return;
    setDownloadingAll(true);
    setBridgeError('');
    try {
      const files: Record<string, Uint8Array> = {};
      for (const { candidate, asset } of selectedDownloadable) {
        const response = await accountFetch(asset.uri, { cache: 'no-store' });
        if (!response.ok) throw new Error(`下载 ${candidate.design_name} 失败。`);
        const safeName = candidate.design_name.replace(/[\\/:*?"<>|]/g, '-');
        files[`${candidate.candidate_id}-${safeName}.${imageExtension(asset.mime_type)}`] = new Uint8Array(await response.arrayBuffer());
      }
      const archive = zipSync(files, { level: 0 });
      const url = URL.createObjectURL(new Blob([new Uint8Array(archive)], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `已选角色参考图-${projectId.slice(0, 8)}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setBridgeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloadingAll(false);
    }
  };

  useEffect(() => {
    if (!previewImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [previewImage]);

  const startCandidateRegeneration = async (candidate: CharacterCandidate, adjustments: string[], note: string) => {
    setTuningCandidate(null);
    await regenerate(candidate, adjustments, note);
  };

  const chosenCount = selectedCharacters.filter((candidate) => referenceAssetForCandidate(referenceAssets, candidate)?.approved).length;
  const roleCount = analysis.source_roles.length;
  return (
    <StepShell
      title="设计角色"
      intent="逐个选择角色，生成或上传参考图，确认采用后继续分镜预演。"
      meta={proposals
        ? `${proposals.role_sets.length}/${roleCount} 个角色已有文字方案`
        : `${roleCount} 个角色 · 先设计候选，再生成图片`}
      status={`${chosenCount}/${roleCount} 参考图已确认`}
      tuning={
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void downloadDiagnostic()} disabled={busy || !projectId} className="min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm text-white/65 disabled:opacity-40">下载角色返回诊断</button>
            <button type="button" onClick={() => void downloadAllReferences()} disabled={busy || downloadingAll || !allSelectedImagesReady} className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-xs text-white/55 disabled:opacity-35">{downloadingAll ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}{downloadingAll ? '正在打包…' : `下载已选角色图片 ${selectedDownloadable.length}/${roleCount}`}</button>
          </div>
          <p className="max-w-[52ch] text-[11px] leading-5 text-white/30">这一步用两个模型：文本模型出形象方案，生图模型出参考图，都走中转 API，可在右上角设置里分别更换。</p>
        </div>
      }
    >
      {/* 中转的进度与报错是真信息，必须留在产物区第一眼能看到的位置。
          出错时给「下载诊断」而不是只说一句失败——那一份是定位问题的唯一凭据。 */}
      {/* 角色这一步要用「故事与角色设计」和「生图」两个模型。没配就先说清楚，别等点了按钮才在看不见的地方报错。 */}
      {missingModels.length > 0 && <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/30 bg-amber-300/[0.06] px-5 py-4 text-sm leading-6 text-amber-50">
        <span>还没配置{missingModels.join('和')}模型，这一步的生成按钮点了会失败。先到「AI 服务设置」填好 Key 并选模型。</span>
        <button type="button" onClick={onOpenSettings} className="min-h-10 rounded-lg border border-amber-200/40 px-4 text-sm text-amber-50 hover:bg-amber-200/10">打开 AI 服务设置</button>
      </div>}
      {(bridgeJob || bridgeError) && (
        <div ref={bridgeBox} className={`mb-6 rounded-xl border px-5 py-4 text-sm leading-6 ${bridgeError ? 'border-red-300/12 bg-red-300/[0.045] text-red-100/70' : bridgeJob?.status === 'completed' ? 'border-emerald-300/15 bg-emerald-300/[0.06] text-emerald-100/70' : 'border-white/8 bg-black/15 text-white/45'}`}>
          {bridgeError && <p className="mb-2 text-sm font-semibold text-amber-100">本次任务未完整确认</p>}{bridgeError || bridgeJob?.message}
          {bridgeError && (
            // 出错时要用的东西必须就在错误旁边。「恢复中转结果」虽然也在「调整」里，
            // 但让人在报错之后自己去翻抽屉找回退路，等于没给回退路。
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void recoverLatestCodexResult()} disabled={busy || !projectId} className="rounded-lg border border-white/15 px-3 py-2 text-xs disabled:opacity-35">检查已缓存结果（不重新生成）</button>
              <button type="button" onClick={() => void downloadDiagnostic()} className="rounded-lg border border-white/15 px-3 py-2 text-xs">下载角色返回诊断</button>
            </div>
          )}
          {bridgeJob && !bridgeError && <CharacterTaskStatus job={bridgeJob} />}
        </div>
      )}

      {partialText && <div className="mb-6 space-y-3 rounded-xl border border-amber-200/20 bg-amber-200/5 p-5"><p className="text-sm text-amber-100">已保留中断前收到的文字草稿（{partialText.length.toLocaleString()} 字符）。草稿未完整校验，不能作为已完成候选，也尚未生成图片。</p><button type="button" onClick={downloadPartialText} className="min-h-11 rounded-lg border border-amber-200/25 px-4 py-2 text-sm text-amber-100">下载未完成文字草稿（不扣费）</button></div>}
      {unsavedImages.length > 0 && <div className="mb-6 space-y-3 rounded-xl border border-amber-200/20 bg-amber-200/5 p-5"><p className="text-sm text-amber-100">已取到 {unsavedImages.length} 张图片，但项目保存未完成。可先直接下载，再找回结果保存；无需重新生成。</p><div className="flex flex-wrap gap-2">{unsavedImages.map(({ candidate }) => <button key={candidate.candidate_id} type="button" onClick={() => downloadRecoveredImage(candidate.candidate_id)} className="min-h-11 rounded-lg border border-amber-200/25 px-4 py-2 text-sm text-amber-100">下载：{candidate.design_name}</button>)}</div></div>}
      {copyNotice && <p role="status" className="mb-4 text-sm text-emerald-100">{copyNotice}</p>}
      {!busy && error && <p role="alert" className="mb-4 text-sm text-red-100">{error}</p>}
      <CharacterWorkspace key={projectId} analysis={analysis} proposals={proposals} selections={selections} referenceAssets={referenceAssets} busy={busy || !projectId} job={bridgeJob} onGenerate={candidates => void startCodexDesign(candidates)} onDesignAll={() => void designCharacters()} onGoPrevis={onGoPrevis} renderSettings={(roleId, showCandidates) => <RoleDesignEditor analysis={analysis} brief={brief} activeRoleId={roleId} busy={busy || !projectId} onChange={onBriefChange} onDesign={id => { showCandidates(); void designCharacters(id); }} />}>
      {(activeRoleId) => !proposals?.role_sets.some(s => s.source_role_id === activeRoleId) ? (

        <div className="rounded-2xl border border-dashed border-white/9 bg-white/[0.018] p-8 text-center">
          <Users size={24} className="mx-auto text-white/25" />
          <p className="mt-3 text-base font-medium text-white/80">{bridgeJob?.status === 'running' ? '正在设计角色候选…' : bridgeError ? '本页未收到可用方案，生成状态待核实' : '还没有角色方案'}</p>
          <p className="mt-1.5 text-xs text-white/55">方案生成后先选候选，可编辑提示词，再生成或上传图片。</p>
        </div>
      ) : (
        proposals.role_sets.filter(s => s.source_role_id === activeRoleId).map((roleSet) => {
          const selectedId = selections[roleSet.source_role_id];
          const selected = roleSet.candidates.find((candidate) => candidate.candidate_id === selectedId);
          const asset = selected ? referenceAssetForCandidate(referenceAssets, selected) : undefined;
          const generatedCount = roleSet.candidates.filter((candidate) => referenceAssetForCandidate(referenceAssets, candidate)).length;
          return (
            <section id={roleSet === proposals?.role_sets[0] ? 'role-reference-candidates' : undefined} key={roleSet.source_role_id} className="scroll-mt-48">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-white/60">选择一个候选，生成或上传参考图，再确认采用。</p>
                <button type="button" disabled={busy || generatedCount === roleSet.candidates.length} onClick={() => void startCodexDesign(roleSet.candidates)} className="min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm text-emerald-100 disabled:opacity-40">{generatedCount === roleSet.candidates.length ? '本角色图片已齐' : `生成本角色缺图（${roleSet.candidates.length - generatedCount} 张 · 生图计费）`}</button>
              </div>
              <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
                {roleSet.candidates.map((candidate, candidateIndex) => {
                  const active = candidate.candidate_id === selectedId;
                  const candidateAsset = referenceAssetForCandidate(referenceAssets, candidate);
                  const generatedInJob = bridgeJob?.completedImages?.includes(`${candidate.candidate_id}.png`);
                  const imageTaskForCandidate = bridgeJob?.phase === 'images' && bridgeJob.targetCandidateId === candidate.candidate_id;
                  const generatingNow = bridgeJob?.status === 'running' && imageTaskForCandidate;
                  const queueState = bridgeJob?.imageQueue?.find(item => item.candidateId === candidate.candidate_id)?.status;
                  // 上游明确说失败（如限流）不算「结果未确认」：没出图、按常理没扣费，可以直接再点。
                  const imageUnconfirmed = bridgeJob?.status === 'failed' && imageTaskForCandidate && queueState !== 'failed';
                  return (
                    <article key={candidate.candidate_id} className={`min-w-0 rounded-xl border p-4 ${active ? 'border-emerald-300/40 bg-emerald-300/[0.06]' : 'border-white/12 bg-white/[0.02]'}`}>
                      <div className="grid min-w-0 gap-4">
                        {candidateAsset ? (
                          <span role="button" tabIndex={0} title="点击放大" onClick={(event) => { event.stopPropagation(); setPreviewImage({ asset: candidateAsset, candidate }); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); setPreviewImage({ asset: candidateAsset, candidate }); } }} className="group relative block cursor-zoom-in overflow-hidden rounded-xl">
                            <ReferenceImage key={candidateAsset.uri} src={candidateAsset.uri} alt={`${candidate.design_name} 候选参考图`} width={720} height={960} unoptimized className="aspect-[3/4] max-h-[420px] w-full bg-black/20 object-contain transition group-hover:scale-[1.02]" />
                            <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white/75 opacity-0 transition group-hover:opacity-100"><ZoomIn size={14} /></span>
                          </span>
                        ) : (
                          <div className="flex aspect-[3/4] max-h-[420px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/15 px-3 text-center">
                            {generatingNow ? <LoaderCircle size={22} className="animate-spin text-emerald-200/55" /> : <ImageIcon size={22} className="text-white/18" />}
                            <p className={`mt-3 text-sm ${generatedInJob ? 'text-emerald-200/70' : generatingNow || imageUnconfirmed ? 'text-amber-100/75' : 'text-white/60'}`}>{generatedInJob ? '图片已保存，正在加载' : generatingNow ? '正在处理参考图' : queueState === 'save_failed' ? '图片已返回，待保存' : imageUnconfirmed ? '图片结果未确认' : queueState === 'queued' ? '等待提交' : queueState === 'not_submitted' ? '尚未提交' : '暂无参考图'}</p>
                            <p className="mt-2 text-xs leading-5 text-white/45">{generatingNow ? '检查缓存或等待模型返回；完成后立即保存。' : queueState === 'save_failed' ? '请直接下载已返回图片或恢复保存，无需重新生成。' : imageUnconfirmed ? '先找回已返回图片或下载诊断，请勿立即重复提交。' : generatedInJob ? '如果未显示，请先找回结果。' : '文字候选已完成。点击选择后生成这张参考图，或上传自己的图片。'}</p>
                          </div>
                        )}
                        <div>
                          <div className="flex items-center justify-between gap-3"><h4 className="text-base font-semibold text-white/85">候选 {candidateIndex + 1}</h4><span className="text-xs text-emerald-100">{active ? '已选择' : candidateAsset ? '图片已保存' : '待生图'}</span></div>
                          <p className="mt-2 text-sm text-white/60">{candidate.design_mode === 'style_variant' ? '风格变体' : candidate.design_settings && Object.values(candidate.design_settings).some(Boolean) ? '按你的设定设计' : '原片相近设计'}</p>
                          <button type="button" disabled={busy} onClick={() => onSelect(roleSet.source_role_id, candidate.candidate_id)} className={`mt-3 min-h-11 w-full rounded-lg border text-sm disabled:opacity-40 ${active ? 'border-emerald-200/35 text-emerald-100' : 'border-white/20 text-white/85'}`}>{active ? '已选此候选' : `选择候选 ${candidateIndex + 1}`}</button>
                          {active && candidateAsset && <div className="mt-2">{candidateAsset.approved ? <p className="py-2 text-sm text-emerald-200">已确认采用</p> : <button type="button" disabled={busy} onClick={() => onApproveReference(candidate)} className="min-h-11 w-full rounded-lg bg-emerald-300 px-4 text-sm font-semibold text-[#082018] disabled:opacity-40">确认采用此图</button>}</div>}
                          {!candidateAsset && <div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" disabled={busy} onClick={() => { onSelect(roleSet.source_role_id, candidate.candidate_id); setLastImageCandidate(candidate.candidate_id); void startCodexDesign([candidate]); }} className="min-h-11 rounded-lg bg-emerald-300 px-3 text-sm font-medium text-[#082018] disabled:opacity-40">生成此候选（生图计费）</button><label className={`inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-white/15 px-3 text-sm text-white/70 ${busy ? 'pointer-events-none opacity-40' : ''}`}>上传图片<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) { onSelect(roleSet.source_role_id, candidate.candidate_id); onUploadReference(candidate, file); } event.currentTarget.value = ''; }} /></label></div>}{lastImageCandidate === candidate.candidate_id && (() => { const queued = bridgeJob?.imageQueue?.find(item => item.candidateId === candidate.candidate_id); const failed = bridgeJob?.status === 'failed' || (!!bridgeError && !queued); return <p role="status" aria-live="polite" className={`mt-2 text-xs leading-5 ${failed ? 'text-amber-100' : 'text-emerald-100/80'}`}>{failed && bridgeError ? bridgeError : queued ? imageStatusText[queued.status] : bridgeJob?.status === 'running' ? bridgeJob.message : bridgeJob?.status === 'completed' ? '这一次没有新生成图片。' : '已点击，正在准备…'}</p>; })()}
                          <details className="mt-3 text-sm text-white/60"><summary className="min-h-11 cursor-pointer py-3">设计说明与完整信息</summary><p className="mt-2 font-medium text-white/80">{candidate.design_name}</p><p className="mt-2 leading-6">{candidate.design_rationale}</p><p className="mt-2 leading-6">{candidate.appearance}</p><p className="mt-3 break-all text-xs text-white/40">{candidate.candidate_id}</p><div className="mt-3"><PillList items={candidate.identity_anchors} /></div></details>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {selected && (
                <div className="mt-5 rounded-xl border border-emerald-200/20 bg-emerald-300/[0.035] p-4">
                  <div className="flex min-w-0 flex-col justify-between py-1">
                    <div>
                      <p className="text-base font-medium text-emerald-100">当前选择：候选 {roleSet.candidates.indexOf(selected) + 1}</p>
                      {asset && (
                        <p className={`mt-3 text-[10px] ${asset.approved && !asset.uri.startsWith('data:') ? 'text-emerald-200/60' : 'text-[#e8cb8a]/60'}`}>
                          {asset.uri.startsWith('data:') ? (asset.approved ? '已在本次会话确认；请立即下载，刷新后无法恢复' : '仅本地预览：请确认并立即下载，刷新后无法恢复') : asset.approved ? '已确认并锁定为 Seedance 角色参考' : '图片已保存，请确认形象后再生成最终包'}
                        </p>
                      )}
                      {/* 提示词可改：图不满意时改词比反复重抽便宜得多，也更可控。 */}
                      <details className="mt-3 text-sm text-white/65"><summary className="min-h-11 cursor-pointer py-3">编辑 / 复制生图提示词</summary>
                        <textarea
                          className="mt-2 min-h-28 w-full rounded-lg border border-white/12 bg-[#07120f] p-2.5 text-[10px] leading-5 text-white/70"
                          key={`${selected.candidate_id}:${selected.reference_image_prompt}`}
                          defaultValue={selected.reference_image_prompt}
                          disabled={busy}
                          onBlur={(event) => void savePrompt(selected, event.target.value).catch(cause => setBridgeError(cause instanceof Error ? cause.message : String(cause)))}
                        />
                        <p className="mt-1 text-xs leading-6 text-white/55">移开焦点后保存，不会自动生图。旧方案和图片保留在下方历史记录。更换性别、物种或身体结构请使用上方角色设定，再设计新方案。</p>
                        <button type="button" className="min-h-11 text-sm text-emerald-200" onClick={async event => { const value = event.currentTarget.closest('details')?.querySelector('textarea')?.value || selected.reference_image_prompt; try { await navigator.clipboard.writeText(value); setCopyNotice('生图提示词已复制，可到其他工具修改并生成，随后上传参考图。'); } catch { setCopyNotice('无法自动复制，请在文本框中手动选中复制。'); } }}>复制生图提示词</button>
                      </details>
                    </div>
                    <div className="mt-5 flex flex-wrap gap-2">
                      {!asset && <button type="button" onClick={() => void startCodexDesign([selected])} disabled={busy} className="min-h-11 rounded-xl bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-[#082018] disabled:opacity-40">生成这张参考图（生图计费）</button>}
                      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/9 px-3 py-2.5 text-[10px] text-white/50 ${busy ? 'pointer-events-none opacity-40' : ''}`}>
                        <UploadCloud size={12} /> 上传参考图（可选）
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          disabled={busy}
                          onChange={(event) => {
                            const nextFile = event.currentTarget.files?.[0];
                            if (nextFile) onUploadReference(selected, nextFile);
                            event.currentTarget.value = '';
                          }}
                        />
                      </label>
                      {asset && !asset.approved && (
                        <button type="button" onClick={() => onDiscardReference(selected)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl border border-white/9 px-3 py-2.5 text-[10px] text-white/45 disabled:opacity-40"><RotateCcw size={12} /> 放弃这张</button>
                      )}
                      {asset && <a href={asset.uri} download={`${selected.character_id}-reference.${imageExtension(asset.mime_type)}`} className="inline-flex items-center gap-1.5 rounded-xl border border-white/9 px-3 py-2.5 text-[10px] text-white/50"><Download size={12} /> 下载</a>}
                      <button type="button" onClick={() => { setTuningCandidate(selected); setTuningOptions([]); setTuningNote(''); }} disabled={busy || bridgeJob?.status === 'running'} className="inline-flex items-center gap-1.5 rounded-xl border border-[#d9b76c]/20 bg-[#d9b76c]/[0.06] px-3 py-2.5 text-[10px] text-[#e8cb8a]/70 disabled:opacity-40"><Sparkles size={12} /> 微调 / 重新生成</button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          );
        })
      )}
      </CharacterWorkspace>
      <details className="mt-6 border-t border-white/10 pt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm text-white/65">图片恢复与诊断（不调用模型）</summary><p className="mb-3 text-xs leading-6 text-white/55">检查当前浏览器、当前账号的缓存，只恢复已返回图片。已扣费但没有结果时先检查，不要重复提交。</p><button type="button" disabled={busy || !projectId} onClick={() => void recoverLatestCodexResult()} className="min-h-11 rounded-lg border border-white/15 px-4 text-sm text-emerald-100 disabled:opacity-40">找回已返回图片（不扣费）</button></details>
      {!!proposals?.archived_role_sets?.length && <details className="my-6 border-y border-white/10 py-3"><summary className="min-h-11 cursor-pointer py-3 text-sm text-white/70">历史角色方案与图片 · {proposals.archived_role_sets.length} 组</summary><p className="mb-4 text-xs leading-6 text-white/55">重新设计或修改提示词不会删除旧图。可下载旧图，或恢复一整组候选，再选择要采用的角色。</p><div className="space-y-5">{proposals.archived_role_sets.map((group, index) => <section key={`${group.source_role_id}-${index}`} className="rounded-xl border border-white/10 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm">{group.role_function} · 历史方案 {index + 1}</p><button type="button" disabled={busy} className="min-h-11 px-3 text-sm text-emerald-200 disabled:opacity-40" onClick={async () => { try { await onSaveProposals({ ...proposals, role_sets: analysis.source_roles.flatMap(r => r.role_id === group.source_role_id ? group : proposals.role_sets.find(s => s.source_role_id === r.role_id) ?? []), archived_role_sets: [...proposals.archived_role_sets!.filter((_, i) => i !== index), ...proposals.role_sets.filter(s => s.source_role_id === group.source_role_id)] }); } catch (cause) { setBridgeError(cause instanceof Error ? cause.message : String(cause)); } }}>恢复这组方案</button></div><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{group.candidates.map(c => { const old = referenceAssetForCandidate(referenceAssets, c); return <div key={c.candidate_id} className="min-w-0">{old && <a href={old.uri} download={`${c.candidate_id}.${imageExtension(old.mime_type)}`}><ReferenceImage key={old.uri} src={old.uri} alt={`${c.design_name} 历史图片`} width={180} height={240} unoptimized className="aspect-[3/4] w-full rounded-lg object-cover" /></a>}<p className="mt-2 text-xs leading-5 text-white/65">{c.design_name} · {old ? '点击图片下载' : '无已保存图片'}</p></div>; })}</div></section>)}</div></details>}
      {/* 看图用的灯箱：故意不套 Modal 的面板外壳，套上去图就被挤小了。
          但遮罩色与模糊跟其它弹层一致；层级比弹窗高一层，因为它可能从弹窗里打开。 */}
      {previewImage && (
        <div role="dialog" aria-modal="true" aria-label={`${previewImage.candidate.design_name} 大图预览`} onClick={() => setPreviewImage(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-[#040b09]/92 p-4 backdrop-blur-sm sm:p-8">
          <div onClick={(event) => event.stopPropagation()} className="relative flex max-h-full max-w-5xl flex-col items-center gap-3">
            <ReferenceImage key={previewImage.asset.uri} src={previewImage.asset.uri} alt={`${previewImage.candidate.design_name} 大图`} width={1440} height={1920} unoptimized className="max-h-[84vh] w-auto max-w-full rounded-2xl object-contain shadow-2xl" />
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-white/70">
              <span>{previewImage.candidate.candidate_id} · {previewImage.candidate.design_name}</span>
              <a href={previewImage.asset.uri} download={`${previewImage.candidate.candidate_id}-${previewImage.candidate.design_name}.${imageExtension(previewImage.asset.mime_type)}`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/8 px-3 py-2"><Download size={13} />下载原图</a>
            </div>
            <button type="button" onClick={() => setPreviewImage(null)} aria-label="关闭大图" className="absolute -right-2 -top-2 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/75 text-white/80 sm:-right-12 sm:top-0"><X size={18} /></button>
          </div>
        </div>
      )}
      {tuningCandidate && (
        <Modal
          open
          size="md"
          onClose={() => setTuningCandidate(null)}
          eyebrow="SINGLE IMAGE REGENERATE"
          title={tuningCandidate.design_name}
          description="不选择任何项就是保持当前设计重新抽图；选择微调项后，只修改所选部分，其他身份特征保持不变。"
          footer={<div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setTuningCandidate(null)} className={overlayButton.secondary}>取消</button>
            <button type="button" onClick={() => void startCandidateRegeneration(tuningCandidate, [], '')} className={`inline-flex items-center gap-2 ${overlayButton.secondary}`}><RotateCcw size={13} />直接重新生成</button>
            <button type="button" onClick={() => void startCandidateRegeneration(tuningCandidate, tuningOptions, tuningNote)} disabled={tuningOptions.length === 0 && !tuningNote.trim()} className={`inline-flex items-center gap-2 ${overlayButton.primary}`}><Sparkles size={13} />按所选微调生成</button>
          </div>}
        >
          <div className="flex flex-wrap gap-2">
            {CHARACTER_TUNING_OPTIONS.map((option) => {
              const selected = tuningOptions.includes(option);
              return <button key={option} type="button" onClick={() => setTuningOptions((current) => selected ? current.filter((item) => item !== option) : [...current, option])} className={`rounded-full border px-3 py-1.5 text-[11px] transition ${selected ? 'border-emerald-300/45 bg-emerald-300/10 text-emerald-100' : 'border-white/12 bg-white/[0.02] text-white/45 hover:text-white/75'}`}>{option}</button>;
            })}
          </div>
          <textarea value={tuningNote} onChange={(event) => setTuningNote(event.target.value)} maxLength={500} placeholder="可选：写具体要求，例如“头发再短一点，西装换成深灰”。" className="mt-4 min-h-24 w-full rounded-xl border border-white/12 bg-[#07120f] p-3 text-xs leading-5 text-white/75" />
        </Modal>
      )}
    </StepShell>
  );
}

// 六把 DNA 锁已接回主线，控件在 StoryPanel（就近摆在“产出控制”里），标签与语义统一由
// original-story.ts 的 LOCK_LABELS / LOCK_TO_STYLE 提供。这里原先那份 RemixPanel 从不渲染、
// 只靠 `void RemixPanel;` 压住 lint，留着只会让人以为锁还有第二套实现，删掉。

// Retained for legacy project compatibility; the default workflow uses StoryPanel.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LocalizedRemakePanel({
  analysis,
  brief,
  onBriefChange,
  onContinue,
  busy,
}: {
  analysis: VideoDnaAnalysis;
  brief: RemixBrief;
  onBriefChange: (brief: RemixBrief) => void;
  onContinue: () => void;
  busy: boolean;
}) {
  const authorized = brief.sourceRightsScope === 'owned_or_authorized';
  return (
    <div className="space-y-7">
      <section className="rounded-[22px] border border-[#d9b76c]/10 bg-gradient-to-br from-[#d9b76c]/[0.055] to-transparent p-5 sm:p-6">
        <p className="text-[10px] font-semibold tracking-[0.16em] text-[#e8cb8a]/55">REMAKE LOCK</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-white/88">锁住原片，只换角色，英文对白不改</h2>
        <p className="mt-2 text-xs leading-5 text-white/38">不让你另想剧情。AI 保留事件顺序、场景、道具、动作、镜头、表演和时长，只负责角色替换与等义中文本地化。</p>
      </section>

      <section>
        <p className="text-xs font-semibold text-white/62">参考素材授权范围</p>
        {brief.sourceRightsScope === 'unselected' && <p className="mt-2 text-[10px] text-[#e8cb8a]/60">请明确选择一次；逐镜头复刻包只对自有或已获授权素材开放。</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            ['owned_or_authorized', '自有 / 已获授权', '锁定原剧情、镜头、动作与时长，生成中文角色替换复刻包。'],
            ['third_party_reference', '仅分析（第三方参考）', '只查看视频 DNA，不生成角色替换复刻包。'],
          ].map(([id, title, detail]) => {
            const active = brief.sourceRightsScope === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onBriefChange({
                  ...brief,
                  sourceRightsScope: id as RemixBrief['sourceRightsScope'],
                  mode: 'character_swap',
                  newConcept: '',
                  settingBrief: '',
                  targetModel: 'Seedance 2.5',
                  aspectRatio: analysis.source.aspect_ratio,
            outputLanguage: 'English',
                  locks: { ...DEFAULT_LOCKS },
                })}
                className={`rounded-2xl border p-4 text-left ${active ? 'border-emerald-300/35 bg-emerald-300/[0.07]' : 'border-white/7 bg-white/[0.02]'}`}
              >
                <p className="text-xs font-semibold text-white/70">{title}</p>
                <p className="mt-1.5 text-[10px] leading-4 text-white/32">{detail}</p>
              </button>
            );
          })}
        </div>
        {brief.sourceRightsScope === 'third_party_reference' && <p className="mt-3 rounded-xl border border-amber-300/12 bg-amber-300/[0.045] px-3 py-2.5 text-[10px] leading-5 text-amber-100/60">当前只保留分析结果，不会生成逐镜头复刻包。取得授权后切换为“自有 / 已获授权”即可继续。</p>}
      </section>

      <section>
        <p className="text-xs font-semibold text-white/62">固定执行规则</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['01', '画面完全锁定', '剧情、场景、道具、动作、镜头、表演、时长不改'],
            ['02', '角色身份替换', `${analysis.source_roles.length} 个源角色逐一映射到你的角色图`],
            ['03', '对白中文等时长', '保留语义与情绪，中文压缩到原说话窗口内'],
            ['04', 'Seedance 全新出声', '先上传无音轨视频，再原生生成新声线、配乐与环境音效'],
          ].map(([number, title, detail]) => (
            <article key={number} className="rounded-2xl border border-white/7 bg-white/[0.025] p-4">
              <span className="text-[9px] font-semibold text-emerald-200/45">{number}</span>
              <p className="mt-2 text-xs font-semibold text-white/68">{title}</p>
              <p className="mt-2 text-[10px] leading-4 text-white/32">{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-semibold text-white/62">已锁定的视频 DNA</p>
        <div className="mt-3"><PillList items={['剧情顺序', '剪辑节奏', '镜头语法', '光影色彩', '动作与表演', '场景与道具', '非对白声音节奏']} /></div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <label>
          <span className="mb-2 block text-xs font-medium text-white/62">角色审美偏好（可选）</span>
          <textarea
            value={brief.characterBrief}
            onChange={(event) => onBriefChange({ ...brief, characterBrief: event.target.value })}
            placeholder="例如：沿用六人角色库；或写清贵冷静、智性哥哥感。留空时 AI 会为每个角色主动给四种方向。"
            rows={4}
            className="w-full resize-y rounded-xl border border-white/9 bg-black/15 px-3.5 py-3 text-xs leading-5 text-white/70 outline-none placeholder:text-white/18 focus:border-emerald-300/30"
          />
        </label>
        <label>
          <span className="mb-2 block text-xs font-medium text-white/62">英文声线偏好（可选）</span>
          <textarea
            value={brief.voiceBrief}
            onChange={(event) => onBriefChange({ ...brief, voiceBrief: event.target.value })}
            placeholder="例如：年轻俏皮女声，语速轻快；或低沉温柔男声。留空时 AI 会按新角色生成全新声线，不模仿原片。"
            rows={4}
            className="w-full resize-y rounded-xl border border-white/9 bg-black/15 px-3.5 py-3 text-xs leading-5 text-white/70 outline-none placeholder:text-white/18 focus:border-emerald-300/30"
          />
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-white/9 bg-[#0a1512] px-3 py-3"><p className="text-[9px] text-white/30">目标视频模型</p><p className="mt-1 text-xs text-white/68">Seedance 2.5</p></div>
        <div className="rounded-xl border border-white/9 bg-[#0a1512] px-3 py-3"><p className="text-[9px] text-white/30">目标画幅</p><p className="mt-1 text-xs text-white/68">{analysis.source.aspect_ratio} · 跟随原片</p></div>
        <div className="rounded-xl border border-white/9 bg-[#0a1512] px-3 py-3"><p className="text-[9px] text-white/30">输出语言</p><p className="mt-1 text-xs text-white/68">English · 原句逐字保留</p></div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-white/7 bg-white/[0.025] p-4">
        <div>
          <p className="text-xs font-medium text-white/60">下一步：把 {analysis.source_roles.length} 个源角色映射成你的角色</p>
        <p className="mt-1 text-[10px] text-white/27">Gemini 网页只分析一次并返回视频 DNA 与英文原对白；下一页由 GPT/Codex 设计形象并生成角色图，最终提示词在本地编译。</p>
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy || !authorized}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-300 to-[#d9c278] px-5 py-3 text-xs font-semibold text-[#082018] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <WandSparkles size={15} />
          去 GPT/Codex 设计角色
        </button>
      </div>
    </div>
  );
}

function PromptCard({ title, eyebrow, text }: { title: string; eyebrow: string; text: string }) {
  return (
    <article className="rounded-2xl border border-white/7 bg-white/[0.025] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-semibold tracking-[0.15em] text-emerald-200/45">{eyebrow}</p>
          <h3 className="mt-1.5 text-sm font-semibold text-white/72">{title}</h3>
        </div>
        <CopyButton text={text} />
      </div>
      <p className="mt-4 max-h-64 overflow-y-auto whitespace-pre-wrap text-[11px] leading-5 text-white/38">{text}</p>
    </article>
  );
}

function OutputPanel({ pack }: { pack: CreativePack | null }) {
  const [silentSource, setSilentSource] = useState<File | null>(null);
  const [silentBusy, setSilentBusy] = useState(false);
  const [silentProgress, setSilentProgress] = useState(0);
  const [silentStatus, setSilentStatus] = useState('');
  const [silentError, setSilentError] = useState('');

  const handleCreateSilentVideo = async () => {
    if (!silentSource || silentBusy) return;
    setSilentBusy(true);
    setSilentProgress(0);
    setSilentStatus('');
    setSilentError('');
    try {
      const result = await createSilentVideo(silentSource, { onProgress: setSilentProgress });
      if (!result.savedToDisk) {
        const url = URL.createObjectURL(result.file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = result.filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
      setSilentStatus(`校验通过：${result.width}×${result.height} · ${formatTime(result.durationSeconds)} · ${result.sourceAudioTracks} 条原音轨 → ${result.outputAudioTracks} 条。请把“${result.filename}”绑定为“无声参考视频”。`);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') setSilentStatus('已取消保存，没有改动原视频。');
      else setSilentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSilentBusy(false);
    }
  };

  if (!pack) {
    return (
      <div className="grid min-h-[420px] place-items-center rounded-[24px] border border-dashed border-white/9 bg-white/[0.018] p-8 text-center">
        <div>
          <PackageCheck size={28} className="mx-auto text-white/24" />
          <h2 className="mt-4 text-base font-semibold text-white/58">还没有生成包</h2>
      <p className="mt-2 text-xs text-white/28">先完成角色映射与参考图确认，再生成英文原对白和 Seedance 2.5 执行包。</p>
        </div>
      </div>
    );
  }

  const qaPass = pack.qa.timing_valid && pack.qa.variables_applied && pack.qa.originality_pass && !pack.qa.source_identity_leakage && !pack.qa.source_dialogue_leakage;
  const seedanceRuns = pack.seedance_asset_map?.runs ?? [];
  const spokenBeats = pack.beats.filter((beat) => Boolean(beat.dialogue.trim()));
  const nativeDialoguePrompt = spokenBeats.length > 0
    ? `原生生成全新的自然英文声线，不模仿原片人声。严格按以下时间窗、角色和英文原句逐字说话；有可见嘴部时按角色物种做自然发音动作与对口型，没有人类嘴部时不得强行人脸化；不得翻译、增删、润色或改写台词：\n${spokenBeats.map((beat) => `${formatTime(beat.start_seconds)}–${formatTime(beat.end_seconds)}｜${beat.dialogue}`).join('\n')}`
    : '本片没有对白：不要生成任何人声，只生成配乐、环境音与动作音效。';
  const nativeMusicPrompt = `原生创作无歌词、无人声的新配乐，不复用原视频录音；跟随镜头节奏、情绪能量与转折变化，并给英文对白留出清晰空间。声音风格逻辑：${pack.style_lock.sound}`;
  const nativeEffectsPrompt = `原生生成新的环境底噪、动作音、道具音与转场音效，不复用原视频声音，并与画面逐帧同步：\n${pack.beats.map((beat) => `${formatTime(beat.start_seconds)}–${formatTime(beat.end_seconds)}｜${beat.sound}`).join('\n')}`;

  return (
    <div className="space-y-8">
      <section className="rounded-[24px] border border-emerald-200/12 bg-gradient-to-br from-emerald-300/[0.075] to-transparent p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.16em] text-emerald-200/52">CREATIVE PACK</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white/90">{pack.title}</h2>
            <p className="mt-2 max-w-2xl text-xs leading-5 text-white/40">{pack.concept_summary}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] ${qaPass ? 'border-emerald-200/18 bg-emerald-300/[0.08] text-emerald-100/70' : 'border-amber-200/18 bg-amber-300/[0.08] text-amber-100/70'}`}>
            {qaPass ? <ShieldCheck size={12} /> : <AlertTriangle size={12} />}
            {qaPass ? '锁定与替换校验通过' : '需要人工复核'}
          </span>
        </div>
        <div className="mt-5"><PillList items={pack.differentiation_log} tone="gold" /></div>
      </section>

      {pack.remix_policy?.effective_mode === 'character_swap' && (
        <section>
      <SectionTitle eyebrow="ENGLISH DIALOGUE" title="英文原对白已按时间窗逐字保留" note={`${spokenBeats.length} 个说话镜头`} />
          <div className="mt-4 overflow-hidden rounded-2xl border border-white/7 bg-white/[0.02]">
            {spokenBeats.length === 0 ? (
              <p className="p-4 text-xs text-white/35">原片没有识别到对白，本片按无对白处理。</p>
            ) : spokenBeats.map((beat) => (
              <div key={beat.beat_id} className="grid gap-2 border-b border-white/6 px-4 py-3 last:border-0 sm:grid-cols-[120px_120px_minmax(0,1fr)]">
                <span className="text-[10px] text-emerald-200/55">{formatTime(beat.start_seconds)}–{formatTime(beat.end_seconds)}</span>
                <span className="text-[10px] text-white/36">{beat.dialogue_speaker_ids?.join('、') || '说话人待核'}</span>
                <span className="text-[11px] leading-5 text-white/60">{beat.dialogue}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-5 text-white/30">对白是按镜头说话窗口估算的首版文本。最终配音时仍要试听一次；过长句优先压缩措辞，不要硬拉语速。</p>
        </section>
      )}

      {pack.remix_policy?.effective_mode === 'character_swap' && (
        <section>
          <SectionTitle eyebrow="NATIVE AUDIO PROMPTS" title="三组声音生成提示词" note="无需准备音频文件" />
          <p className="mt-3 text-[10px] leading-5 text-white/32">这三项已经完整合并进下方每一个 RUN 提示词，直接复制 RUN 即可；这里单独列出，方便你检查或微调。</p>
        <p className="mt-2 text-[10px] leading-5 text-[#e8cb8a]/55">要换声线：最快是在复制 RUN 后，直接改其中的 <span className="font-semibold text-[#f0d79d]/75">Voice direction</span>；也可以回到“复刻规则”填写“英文声线偏好”，再生成一次复刻包。两种方式都不要写“模仿原片声音”。</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
      <PromptCard eyebrow="VOICE" title="英文原对白与时间点" text={nativeDialoguePrompt} />
            <PromptCard eyebrow="MUSIC" title="原创纯音乐" text={nativeMusicPrompt} />
            <PromptCard eyebrow="AMBIENCE & SFX" title="环境声与动作音效" text={nativeEffectsPrompt} />
          </div>
        </section>
      )}

      {pack.seedance_asset_map && (
        <section>
          <SectionTitle eyebrow="SILENT VIDEO PREP" title="先生成真正无音轨的视觉参考视频" note="本地处理 · 原文件不覆盖" />
          <div className="mt-4 rounded-2xl border border-[#d9b76c]/14 bg-[#d9b76c]/[0.045] p-5">
            <p className="text-[11px] leading-5 text-white/46">原视频负责锁定镜头、动作、舞蹈节拍与特效时序，但不能把原声带给 Seedance。这里会保留画面、时长和尺寸，物理删除全部音轨并复检。</p>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-white/9 px-4 py-2.5 text-xs text-white/55 ${silentBusy ? 'pointer-events-none opacity-40' : ''}`}>
                <UploadCloud size={14} /> {silentSource ? '更换本地原视频' : '选择本地原视频'}
                <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" className="hidden" disabled={silentBusy} onChange={(event) => {
                  setSilentSource(event.currentTarget.files?.[0] ?? null);
                  setSilentStatus('');
                  setSilentError('');
                  setSilentProgress(0);
                  event.currentTarget.value = '';
                }} />
              </label>
              <button type="button" onClick={() => void handleCreateSilentVideo()} disabled={!silentSource || silentBusy} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-300 to-[#d9c278] px-4 py-2.5 text-xs font-semibold text-[#082018] disabled:cursor-not-allowed disabled:opacity-35">
                {silentBusy ? <LoaderCircle size={14} className="animate-spin" /> : <VolumeX size={14} />}
                {silentBusy ? `正在移除音轨 ${Math.round(silentProgress * 100)}%` : '生成并保存无音轨视频'}
              </button>
            </div>
            {silentSource && <p className="mt-3 text-[10px] text-white/32">{silentSource.name} · {formatBytes(silentSource.size)}</p>}
            {silentStatus && <p className="mt-3 rounded-xl border border-emerald-200/10 bg-emerald-300/[0.045] px-3 py-2.5 text-[10px] leading-5 text-emerald-100/65">{silentStatus}</p>}
            {silentError && <p className="mt-3 rounded-xl border border-red-300/12 bg-red-300/[0.045] px-3 py-2.5 text-[10px] leading-5 text-red-100/65">{silentError}</p>}
          </div>
          <div className="mt-7"><SectionTitle eyebrow="SEEDANCE REFERENCES" title="绑定角色图与无声原视频" note="图片锁身份 · 视频锁动作" /></div>
          <div className="mt-4 space-y-2.5 rounded-2xl border border-emerald-200/10 bg-emerald-300/[0.025] p-5">
            {pack.seedance_asset_map.bindings.map((binding) => (
              <div key={`${binding.slot}-${binding.character_id ?? binding.kind}`} className="grid gap-2 border-b border-white/6 pb-3 last:border-0 last:pb-0 sm:grid-cols-[90px_minmax(0,1fr)]">
                <span className="text-xs font-semibold text-emerald-200/65">{binding.slot}</span>
                <span className="text-[11px] leading-5 text-white/40">{binding.instruction}</span>
              </div>
            ))}
            <p className="pt-2 text-[10px] leading-4 text-[#e8cb8a]/55">{pack.seedance_asset_map.usage_note}</p>
          </div>
        </section>
      )}

      {seedanceRuns.length > 0 && (
        <section>
          <SectionTitle eyebrow="SEEDANCE RUNS" title={seedanceRuns.length > 1 ? '已按 30 秒上限自动拆段' : '单段可直接执行'} note={`${seedanceRuns.length} 次生成${seedanceRuns.length > 1 ? ' · 最后顺序拼接' : ''}`} />
          <p className="mt-3 rounded-xl border border-[#d9b76c]/12 bg-[#d9b76c]/[0.045] px-4 py-3 text-[10px] leading-5 text-[#e8cb8a]/60">① 按顺序绑定角色参考图；② 绑定对应 RUN 区间的无声原视频并命名“无声参考视频”；③ 如已有音乐，再绑定音乐文件并在提示词开头命名“配乐参考音频”；④ 复制 RUN 提示词生成。角色图锁身份，视频锁镜头、动作和时序，音乐锁最终节拍。</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {seedanceRuns.map((run) => (
              <div key={run.run_id} className="space-y-2">
                <PromptCard
                  eyebrow={`${formatTime(run.source_start_seconds)}–${formatTime(run.source_end_seconds)} · ${run.duration_seconds}s`}
                  title={`${run.run_id} 可直接复制`}
                  text={run.target_prompt}
                />
                <button type="button" onClick={() => downloadText(`${run.run_id}.txt`, run.target_prompt, 'text/plain')} className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 text-[10px] text-white/42 hover:text-white/70"><Download size={12} /> 下载本段提示词</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionTitle eyebrow="FINAL PROMPTS" title="可直接复制的生成提示词" />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => downloadText('mirror-vibe-creative-pack.json', JSON.stringify(pack, null, 2), 'application/json')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 text-[10px] text-white/45 hover:text-white/70"
            >
              <FileJson size={12} /> JSON
            </button>
            <button
              type="button"
              onClick={() => downloadText('mirror-vibe-creative-pack.md', creativePackToMarkdown(pack), 'text/markdown')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 px-3 py-2 text-[10px] text-white/45 hover:text-white/70"
            >
              <FileText size={12} /> Markdown
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <PromptCard eyebrow="GENERIC MASTER" title="通用总提示词" text={pack.prompt_bundle.generic_master} />
          <PromptCard eyebrow="TARGET DIALECT" title={`${pack.prompt_bundle.target_model} 适配版`} text={pack.prompt_bundle.target_prompt} />
          <PromptCard eyebrow="FIRST FRAME" title="首帧提示词" text={pack.prompt_bundle.first_frame_prompt} />
          <PromptCard eyebrow="LAST FRAME" title="尾帧提示词" text={pack.prompt_bundle.last_frame_prompt} />
          <div className="lg:col-span-2"><PromptCard eyebrow="NEGATIVE" title="统一负面约束" text={pack.prompt_bundle.negative_prompt} /></div>
        </div>
      </section>

      <section>
        <SectionTitle eyebrow="SHOT COMPILER" title="逐镜头提示词" note={`${pack.beats.length} 段`} />
        <div className="mt-4 space-y-2.5">
          {pack.beats.map((beat) => (
            <details key={beat.beat_id} className="group rounded-2xl border border-white/7 bg-white/[0.02] p-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-emerald-300/[0.08] text-[9px] font-semibold text-emerald-200/58">{beat.beat_id}</span>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-white/62">{beat.story_function} · {beat.action}</p>
                    <p className="mt-1 text-[9px] text-white/25">{formatTime(beat.start_seconds)}–{formatTime(beat.end_seconds)} · {beat.character_ids.join('、') || '空镜'}</p>
                  </div>
                </div>
                <ChevronRight size={14} className="shrink-0 text-white/28 transition group-open:rotate-90" />
              </summary>
              <div className="mt-4 border-t border-white/6 pt-4">
                <div className="flex justify-end"><CopyButton text={beat.video_prompt} /></div>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-white/38">{beat.video_prompt}</p>
                {beat.dialogue && <p className="mt-3 border-l border-[#d9b76c]/25 pl-3 text-[10px] text-[#e8cb8a]/50">对白：{beat.dialogue}</p>}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}

function HistoryDrawer({
  open,
  projects,
  loading,
  onClose,
  onOpen,
}: {
  open: boolean;
  projects: SavedVideoProjectSummary[];
  loading: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      dismissible={!loading}
      eyebrow="PROJECT HISTORY"
      title="本地项目记录"
      description="这里只显示 localhost 保存的记录；此前线上记录不会自动同步。DNA、角色候选、参考图与生成包都在本机。"
    >
      <div>
        <div className="space-y-2.5">
          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-white/7 p-4 text-xs text-white/35"><LoaderCircle size={14} className="animate-spin" /> 正在读取项目…</div>
          ) : projects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/8 p-6 text-center text-xs text-white/28">还没有保存过的分析</div>
          ) : projects.map((project) => (
            <button key={project.id} type="button" onClick={() => onOpen(project.id)} className="w-full rounded-2xl border border-white/7 bg-white/[0.025] p-4 text-left transition hover:border-emerald-200/18 hover:bg-emerald-300/[0.035]">
              <div className="flex items-start justify-between gap-3"><h3 className="line-clamp-2 text-xs font-semibold leading-5 text-white/68">{project.title}</h3><span className="shrink-0 rounded-full border border-white/8 px-2 py-1 text-[8px] text-white/28">{project.stage}</span></div>
              <p className="mt-2 truncate text-[9px] text-white/25">{project.sourceName || '未保存源文件'} · {formatTime(project.durationSeconds)} · {project.aspectRatio}</p>
              <p className="mt-1 text-[9px] text-white/20">更新于 {new Date(project.updatedAt).toLocaleString('zh-CN')}</p>
            </button>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取本地参考图。'));
    reader.readAsDataURL(blob);
  });
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await accountFetch(url, { ...init, signal: init?.signal ?? controller.signal });
    const payload = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
    return payload;
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('项目保存请求超时，请检查网络后重试。');
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function StudioApp() {
  const { pipelineEnabled = false, helperDownloads } = useAccountConfig();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dnaFileInputRef = useRef<HTMLInputElement>(null);
  const briefSaveTimerRef = useRef<number | null>(null);
  const projectRevisionsRef = useRef(new Map<string, string>());
  const projectPatchQueuesRef = useRef(new Map<string, Promise<void>>());
  const projectViewRef = useRef({ id: '', generation: 0 });
  const projectLoadGenerationRef = useRef(0);
  const autoRestoreStartedRef = useRef(false);
  const [settings, setSettings] = useState<AnalysisSettings>(storedSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analysisConfigured, setAnalysisConfigured] = useState(() => { const connection = loadConnection('analysis'); return Boolean(connection.apiKey.trim() && connection.model); });
  const [helperStatus, setHelperStatus] = useState<'ready' | 'setup' | 'unavailable' | 'outdated' | 'unchecked'>('unchecked');
  const [productionOpen, setProductionOpen] = useState(false);
  const [editingBeat, setEditingBeat] = useState<VideoBeat | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [videoMetadata, setVideoMetadata] = useState<LocalVideoMetadata>({});
  const [analysis, setAnalysis] = useState<VideoDnaAnalysis | null>(null);
  const [automaticPrevis, setAutomaticPrevis] = useState(true);
  const [autoPrevisProject, setAutoPrevisProject] = useState('');
  // 预演是否已渲出片子。由 AutoPrevisPanel 上报，流程条据此显示第④步状态。
  const [previsReady, setPrevisReady] = useState(false);
  // 必须是稳定引用：AutoPrevisPanel 里 effect 依赖 onStatus，
  // 每次渲染换一个新函数会让它无限触发。
  const handlePrevisStatus = useCallback(({ ready }: { ready: boolean; running: boolean }) => { setPrevisReady(ready); }, []);
  const [proposals, setProposals] = useState<CharacterProposals | null>(null);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [referenceAssets, setReferenceAssets] = useState<ReferenceAsset[]>([]);
  const [creativePack, setCreativePack] = useState<CreativePack | null>(null);
  const [projectId, setProjectId] = useState('');
  const [projectTitle, setProjectTitle] = useState('');
  const [projectSourceName, setProjectSourceName] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyProjects, setHistoryProjects] = useState<SavedVideoProjectSummary[]>([]);
  const [activePanel, setActivePanel] = useState<ActivePanel>('dna');
  const [brief, setBrief] = useState<RemixBrief>(INITIAL_BRIEF);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressStage | null>(null);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [usage, setUsage] = useState<UsageStats>(EMPTY_USAGE);
  const [modelVersion, setModelVersion] = useState('');
  const [demoMode, setDemoMode] = useState(false);
  const [dnaJsonText, setDnaJsonText] = useState('');
  const [dnaImportName, setDnaImportName] = useState('Gemini 网页导入');
  // 设置弹窗保存后要立刻反映到输出页；面板自己读 localStorage 只会读到挂载那一刻的值。
  const [videoModelId, setVideoModelId] = useState(() => loadConnection('video').model);
  // 整片提示词上线前导出的旧包只有分段；本地按同一套编译器补出整片再交给输出页，不改写已保存记录。
  const displayPack = useMemo(
    () => (creativePack && analysis ? withFullRunPrompt(creativePack, analysis, brief) : creativePack),
    [creativePack, analysis, brief],
  );

  const switchProjectView = useCallback((id: string) => {
    projectViewRef.current = { id, generation: projectViewRef.current.generation + 1 };
    setProjectId(id);
    setBusy(false);
    setProgress(null);
    try {
      if (id) window.localStorage.setItem(accountStorageKey(LAST_PROJECT_STORAGE_KEY), id);
      else window.localStorage.removeItem(accountStorageKey(LAST_PROJECT_STORAGE_KEY));
    } catch {
      // 云端项目仍是事实来源；本地键只用于刷新后快速定位最近项目。
    }
  }, []);

  const isCurrentProjectView = useCallback((view: { id: string; generation: number }) => (
    projectViewRef.current.id === view.id && projectViewRef.current.generation === view.generation
  ), []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => () => {
    if (briefSaveTimerRef.current !== null) window.clearTimeout(briefSaveTimerRef.current);
  }, []);

  const pickFile = useCallback((nextFile: File | null) => {
    if (!nextFile) return;
    if (!supportedVideoMimeType(nextFile)) {
      setError('请选择 MP4、MOV、WebM、AVI、WMV、FLV、MPEG 或 3GP 视频；MKV 请先转换为 MP4。');
      return;
    }
    if (nextFile.size > MAX_FILE_BYTES) {
      setError('视频超过本应用本地读取上限 1.9 GiB；这不是中转视频上传上限。');
      return;
    }
    setFile(nextFile);
    setPreviewUrl(URL.createObjectURL(nextFile));
    setVideoMetadata({});
    setAnalysis(null);
    setProposals(null);
    setSelections({});
    setReferenceAssets([]);
    setCreativePack(null);
    projectLoadGenerationRef.current += 1;
    setHistoryLoading(false);
    switchProjectView('');
    setProjectTitle('');
    setProjectSourceName('');
    setDemoMode(false);
    setError('');
    setWarning('');
  }, [switchProjectView]);

  const clearSelectedFile = () => {
    if (busy) return;
    setFile(null);
    setPreviewUrl('');
    setVideoMetadata({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * 保存一镜的人工修正。修正会写进 analysis 并标记 corrected_by_user，
   * 同时在 uncertainties 里留一条来源说明——不能让人工内容混进证据层冒充模型结论。
   */
  const saveBeatCorrection = async (next: VideoBeat) => {
    if (!analysis) return;
    const beats = analysis.beats.map((beat) => (beat.beat_id === next.beat_id ? next : beat));
    const corrected = beats.filter((beat) => beat.corrected_by_user).map((beat) => beat.beat_id);
    const note = `以下镜头的动作由用户看片后人工修正，不是模型输出：${corrected.join('、')}。`;
    const updated: VideoDnaAnalysis = {
      ...analysis,
      beats,
      uncertainties: [...analysis.uncertainties.filter((item) => !item.startsWith('以下镜头的动作由用户看片后人工修正')), note],
    };
    setAnalysis(updated);
    setEditingBeat(null);
    try {
      await persistProjectPatch({ analysis: updated });
      setWarning(`${next.beat_id} 已按你的修正保存，并标记为「人工修正」。下游的故事投影、角色设计和提示词都会按新内容走。`);
    } catch (cause) {
      setWarning(`${next.beat_id} 的修正已在本次会话生效，但保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  /**
   * 只把「产出设定」按回推荐值：采样、逐字转写、六把锁、每镜秒数、画幅、候选数。
   * 不碰 Key、模型选择和已经生成的内容——按这个按钮是想回到一个已知良好的起点，不是想把填过的东西清空。
   */
  const resetProductionSettings = () => {
    const recommended = { ...settings, fps: DEFAULT_SETTINGS.fps, mediaResolution: DEFAULT_SETTINGS.mediaResolution, transcribeDialogue: DEFAULT_SETTINGS.transcribeDialogue };
    setSettings(recommended);
    try { window.localStorage.setItem(accountStorageKey(SETTINGS_STORAGE_KEY), JSON.stringify(recommended)); } catch { /* 存不了也让本次生效 */ }
    const connection = loadConnection('analysis');
    if (!connection.advancedVideo) saveConnection('analysis', { ...connection, advancedVideo: true });
    handleBriefChange({
      ...brief,
      locks: { ...DEFAULT_LOCKS },
      maxShotSeconds: undefined,
      candidateCount: undefined,
      aspectRatio: analysis?.source.aspect_ratio ?? brief.aspectRatio,
    });
    setProductionOpen(false);
    setWarning('产出参数已恢复推荐值：六把 DNA 锁全锁、每镜按模型上限自动推导、画幅跟随源片、每角色 4 套候选。已生成的内容没有动。');
  };

  const saveSettings = () => {
    const connection = loadConnection('analysis');
    setAnalysisConfigured(Boolean(connection.apiKey.trim() && connection.model));
    try {
      window.localStorage.setItem(accountStorageKey(SETTINGS_STORAGE_KEY), JSON.stringify(settings));
    } catch {
      setWarning('浏览器拒绝了本地存储；本次仍可使用，但刷新页面后需要重新填写设置。');
    }
    setVideoModelId(loadConnection('video').model);
    setSettingsOpen(false);
  };

  const rememberProjectRevision = (id: string, updatedAt: string) => {
    if (!id || !updatedAt) return;
    const current = projectRevisionsRef.current.get(id);
    if (!current || Date.parse(updatedAt) > Date.parse(current)) {
      projectRevisionsRef.current.set(id, updatedAt);
    }
  };

  const persistProjectPatch = (patch: Partial<SavedVideoProject>): Promise<SavedVideoProject | undefined> => {
    if (!projectId || demoMode) return Promise.resolve(undefined);
    const targetProjectId = projectId;
    const prior = projectPatchQueuesRef.current.get(targetProjectId) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(async () => {
      const expectedUpdatedAt = projectRevisionsRef.current.get(targetProjectId);
      if (!expectedUpdatedAt) throw new Error('项目版本尚未就绪，请重新打开该项目后再保存。');
      const { project } = await requestJson<{ project: SavedVideoProject }>(`/api/projects/${targetProjectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, expectedUpdatedAt }),
      });
      rememberProjectRevision(project.id, project.updatedAt);
      return project;
    });
    const settled = pending.then(() => undefined, () => undefined);
    projectPatchQueuesRef.current.set(targetProjectId, settled);
    void settled.finally(() => {
      if (projectPatchQueuesRef.current.get(targetProjectId) === settled) {
        projectPatchQueuesRef.current.delete(targetProjectId);
      }
    });
    return pending;
  };

  const handleBriefChange = (nextBrief: RemixBrief) => {
    setBrief(nextBrief);
    if (creativePack) setWarning('修改已保留；上次成功的生成包仍在，重新确认故事并导出后才会替换。');
    if (!projectId || demoMode || !analysis) return;
    if (briefSaveTimerRef.current !== null) window.clearTimeout(briefSaveTimerRef.current);
    const nextStage = referenceAssets.length > 0 ? 'references' : proposals ? 'characters' : 'analysis';
    briefSaveTimerRef.current = window.setTimeout(() => {
      void persistProjectPatch({ brief: nextBrief, stage: nextStage }).catch((cause) => {
        setWarning(`创作设置保留在当前页面，但云端记录未更新：${cause instanceof Error ? cause.message : String(cause)}。`);
      });
    }, 900);
  };

  const saveStoryBrief = async (nextBrief: RemixBrief) => {
    if (!projectId || demoMode) throw new Error('请先导入并保存一个真实项目，再生成或确认新故事。');
    if (briefSaveTimerRef.current !== null) { window.clearTimeout(briefSaveTimerRef.current); briefSaveTimerRef.current = null; }
    const view = { ...projectViewRef.current };
    await persistProjectPatch({ brief: nextBrief });
    if (isCurrentProjectView(view)) setBrief(nextBrief);
  };

  const refreshHistory = async () => {
    setHistoryLoading(true);
    try {
      const result = await requestJson<{ projects: SavedVideoProjectSummary[] }>('/api/projects');
      setHistoryProjects(result.projects);
    } catch (cause) {
      setWarning(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryLoading(false);
    }
  };

  const showHistory = () => {
    if (busy) return;
    setHistoryOpen(true);
    void refreshHistory();
  };

  const openSavedProject = async (id: string) => {
    if (busy) return;
    const loadGeneration = projectLoadGenerationRef.current + 1;
    projectLoadGenerationRef.current = loadGeneration;
    if (briefSaveTimerRef.current !== null) {
      window.clearTimeout(briefSaveTimerRef.current);
      briefSaveTimerRef.current = null;
    }
    setHistoryOpen(false);
    setHistoryLoading(true);
    setBusy(true);
    setProgress('restoring');
    setError('');
    try {
      let project: SavedVideoProject | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const queuedBeforeRead = projectPatchQueuesRef.current.get(id);
        if (queuedBeforeRead) await queuedBeforeRead.catch(() => undefined);
        if (projectLoadGenerationRef.current !== loadGeneration) return;
        const response = await requestJson<{ project: SavedVideoProject }>(`/api/projects/${id}`);
        if (projectLoadGenerationRef.current !== loadGeneration) return;
        const queuedAfterRead = projectPatchQueuesRef.current.get(id);
        const knownRevision = projectRevisionsRef.current.get(id);
        const responseIsStale = Boolean(
          knownRevision && Date.parse(knownRevision) > Date.parse(response.project.updatedAt),
        );
        if ((queuedAfterRead && queuedAfterRead !== queuedBeforeRead) || responseIsStale) continue;
        project = response.project;
        break;
      }
      if (!project) throw new Error('项目仍在保存中，请稍后再从历史记录打开。');
      if (projectLoadGenerationRef.current !== loadGeneration) return;
      allowLegacyProjectCache(project.id);
      const restoredAnalysis = normalizeVideoDnaEntityProfiles(project.analysis);
      const staleRoleProposals = Boolean(project.proposals && restoredAnalysis.source_roles.some((role) => {
        const roleSet = project?.proposals?.role_sets.find((item) => item.source_role_id === role.role_id);
        return Boolean(roleSet && roleSet.candidates.some((candidate) => (
          !candidate.entity_type ||
          !candidate.casting_envelope ||
          !sameEntityProfile(resolveSourceRoleEntity(roleForCandidate(role, candidate)), resolveCharacterEntity(candidate)) ||
          Boolean(castingDriftField(resolveSourceRoleCastingEnvelope(roleForCandidate(role, candidate), restoredAnalysis.style_dna.visual.medium), resolveCharacterCastingEnvelope(candidate), candidate.design_mode, candidate.design_settings))
        )));
      }));
      const restoredProposals = staleRoleProposals ? null : project.proposals;
      const restoredSelections = staleRoleProposals ? {} : project.selections;
      const restoredBrief: RemixBrief = {
        ...project.brief,
        // 三月定：素材一律按已授权处理，不再让用户选，也不再拦。
        sourceRightsScope: 'owned_or_authorized',
        voiceBrief: project.brief.voiceBrief ?? '',
        mode: project.brief.storyMode === 'preserve' ? 'character_swap' : project.brief.workflow === ORIGINAL_WORKFLOW ? 'full_original' : project.brief.mode,
        targetModel: 'Seedance 2.5',
        aspectRatio: restoredAnalysis.source.aspect_ratio,
        outputLanguage: project.brief.outputLanguage || 'English',
        locks: { ...DEFAULT_LOCKS },
      };
      let restoredPack = project.creativePack;
      let migrationNotice = '';
      const legacyAudioBindings = restoredPack?.seedance_asset_map?.bindings.filter((binding) => (
        binding.kind === 'dialogue_audio_reference' ||
        binding.kind === 'music_audio_reference' ||
        binding.kind === 'ambience_audio_reference'
      )) ?? [];
      if (restoredBrief.workflow !== ORIGINAL_WORKFLOW && restoredPack && legacyAudioBindings.length > 0 && !staleRoleProposals) {
        const savedProposals = restoredProposals;
        const savedReferenceAssets = project.referenceAssets;
        const characterBindings = restoredPack.seedance_asset_map?.bindings.filter((binding) => binding.kind === 'character_reference') ?? [];
        const selectedCharacters = restoredAnalysis.source_roles.map((role) => {
          const binding = characterBindings.find((item) => item.source_role_id === role.role_id);
          return savedProposals?.role_sets
            .find((roleSet) => roleSet.source_role_id === role.role_id)
            ?.candidates.find((candidate) => candidate.candidate_id === binding?.candidate_id);
        }).filter((candidate): candidate is CharacterCandidate => Boolean(candidate));
        const selectedAssets = selectedCharacters.map((candidate) => {
          const binding = characterBindings.find((item) => item.candidate_id === candidate.candidate_id);
          return savedReferenceAssets.find((asset) => (
            !asset.retired &&
            asset.approved &&
            asset.asset_id === binding?.asset_id &&
            asset.character_id === candidate.character_id &&
            asset.candidate_id === candidate.candidate_id &&
            asset.prompt === candidate.reference_image_prompt
          ));
        }).filter((asset): asset is ReferenceAsset => Boolean(asset));
        if (
          selectedCharacters.length === restoredAnalysis.source_roles.length &&
          selectedAssets.length === selectedCharacters.length
        ) {
          try {
            const upgradedPack = compileNativeAudioPrompts(restoredPack, {
              ...restoredBrief,
              analysis: restoredAnalysis,
              selectedCharacters,
              referenceAssets: selectedAssets,
            });
            validateCompiledCreativePack(upgradedPack, restoredAnalysis, true, selectedCharacters);
            restoredPack = upgradedPack;
            try {
              const response = await requestJson<{ project: SavedVideoProject }>(`/api/projects/${project.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ creativePack: upgradedPack, expectedUpdatedAt: project.updatedAt }),
              });
              project = response.project;
              restoredPack = response.project.creativePack ?? upgradedPack;
              migrationNotice = '旧版三音频槽位包已自动升级并保存为 Seedance 原生出声版；三组声音提示词仍完整保留，未调用 Gemini，也未增加 token。';
            } catch (saveCause) {
              migrationNotice = `旧版三音频槽位包已在当前页面无消耗升级，三组声音提示词仍完整保留；云端写回失败，下次刷新会自动再转换：${saveCause instanceof Error ? saveCause.message : String(saveCause)}。`;
            }
          } catch (migrationCause) {
            restoredPack = project.creativePack;
            migrationNotice = `旧版成功包已完整保留，但当前记录无法安全转换为原生出声版：${migrationCause instanceof Error ? migrationCause.message : String(migrationCause)}。`;
          }
        } else {
          migrationNotice = '旧版成功包已完整保留；因角色方案或已确认参考图记录不完整，暂未自动转换音频槽位。';
        }
      }
      if (staleRoleProposals) {
        migrationNotice = `${migrationNotice} 检测到旧版角色方案缺少新版选角风格锁，旧图和旧生成包均未删除；请在“角色映射”点击“复制给 Codex 设计并生图”，新方案会在更换具体身份的同时锁定原片的年龄段、性别表达、地域视觉语境、体型、发型、服装功能与写实程度。`.trim();
      }
      if (projectLoadGenerationRef.current !== loadGeneration) return;
      switchProjectView(project.id);
      rememberProjectRevision(project.id, project.updatedAt);
      setProjectTitle(project.title);
      setProjectSourceName(project.sourceName);
      setAnalysis(restoredAnalysis);
      setBrief(restoredBrief);
      setProposals(restoredProposals);
      setSelections(restoredSelections);
      setReferenceAssets(project.referenceAssets);
      setCreativePack(restoredPack);
      setUsage(project.usage);
      setModelVersion(project.modelVersion);
      setFile(null);
      setPreviewUrl('');
      setVideoMetadata({ durationSeconds: restoredAnalysis.source.duration_seconds });
      setDemoMode(false);
      setActivePanel(restoredBrief.storyConfirmed && restoredProposals ? 'characters' : 'remix');
      setWarning(`已恢复本地项目，旧图片和导出包未删除。请在“新故事”确认新版内容；新包只使用角色图和文字，不要求原视频。${migrationNotice ? ` ${migrationNotice}` : ''}`);
    } catch (cause) {
      if (projectLoadGenerationRef.current === loadGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (projectLoadGenerationRef.current === loadGeneration) {
        setHistoryLoading(false);
        setBusy(false);
        setProgress(null);
      }
    }
  };

  useEffect(() => {
    if (autoRestoreStartedRef.current) return;
    autoRestoreStartedRef.current = true;
    const loadGeneration = projectLoadGenerationRef.current;
    void (async () => {
      try {
        const result = await requestJson<{ projects: SavedVideoProjectSummary[] }>('/api/projects');
        if (projectLoadGenerationRef.current !== loadGeneration || projectViewRef.current.id) return;
        setHistoryProjects(result.projects);
        let preferredId = '';
        try {
          preferredId = window.localStorage.getItem(accountStorageKey(LAST_PROJECT_STORAGE_KEY)) ?? '';
        } catch {
          // 无法读取本地指针时，恢复云端最近更新的项目。
        }
        const project = result.projects.find((item) => item.id === preferredId) ?? result.projects[0];
        if (project) await openSavedProject(project.id);
      } catch (cause) {
        if (projectLoadGenerationRef.current === loadGeneration && !projectViewRef.current.id) {
          setWarning(`最近项目未能自动恢复：${cause instanceof Error ? cause.message : String(cause)}。可从“项目记录”手动打开。`);
        }
      }
    })();
    // 首次挂载只尝试一次；用户随后选择文件或项目时，generation 会阻止旧请求覆盖当前页面。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAnalyze = async () => {
    if (!file) return;
    try { requireConnection('analysis'); }
    catch { setSettingsOpen(true); return; }
    setBusy(true);
    setError('');
    setProgress('uploading');
    try {
      if (automaticPrevis && (file.size > 512 * 1024 * 1024 || (videoMetadata.durationSeconds ?? 0) > 600)) throw new Error('本地预演目前支持源片不超过 512 MiB、10 分钟。尚未调用模型；可取消自动预演，仅分析 DNA。中转上传上限另行决定。');
      const result = await analyzeVideo({ file, settings, metadata: videoMetadata, onProgress: setProgress });
      setAnalysis(result.data);
      if (!result.remoteFileDeleted) {
        setWarning('分析已完成，但中转临时文件删除失败；请在中转站核实清理和保留期限。');
      }
      setUsage(result.usage);
      setModelVersion(result.modelVersion);
      const nextBrief = {
        ...brief,
        mode: 'character_swap' as const,
        storyMode: 'preserve' as const,
        workflow: ORIGINAL_WORKFLOW,
        storyDraft: undefined,
        storyConfirmed: false,
        storyJobId: undefined,
        newConcept: '',
        settingBrief: '',
        targetModel: 'Seedance 2.5',
        aspectRatio: result.data.source.aspect_ratio,
        outputLanguage: 'English',
        locks: { ...DEFAULT_LOCKS },
      };
      setBrief(nextBrief);
      setActivePanel(automaticPrevis ? 'dna' : 'remix');
      const title = result.data.source.one_line_summary.slice(0, 80) || file.name;
      setProjectTitle(title);
      setProjectSourceName('');
      try {
        setProgress('saving');
        const { project } = await requestJson<{ project: SavedVideoProject }>('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            sourceName: file.name,
            stage: 'analysis',
            analysis: result.data,
            brief: nextBrief,
            proposals: null,
            selections: {},
            referenceAssets: [],
            creativePack: null,
            modelVersion: result.modelVersion,
            usage: result.usage,
          }),
        });
        projectLoadGenerationRef.current += 1;
        switchProjectView(project.id);
        rememberProjectRevision(project.id, project.updatedAt);
        if (automaticPrevis) setAutoPrevisProject(project.id);
      } catch (saveCause) {
        setWarning(`DNA 已完成，但项目记录暂未保存：${saveCause instanceof Error ? saveCause.message : String(saveCause)}。你仍可继续并手动导出。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleImportDna = async () => {
    if (!dnaJsonText.trim()) {
      setError('请粘贴 Gemini 返回的 JSON，或先选择 JSON 文件。');
      return;
    }
    setBusy(true);
    setError('');
    setWarning('');
    setProgress('saving');
    try {
      const imported = parseReferenceDna(dnaJsonText);
      const nextBrief: RemixBrief = {
        ...INITIAL_BRIEF,
        aspectRatio: imported.source.aspect_ratio,
        outputLanguage: 'English',
      };
      setAnalysis(imported);
      setBrief(nextBrief);
      setProposals(null);
      setSelections({});
      setReferenceAssets([]);
      setCreativePack(null);
      setUsage(EMPTY_USAGE);
      setModelVersion('Gemini 网页导入');
      if (imported.uncertainties.length) setWarning(`参考分析有 ${imported.uncertainties.length} 项待核内容，可在“参考 DNA”查看。新故事会建立并校验自己的时间轴，不要求修成逐镜复刻数据。`);
      setFile(null);
      setPreviewUrl('');
      setVideoMetadata({ durationSeconds: imported.source.duration_seconds });
      setDemoMode(false);
      setActivePanel('remix');
      const title = imported.source.one_line_summary.slice(0, 80) || dnaImportName;
      setProjectTitle(title);
      setProjectSourceName('');
      const { project } = await requestJson<{ project: SavedVideoProject }>('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          sourceName: dnaImportName,
          stage: 'analysis',
          analysis: imported,
          brief: nextBrief,
          proposals: null,
          selections: {},
          referenceAssets: [],
          creativePack: null,
          modelVersion: 'Gemini 网页导入',
          usage: EMPTY_USAGE,
        }),
      });
      projectLoadGenerationRef.current += 1;
      switchProjectView(project.id);
      rememberProjectRevision(project.id, project.updatedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const loadDnaFile = async (nextFile: File | null) => {
    if (!nextFile) return;
    setDnaImportName(nextFile.name);
    setDnaJsonText(await nextFile.text());
    setError('');
  };

  const handleSelectCandidate = (sourceRoleId: string, candidateId: string) => {
    if (!proposals) return;
    const candidate = proposals.role_sets.find((set) => set.source_role_id === sourceRoleId)?.candidates.find((item) => item.candidate_id === candidateId);
    if (!candidate) return;
    const nextSelections = { ...selections, [sourceRoleId]: candidateId };
    const projectView = { ...projectViewRef.current };
    setSelections(nextSelections);
    if (creativePack) setWarning('角色选择已更新；上次成功的英文原对白复刻包仍保留，生成新包成功后才会替换。');
    void persistProjectPatch({ stage: 'characters', brief, proposals, selections: nextSelections }).catch((cause) => {
      if (isCurrentProjectView(projectView)) setWarning(`角色选择已保留在当前页面，但云端记录更新失败：${cause instanceof Error ? cause.message : String(cause)}。`);
    });
  };

  const uploadReferenceAsset = async (candidate: CharacterCandidate, imageFile: Blob, filename: string, selectCandidate = true) => {
    if (!projectId || demoMode) throw new Error('当前项目尚未保存，暂时只能下载本地图片，不能锁定到项目。');
    const projectView = { ...projectViewRef.current };
    if (projectView.id !== projectId) throw new Error('项目视图正在切换，请稍后重试。');
    const targetProjectId = projectView.id;
    if (!REFERENCE_MIME_TYPES.has(imageFile.type) || imageFile.size > MAX_REFERENCE_BYTES) {
      throw new Error('只接受 8 MB 以内的 PNG、JPEG 或 WebP 图片。');
    }
    const form = new FormData();
    form.set('file', imageFile, filename);
    form.set('characterId', candidate.character_id);
    form.set('candidateId', candidate.candidate_id);
    form.set('prompt', candidate.reference_image_prompt);
    form.set('selectCandidate', selectCandidate ? 'true' : 'false');
    const response = await requestJson<{ asset: ReferenceAsset; referenceAssets: ReferenceAsset[]; updatedAt: string }>(`/api/projects/${targetProjectId}/assets`, { method: 'POST', body: form });
    rememberProjectRevision(targetProjectId, response.updatedAt);
    if (!isCurrentProjectView(projectView)) return { asset: response.asset, applied: false };
    setReferenceAssets(response.referenceAssets);
    if (selectCandidate) setSelections((current) => ({ ...current, [candidate.source_role_id]: candidate.candidate_id }));
    return { asset: response.asset, applied: true };
  };

  const handleUploadReference = async (candidate: CharacterCandidate, imageFile: File) => {
    const projectView = { ...projectViewRef.current };
    setBusy(true);
    setError('');
    setWarning('');
    setProgress('saving');
    try {
      if (!REFERENCE_MIME_TYPES.has(imageFile.type) || imageFile.size > MAX_REFERENCE_BYTES) {
        throw new Error('只接受 8 MB 以内的 PNG、JPEG 或 WebP 图片。');
      }
      try {
        const upload = await uploadReferenceAsset(candidate, imageFile, imageFile.name || `${candidate.character_id}.${imageExtension(imageFile.type)}`);
        if (!upload.applied) return;
        setWarning('自定义参考图已保存。确认形象没问题后，点击“确认采用”。');
      } catch (saveCause) {
        if (!isCurrentProjectView(projectView)) return;
        const dataUrl = await blobToDataUrl(imageFile);
        if (!isCurrentProjectView(projectView)) return;
        const localAsset: ReferenceAsset = {
          asset_id: crypto.randomUUID(),
          project_id: projectId,
          character_id: candidate.character_id,
          candidate_id: candidate.candidate_id,
          kind: 'identity_sheet',
          uri: dataUrl,
          mime_type: imageFile.type,
          prompt: candidate.reference_image_prompt,
          approved: false,
          created_at: new Date().toISOString(),
        };
        setReferenceAssets([...referenceAssets.filter((asset) => asset.character_id !== candidate.character_id || asset.approved), localAsset]);
        setWarning(`图片仅保存在本次会话：${saveCause instanceof Error ? saveCause.message : String(saveCause)}。请确认后立即下载。`);
      }
    } catch (cause) {
      if (isCurrentProjectView(projectView)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentProjectView(projectView)) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const handleApproveReference = async (candidate: CharacterCandidate) => {
    const asset = referenceAssetForCandidate(referenceAssets, candidate);
    if (!asset) return;
    const projectView = { ...projectViewRef.current };
    setBusy(true);
    setError('');
    setWarning('');
    try {
      if (asset.uri.startsWith('data:')) {
        setReferenceAssets(referenceAssets.map((item) =>
          item.asset_id === asset.asset_id ? { ...item, approved: true } : item,
        ));
        setWarning('已在本次会话确认。请立即下载参考图；刷新页面后本地图无法恢复。');
      } else {
        const response = await requestJson<{ asset: ReferenceAsset; referenceAssets: ReferenceAsset[]; updatedAt: string }>(`/api/projects/${projectView.id}/assets`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: asset.asset_id }),
        });
        rememberProjectRevision(projectView.id, response.updatedAt);
        if (!isCurrentProjectView(projectView)) return;
        setReferenceAssets(response.referenceAssets);
        setWarning(`已锁定“${candidate.design_name}”作为角色参考。`);
      }
    } catch (cause) {
      if (isCurrentProjectView(projectView)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentProjectView(projectView)) setBusy(false);
    }
  };

  const handleDiscardReference = async (candidate: CharacterCandidate) => {
    const asset = referenceAssetForCandidate(referenceAssets, candidate);
    if (!asset || asset.approved) return;
    const projectView = { ...projectViewRef.current };
    setBusy(true);
    setError('');
    setWarning('');
    try {
      if (asset.uri.startsWith('data:')) {
        setReferenceAssets(referenceAssets.filter((item) => item.asset_id !== asset.asset_id));
      } else {
        const response = await requestJson<{ referenceAssets: ReferenceAsset[]; updatedAt: string }>(`/api/projects/${projectView.id}/assets`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: asset.asset_id }),
        });
        rememberProjectRevision(projectView.id, response.updatedAt);
        if (!isCurrentProjectView(projectView)) return;
        setReferenceAssets(response.referenceAssets);
      }
      setWarning('已放弃这张图；如果之前有已确认版本，现已恢复显示。');
    } catch (cause) {
      if (isCurrentProjectView(projectView)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentProjectView(projectView)) setBusy(false);
    }
  };

  const handleCompile = async () => {
    if (busy) return;
    if (!analysis) return;
    if (!brief.storyDraft || !brief.storyConfirmed) {
      setError('请先设计并确认新故事与对白；不再直接投影原片剧情。');
      setActivePanel('remix');
      return;
    }
    if (demoMode) {
      setCreativePack(DEMO_CREATIVE_PACK);
      setActivePanel('output');
      return;
    }
    const selectedCharacters = analysis.source_roles.map((role) => proposals?.role_sets.find((set) => set.source_role_id === role.role_id)?.candidates.find((candidate) => candidate.candidate_id === selections[role.role_id])).filter((candidate): candidate is CharacterCandidate => Boolean(candidate));
    if (selectedCharacters.length !== analysis.source_roles.length) {
      setError('请先为每个角色选择一个方案。');
      setActivePanel('characters');
      return;
    }
    const selectedAssets = selectedCharacters
      .map((candidate) => referenceAssetForCandidate(referenceAssets, candidate))
      .filter((asset): asset is ReferenceAsset => Boolean(asset?.approved));
    if (selectedAssets.length !== selectedCharacters.length) {
      setError('请先为每个已选角色保存参考图，并点击“确认采用”。');
      setActivePanel('characters');
      return;
    }
    const projectView = { ...projectViewRef.current };
    setBusy(true);
    setError('');
    setWarning('');
    setProgress('remixing');
    try {
      const data = compileOriginalStory(brief.storyDraft, analysis, brief, selectedCharacters, selectedAssets);
      // 第二道闸：编译完再独立校验一遍，纯本地不请求模型。宁可导不出，也不给一个悄悄错的包。
      validateCompiledOriginalPack(data, brief.outputLanguage);
      if (!isCurrentProjectView(projectView)) return;
      setCreativePack(data);
      setActivePanel('output');
      if (selectedAssets.some((asset) => asset.uri.startsWith('data:'))) {
        setWarning('生成包已完成，但包含仅本次会话可用的参考图，因此没有写入云端项目。请立即下载参考图并导出生成包。');
      } else {
        try {
          await persistProjectPatch({ stage: 'output', brief, creativePack: data, modelVersion, usage });
        } catch (saveCause) {
          if (isCurrentProjectView(projectView)) setWarning(`生成包已完成，但项目记录更新失败：${saveCause instanceof Error ? saveCause.message : String(saveCause)}。`);
        }
      }
    } catch (cause) {
      if (isCurrentProjectView(projectView)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentProjectView(projectView)) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const loadDemo = () => {
    if (busy) return;
    setAnalysis(DEMO_ANALYSIS);
    setCreativePack(DEMO_CREATIVE_PACK);
    setProposals(null);
    setSelections({});
    setReferenceAssets([]);
    projectLoadGenerationRef.current += 1;
    setHistoryLoading(false);
    switchProjectView('');
    setProjectTitle('完整演示项目');
    setProjectSourceName('');
    setBrief({
      ...INITIAL_BRIEF,
      characterBrief: '一名焦急的女大学生与一名克制、可靠的年长检修员；完全原创面孔和服装。',
      sourceRightsScope: 'owned_or_authorized',
    });
    setDemoMode(true);
    setActivePanel('dna');
    setError('');
    setWarning('');
  };

  const reset = () => {
    if (busy) return;
    setFile(null);
    setPreviewUrl('');
    setVideoMetadata({});
    setAnalysis(null);
    setProposals(null);
    setSelections({});
    setReferenceAssets([]);
    setCreativePack(null);
    projectLoadGenerationRef.current += 1;
    setHistoryLoading(false);
    switchProjectView('');
    setProjectTitle('');
    setProjectSourceName('');
    setBrief(INITIAL_BRIEF);
    setUsage(EMPTY_USAGE);
    setModelVersion('');
    setDemoMode(false);
    setError('');
    setWarning('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (analysis) {
    // 每一步「算不算完成」的判据。
    // 角色那一步沿用 CharactersPanel 里 readyToCompile 的同一条规则：
    // 每个源角色都选了方案、且参考图都已确认——两个条件缺一不可。
    const roleCount = analysis.source_roles.length;
    const chosenRoles = analysis.source_roles.filter((role) => {
      const candidate = proposals?.role_sets
        .find((set) => set.source_role_id === role.role_id)
        ?.candidates.find((item) => item.candidate_id === selections[role.role_id]);
      return Boolean(candidate && referenceAssetForCandidate(referenceAssets, candidate)?.approved);
    }).length;
    const storyDone = Boolean(brief.storyConfirmed);
    const charactersDone = roleCount > 0 && chosenRoles === roleCount;
    const previsDone = Boolean(previsReady);
    const packDone = Boolean(displayPack);

    const steps: FlowStep[] = [
      {
        id: 'dna', label: '拆解原片', icon: Dna, state: 'done',
        hint: `${analysis.beats.length} 段 · ${formatTime(analysis.source.duration_seconds)}`,
      },
      {
        id: 'remix', label: '改编故事', icon: WandSparkles,
        state: storyDone ? 'done' : activePanel === 'remix' ? 'active' : 'todo',
        hint: storyDone ? '新剧情与对白已确认' : '换掉角色身份，重写对白',
      },
      {
        id: 'characters', label: '设计角色', icon: Users,
        state: charactersDone ? 'done' : chosenRoles > 0 ? 'attention' : activePanel === 'characters' ? 'active' : 'todo',
        hint: charactersDone ? `${roleCount} 个角色已确认` : roleCount ? `${chosenRoles}/${roleCount} 个角色已确认参考图` : '为每个源角色选形象',
        blockedReason: storyDone ? undefined : '先确认新故事，角色才按新场景设计',
      },
      {
        id: 'previs', label: '生成预演', icon: Clapperboard,
        state: previsDone ? 'done' : activePanel === 'previs' ? 'active' : 'todo',
        hint: previsDone ? '全片 3D 预演已就绪' : '把 DNA 在 3D 里排一遍，渲成参考视频',
      },
      {
        id: 'output', label: '出片', icon: PackageCheck,
        state: packDone ? 'done' : activePanel === 'output' || activePanel === 'pipeline' ? 'active' : 'todo',
        hint: packDone ? '提示词已编译，可出片' : '提示词 + 预演视频，一起交给出片模型',
        blockedReason: charactersDone ? undefined : '先确认全部角色参考图',
      },
    ];

    return (
      <main className="min-h-screen bg-[#07120f] text-[#f3f0e7]">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_8%_2%,rgba(31,138,103,0.14),transparent_24%),radial-gradient(circle_at_88%_8%,rgba(199,164,93,0.08),transparent_18%)]" />
        <header className="relative z-30 flex h-[68px] items-center justify-between border-b border-white/7 bg-[#07120f]/90 px-5 backdrop-blur-xl lg:px-7">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-[13px] border border-emerald-200/15 bg-emerald-300/10 text-xs font-semibold text-emerald-100">镜</div>
            <div>
              <div className="flex items-center gap-2"><span className="text-sm font-semibold tracking-[0.08em]">镜感</span><span className="text-[9px] text-white/25">VIDEO DNA</span></div>
              <p className="mt-0.5 max-w-[260px] truncate text-[9px] text-white/28">{projectTitle || (demoMode ? '完整演示项目' : file?.name)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={showHistory} disabled={busy} className="hidden items-center gap-1.5 rounded-xl border border-white/8 px-3 py-2 text-[10px] text-white/42 hover:text-white/70 disabled:opacity-35 sm:inline-flex"><Archive size={13} /> 项目记录</button>
            <button
              type="button"
              onClick={() => downloadText('mirror-vibe-video-dna.json', JSON.stringify(analysis, null, 2), 'application/json')}
              className="hidden items-center gap-1.5 rounded-xl border border-white/8 px-3 py-2 text-[10px] text-white/42 hover:text-white/70 sm:inline-flex"
            >
              <Download size={13} /> 导出 DNA
            </button>
            <AccountMenu busy={busy} onHistory={showHistory} onSettings={() => setSettingsOpen(true)} />
          </div>
        </header>

        <div className="relative grid w-full lg:grid-cols-[232px_minmax(0,1fr)] 2xl:grid-cols-[248px_minmax(0,1fr)]">
          <aside className="min-w-0 border-r border-white/7 px-4 py-5 lg:sticky lg:top-0 lg:h-[calc(100vh-68px)] lg:overflow-y-auto">
            <div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025]">
              {previewUrl ? (
                <video src={previewUrl} controls className="aspect-video w-full bg-black object-contain" />
              ) : (
                <div className="grid aspect-video place-items-center bg-gradient-to-br from-emerald-300/10 to-[#d9b76c]/5">
                  <div className="text-center">{demoMode ? <Play size={22} className="mx-auto text-emerald-200/40" /> : <Archive size={22} className="mx-auto text-emerald-200/40" />}<p className="mt-2 text-[9px] text-white/25">{demoMode ? '完整演示项目' : 'DNA 已保存 · 原片可在预演页自动读取'}</p></div>
                </div>
              )}
              <div className="grid grid-cols-3 divide-x divide-white/6 border-t border-white/6 py-3 text-center">
                <div><p className="text-xs font-medium text-white/58">{formatTime(analysis.source.duration_seconds)}</p><p className="mt-1 text-[8px] text-white/22">时长</p></div>
                <div><p className="text-xs font-medium text-white/58">{analysis.source.aspect_ratio}</p><p className="mt-1 text-[8px] text-white/22">画幅</p></div>
                <div><p className="text-xs font-medium text-white/58">{analysis.beats.length}</p><p className="mt-1 text-[8px] text-white/22">段落</p></div>
              </div>
            </div>

            <FlowRail steps={steps} activeId={activePanel === 'pipeline' ? 'output' : activePanel} onSelect={(id) => setActivePanel(id as ActivePanel)} disabled={busy} />

            {(usage.totalTokens > 0 || modelVersion) && (
              <div className="mt-5 rounded-xl border border-white/6 bg-white/[0.02] p-3 text-[9px] leading-4 text-white/25">
                <p className="truncate">模型：{modelVersion || settings.model}</p>
                {usage.totalTokens > 0 && <p>累计 tokens：{usage.totalTokens.toLocaleString()}</p>}
              </div>
            )}
            {/* 四段的产出设定散在各页，随时要能一眼看全「这条片子是在什么设置下做出来的」。 */}
            <button type="button" onClick={() => setProductionOpen(true)} className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-emerald-200/18 bg-emerald-300/[0.06] py-2.5 text-[10px] text-emerald-100/75 hover:bg-emerald-300/[0.1]"><SlidersHorizontal size={12} /> 本片产出参数</button>
            <button type="button" onClick={reset} disabled={busy} className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/7 py-2.5 text-[10px] text-white/30 hover:text-white/60 disabled:cursor-not-allowed disabled:opacity-35"><RotateCcw size={12} /> 分析另一个视频</button>
          </aside>

          <section className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 2xl:px-10">
            {busy && progress && (
              <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-emerald-200/12 bg-emerald-300/[0.055] px-4 py-3 text-xs text-emerald-100/60"><LoaderCircle size={14} className="animate-spin" /> {stageLabel(progress)}</div>
            )}
            {error && (
              <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-300/12 bg-red-300/[0.045] px-4 py-3 text-xs leading-5 text-red-100/60"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}</div>
            )}
            {warning && <details className="mb-5 w-full rounded-xl border border-amber-200/15 px-4 py-2 text-sm text-amber-100/80"><summary className="min-h-11 cursor-pointer py-2.5">项目提示 · 查看详情</summary><p className="pb-3 leading-6">{warning}</p></details>}
            {/* 预演从「参考 DNA」里搬出来，独立成第④步。
                它以前寄生在分析结果页里——那页名字说的是「分析出了什么」，
                却藏着一个生成动作，用户找不到它是必然的。
                组件本身常驻（渲染中切走页面不能中断），只靠 visible 控制显隐。 */}
            {activePanel === 'previs' && proposals?.role_sets.some(s => s.candidates.some(c => selections[s.source_role_id] === c.candidate_id && (c.design_settings?.species || c.design_settings?.entity_type || c.design_settings?.body_plan))) && <p className="mb-5 w-full rounded-xl border border-amber-200/20 p-4 text-sm leading-6 text-amber-100/85">角色物种或身体结构已自定义。这里的预演仍展示原片动作，请核对新角色能否完成；如需调整动作，请先返回故事页编辑。导出角色身份以你确认的新角色图与设定为准。</p>}
            <AutoPrevisPanel key={projectId} projectId={projectId} analysis={analysis} file={file} sourceName={projectSourceName || file?.name} autoStart={autoPrevisProject === projectId && Boolean(projectId)} visible={activePanel === 'previs'} onStatus={handlePrevisStatus} renderShots={ticket => <PrevisShots ticket={ticket} analysis={analysis} brief={brief} assets={referenceAssets} characters={analysis.source_roles.flatMap(role => proposals?.role_sets.find(set => set.source_role_id === role.role_id)?.candidates.filter(candidate => candidate.candidate_id === selections[role.role_id]) ?? [])} />} />
            {activePanel === 'previs' && charactersDone && (
              <section className="mt-7 flex w-full flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5">
                <div>
                  <p className="text-sm font-medium text-white/75">
                    {previsDone ? '预演已就绪，导出提示词包就能出片' : '暂时不做预演？'}
                  </p>
                  {/* 不拦人，但把代价说清楚。预演要花一次模型调用，
                      强制必须先预演等于替用户决定这笔钱该不该花。 */}
                  <p className="mt-1 max-w-[52ch] text-sm leading-6 text-emerald-50/65">
                    {previsDone
                      ? '出片时会把预演按镜切段，和提示词一起交给模型。'
                      : '可先导出提示词；跳过后，出片时不带预演参考视频。'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCompile}
                  disabled={busy}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-35 ${previsDone ? 'bg-emerald-300 text-[#082018] hover:bg-emerald-200' : 'text-emerald-200 underline underline-offset-4 hover:text-emerald-100'}`}
                >
                  {progress === 'remixing' ? <LoaderCircle size={15} className="animate-spin" /> : <PackageCheck size={15} />}
                  {progress === 'remixing' ? '正在编译…' : previsDone ? '导出提示词包，去出片' : '跳过并导出提示词'}
                </button>
              </section>
            )}
            {activePanel === 'dna' && <DnaPanel analysis={analysis} brief={brief} onEditBeat={setEditingBeat} onContinue={() => setActivePanel('remix')} busy={busy} />}
            {activePanel === 'characters' && (!brief.storyConfirmed ? <div className="space-y-4 text-sm text-white/70"><p>先确认新故事，角色才会按新的场景、关系和动作设计。已有角色图仍保留。</p><button className="rounded-xl bg-emerald-300 px-4 py-3 text-[#082018]" onClick={() => setActivePanel('remix')}>去设计新故事</button></div> : <CharactersPanel analysis={analysis} brief={brief} projectId={projectId} onOpenSettings={() => setSettingsOpen(true)} proposals={proposals} selections={selections} referenceAssets={referenceAssets} onSaveProposals={async (value) => { const view = { ...projectViewRef.current }; await persistProjectPatch({ proposals: value, stage: 'characters' }); if (isCurrentProjectView(view)) setProposals(value); }} onSaveImage={async (candidate, image) => { await uploadReferenceAsset(candidate, image, `${candidate.candidate_id}.${imageExtension(image.type)}`, false); }} onBusy={setBusy} onSelect={handleSelectCandidate} onUploadReference={handleUploadReference} onApproveReference={handleApproveReference} onDiscardReference={handleDiscardReference} onGoPrevis={() => setActivePanel('previs')} onBriefChange={handleBriefChange} busy={busy} progress={progress} error={error} />)}
            {activePanel === 'remix' && <StoryPanel key={projectId} videoModelId={videoModelId} analysis={analysis} brief={brief.workflow === ORIGINAL_WORKFLOW ? brief : { ...INITIAL_BRIEF, characterBrief: brief.characterBrief, aspectRatio: brief.aspectRatio }} projectId={projectId} onChange={handleBriefChange} onSave={saveStoryBrief} onBusy={setBusy} onContinue={() => setActivePanel('characters')} />}
            {(activePanel === 'output' || activePanel === 'pipeline') && (
              <StepShell
                title="出片"
                intent={activePanel === 'output' && displayPack && isTextOnlyPack(displayPack) ? '逐段编辑提示词、下载角色图与 3D 参考，或提交角色图和提示词生成视频。' : '提示词说清拍什么，预演视频锁住镜头怎么动、人怎么走。两样一起交给出片模型。'}
                meta={activePanel === 'output' && displayPack && isTextOnlyPack(displayPack) ? 'API 仅附角色图与提示词 · 3D 参考需手动绑定' : previsDone ? '提示词已编译 · 预演已就绪' : '提示词已编译 · 没有预演，出片请求不会带参考视频'}
                status={activePanel === 'output' && displayPack && isTextOnlyPack(displayPack) ? '分镜已就绪' : previsDone ? '两样齐了' : '缺预演'}
                action={
                  // 两条出口是二选一，不是先后两步——以前把它们排成第④、第⑤项，
                  // 看起来像要依次走完，其实走完一条另一条就不必了。
                  <div className="flex gap-2" role="tablist" aria-label="出片方式">
                    {([
                      { id: 'pipeline' as const, label: '自动出片', detail: '程序调用接口，带质检与重试' },
                      { id: 'output' as const, label: '分镜创作', detail: '编辑、复制、下载素材或逐段生成' },
                    ]).filter((tab) => tab.id === 'output' || pipelineEnabled).map((tab) => {
                      const on = activePanel === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={on}
                          onClick={() => setActivePanel(tab.id)}
                          className={`flex-1 rounded-xl border px-4 py-3 text-left transition ${on ? 'border-emerald-200/25 bg-emerald-300/[0.07]' : 'border-white/7 hover:bg-white/[0.025]'}`}
                        >
                          <span className={`block text-[13px] font-medium ${on ? 'text-white/85' : 'text-white/45'}`}>{tab.label}</span>
                          <span className="mt-0.5 block text-[10px] leading-4 text-white/28">{tab.detail}</span>
                        </button>
                      );
                    })}
                  </div>
                }
                tuning={
                  <div className="space-y-3 text-xs leading-6 text-white/45">
                    <p className="max-w-[52ch]">
                      想换提示词内容，回第②步改故事或第③步换角色，然后在第④步重新导出。
                      这里的提示词是编译产物，直接改它下次导出就被覆盖了。
                    </p>
                    <button type="button" onClick={handleCompile} disabled={busy} className="rounded-xl border border-white/12 px-4 py-2.5 text-xs text-white/60 hover:text-white/85 disabled:opacity-35">
                      重新编译提示词包
                    </button>
                  </div>
                }
              >
                {activePanel === 'pipeline'
                  ? <PipelineLauncher projectId={projectId} projectTitle={projectTitle} videoModelId={videoModelId} />
                  : (displayPack && isTextOnlyPack(displayPack)
                      ? <OriginalOutputPanel pack={displayPack} referenceAssets={referenceAssets} projectId={projectId} videoModelId={videoModelId} preserve={brief.storyMode === 'preserve'} onVideoModelChange={(id) => { const config = loadConnection('video'); saveConnection('video', { ...config, model: id }); setVideoModelId(id); }} />
                      : <><p className="mb-4 text-sm text-amber-100/70">{creativePack ? '这是保留的旧版结果，不会自动改写。确认新故事后重新导出即可使用新版纯文字流程。' : '确认新故事与角色参考图后，在第④步导出提示词包。'}</p><OutputPanel pack={creativePack} /></>)}
              </StepShell>
            )}
          </section>
        </div>

        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />
        <ProductionSettingsDrawer open={productionOpen} onClose={() => setProductionOpen(false)} analysis={analysis} brief={brief} settings={settings} videoModelId={videoModelId} videoMetadata={videoMetadata} onReset={resetProductionSettings} />
        <HistoryDrawer open={historyOpen} projects={historyProjects} loading={historyLoading} onClose={() => setHistoryOpen(false)} onOpen={(id) => void openSavedProject(id)} />
        <ConfirmHost />
        {editingBeat && <BeatEditor beat={editingBeat} analysis={analysis} onCancel={() => setEditingBeat(null)} onSave={(next) => void saveBeatCorrection(next)} />}
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#07120f] text-[#f3f0e7]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_14%_8%,rgba(31,138,103,0.2),transparent_28%),radial-gradient(circle_at_86%_24%,rgba(199,164,93,0.12),transparent_22%)]" />
      <header className="relative z-30 flex w-full items-center justify-between px-6 py-6 lg:px-10">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-[14px] border border-emerald-200/15 bg-emerald-300/10 text-sm font-semibold text-emerald-100">镜</div>
          <div><div className="flex items-center gap-2"><span className="text-[15px] font-semibold tracking-[0.08em]">镜感</span><span className="rounded-full border border-[#c9a868]/25 bg-[#c9a868]/10 px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] text-[#e7c985]">VIDEO DNA</span></div><p className="mt-0.5 text-[11px] text-white/42">视频提示词工作台</p></div>
        </div>
        <AccountMenu busy={busy} onHistory={showHistory} onSettings={() => setSettingsOpen(true)} />
      </header>

      <section className="relative grid w-full gap-8 px-6 pb-12 pt-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.7fr)] lg:px-10 lg:pt-8">
        <div>
          <p className="mb-5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.2em] text-emerald-200/65"><span className="h-px w-8 bg-emerald-300/45" />GEMINI 视频导演分析</p>
          <h1 className="max-w-[780px] text-balance text-4xl font-semibold leading-tight tracking-tight">分析参考片，<span className="block text-emerald-200">创作同类型新故事。</span></h1>
          <p className="mt-5 max-w-[680px] text-base leading-7 text-white/60">先配置 AI 服务，再上传参考视频。拆解剧情和镜头，改编故事与角色，用 3D 分镜和提示词逐段测试。</p>
          <div className="mt-5 flex flex-wrap gap-2.5">{['Gemini 只分析一次', '对白与角色可编辑', '生成阶段不上传原片'].map((item) => <span key={item} className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-sm text-white/60">{item}</span>)}</div>
          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-y border-white/10 py-4">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm"><span className="inline-flex items-center gap-1.5 text-emerald-200"><Check size={15} />已登录</span><span className={analysisConfigured ? 'text-emerald-200' : 'text-amber-100/80'}>{analysisConfigured ? '分析服务已配置 · 尚未测试连接' : '分析服务待配置'}</span></div>
            <button type="button" disabled={busy} onClick={() => setSettingsOpen(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-emerald-200/25 bg-emerald-200/5 px-4 text-sm text-emerald-100 hover:bg-emerald-200/10 disabled:opacity-40"><SlidersHorizontal size={16} />{analysisConfigured ? 'AI 服务设置' : '配置 AI 服务'}</button>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={showHistory} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 px-4 text-sm text-white/75 hover:bg-white/5 disabled:opacity-40"><Archive size={16} />打开已有项目</button>
            <button type="button" disabled={busy} onClick={() => { const panel = document.getElementById('home-dna-import') as HTMLDetailsElement | null; if (panel) { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/15 px-4 text-sm text-white/75 hover:bg-white/5 disabled:opacity-40"><FileJson size={16} />导入分析 JSON</button>
          </div>

          {/* 主路径是「传视频 → 分析」，这张卡不该占着首屏。
              但里面的「恢复最近中转分析」不能删：分析扣了钱、结果却没进项目时，
              它是唯一不重新调用模型就能把那次返回取回来的路。所以收起，不删。 */}
          <details id="home-dna-import" className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
            <summary className="cursor-pointer list-none text-xs text-white/40 hover:text-white/65">
              导入分析 JSON / 找回最近分析（不重新调用模型）
            </summary>
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium text-white/82">导入 Gemini 返回的 Video DNA JSON</p><p className="mt-1 text-[10px] text-white/35">支持直接粘贴纯 JSON、Markdown 代码块，或上传 .json/.txt 文件。</p></div><a href="/Gemini网页-视频DNA分析提示词.txt" download className="inline-flex items-center gap-2 rounded-xl border border-emerald-200/15 px-3 py-2 text-[10px] text-emerald-100/70 hover:bg-emerald-300/10"><Download size={13} />下载 Gemini 模板</a></div>
              <textarea value={dnaJsonText} onChange={(event) => setDnaJsonText(event.target.value)} placeholder="把 Gemini 返回的完整 JSON 粘贴到这里……" className="mt-4 min-h-44 w-full resize-y rounded-2xl border border-white/8 bg-[#07120f] p-4 font-mono text-[11px] leading-5 text-white/68 outline-none placeholder:text-white/20 focus:border-emerald-200/25" />
              <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void handleImportDna()} disabled={busy || !dnaJsonText.trim()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-300 px-5 py-2.5 text-xs font-semibold text-[#082018] disabled:opacity-40">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <FileJson size={14} />}校验并进入项目</button><button type="button" onClick={() => dnaFileInputRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-white/9 px-4 py-2.5 text-xs text-white/55"><UploadCloud size={14} />选择 JSON 文件</button><button type="button" disabled={busy} onClick={async () => { try { const key = sessionStorage.getItem('mirror:relay:last-analysis'); if (!key) throw new Error('暂无中转分析缓存。'); const result = await recoverRelayTask(key) as { text?: string }; if (!result.text) throw new Error('缓存中没有完整分析文本。'); setDnaJsonText(result.text); setWarning('分析原始结果已恢复到输入框；校验或修改后进入项目，不会重复调用模型。'); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} className="rounded-xl border border-white/10 px-4 py-2.5 text-xs text-white/55">恢复最近中转分析</button></div>
            </div>
          </details>

          {!file ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); pickFile(event.dataTransfer.files?.[0] ?? null); }}
              className="group mt-5 block w-full rounded-[28px] border border-dashed border-emerald-200/20 bg-gradient-to-br from-white/[0.075] to-white/[0.025] p-2 text-center transition hover:border-emerald-200/40"
            >
              <span className="flex min-h-[190px] flex-col items-center justify-center rounded-[22px] border border-white/[0.05] bg-[#0b1a16]/75 px-6 transition group-hover:bg-[#0d201a]">
                <span className="mb-5 grid h-12 w-12 place-items-center rounded-2xl border border-emerald-200/15 bg-emerald-300/10 text-emerald-100 transition group-hover:-translate-y-0.5"><UploadCloud size={20} /></span>
                <span className="text-sm font-medium text-white/86">拖入参考视频，或点击选择</span>
                <span className="mt-2 text-xs text-white/34">MP4 · MOV · WebM · 保留画面与声音</span>
                <span className="mt-5 text-xs leading-5 text-emerald-100/60">选择文件只在本机预览；点击开始分析后才通过你的中转服务上传，并消耗模型额度。</span>
              </span>
            </button>
          ) : (
            <div className="mt-10 rounded-[24px] border border-white/9 bg-white/[0.035] p-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                {previewUrl && (
                  <video
                    src={previewUrl}
                    controls
                    playsInline
                    onLoadedMetadata={(event) => setVideoMetadata({ durationSeconds: event.currentTarget.duration, width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })}
                    className="aspect-video w-full rounded-xl bg-black object-contain sm:w-48"
                  />
                )}
                <div className="min-w-0 flex-1 py-1">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-white/75">{file.name}</p><p className="mt-1 text-[10px] text-white/30">{formatBytes(file.size)}{videoMetadata.durationSeconds ? ` · ${formatTime(videoMetadata.durationSeconds)}` : ''}</p></div><button type="button" onClick={clearSelectedFile} disabled={busy} className="text-[10px] text-white/28 hover:text-white/60 disabled:cursor-not-allowed disabled:opacity-35">移除</button></div>
                  {/* 这是一次付费调用，点下去之前必须先把「用什么模型、看多少画面、大概多少 token」摊开说。 */}
                  {(() => {
                    const preview = analysisPreview(loadConnection('analysis'), settings, videoMetadata);
                    return <div className={`mt-4 rounded-xl border px-3.5 py-2.5 text-[10px] leading-5 ${preview.effective ? 'border-white/10 bg-white/[0.02] text-white/45' : 'border-amber-200/25 bg-amber-300/[0.06] text-amber-100/80'}`}>
                      <p className="font-medium text-white/70">分析模型：{preview.model || '（未选模型）'}</p>
                      <p className="mt-1">{preview.frames ? `预计输入约 ${preview.promptTokens.toLocaleString()} token，以中转实际用量为准` : '读到视频时长后显示预计用量'}{videoMetadata.durationSeconds ? ` · 源片 ${videoMetadata.durationSeconds.toFixed(1)} 秒` : ''}</p>
                    </div>;
                  })()}
                  <label className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-white/60"><input type="checkbox" checked={automaticPrevis} disabled={busy} onChange={event => setAutomaticPrevis(event.target.checked)} className="mt-1 accent-emerald-400" /><span>分析后自动生成全片动作预演：视频分析 1 次＋DNA 全片编排 1 次，之后 Blender 本地渲染。不自动追加模型调用，结果待复看。需本地预演服务；当前预演支持源片 ≤512 MiB、≤10 分钟（本地处理边界，不是中转上限）。</span></label>
                  <button type="button" onClick={analysisConfigured ? handleAnalyze : () => setSettingsOpen(true)} disabled={busy} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-300 px-5 py-2.5 text-sm font-semibold text-[#082018] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Video size={14} />}{busy ? stageLabel(progress) : !analysisConfigured ? '先配置分析服务' : automaticPrevis ? '开始分析并生成预演' : '开始分析'}</button>
                </div>
              </div>
            </div>
          )}

          <input ref={fileInputRef} type="file" accept=".mp4,.mpeg,.mpg,.mov,.avi,.flv,.webm,.wmv,.3gp,.3gpp" className="sr-only" onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
          <input ref={dnaFileInputRef} type="file" accept=".json,.txt,application/json,text/plain" className="sr-only" onChange={(event) => void loadDnaFile(event.target.files?.[0] ?? null)} />
          {/* 分析失败必须说重话：以前这里只是一条淡红小字，用户重跑失败后回到项目里看到的还是旧分析，
              会以为「跑了但没变化」。要明说本次没有产出、你看到的是上一次的。 */}
          {error && <div className="mt-4 rounded-xl border border-rose-300/30 bg-rose-400/[0.09] px-4 py-3.5 text-xs leading-6 text-rose-50/85">
            <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-1 shrink-0" /><div>
              <p className="font-semibold">本次分析没有成功，没有生成任何新的 DNA。</p>
              <p className="mt-1 text-rose-100/70">{error}</p>
              <p className="mt-2 text-rose-100/55">项目记录里的仍然是上一次的分析结果——如果你刚才重跑过，看到内容没变化，是因为这次根本没跑出来，不是模型又给了同样的答案。</p>
            </div></div>
          </div>}
        </div>

        <aside className="self-start rounded-[28px] border border-white/[0.09] bg-[#0b1915]/90 p-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-medium">从参考片到你的作品</h2><span className="rounded-full bg-emerald-300/10 px-3 py-1 text-xs text-emerald-200">5 步</span></div>
          <ol className="mt-7 space-y-3">{[
            ['01', '拆解原片', '分析剧情、镜头、动作和声音', true],
            ['02', '改编故事', '保留或改写剧情，调整对白语言', false],
            ['03', '设计角色', '修改性别、物种与形象，确认参考图', false],
            ['04', '分镜预演', '本机渲染 3D，逐镜检查动作和运镜 · 可跳过', false],
            ['05', '生成与导出', '编辑提示词、下载素材，逐段测试', false],
          ].map(([number, title, detail, active]) => <li key={String(number)} className={`flex items-center gap-4 rounded-2xl border px-4 py-3.5 ${active ? 'border-emerald-200/16 bg-emerald-300/[0.075]' : 'border-white/[0.055] bg-white/[0.025]'}`}><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl text-xs font-semibold ${active ? 'bg-emerald-300 text-[#082018]' : 'bg-white/[0.055] text-white/60'}`}>{number}</span><div><p className="text-sm font-medium text-white/85">{title}</p><p className="mt-1 text-xs leading-5 text-white/60">{detail}</p></div></li>)}</ol>
          <details className="mt-5 border-t border-white/10 pt-4">
            <summary className="cursor-pointer text-sm leading-6 text-white/75">渲染助手：{helperStatus === 'ready' ? '已就绪' : helperStatus === 'setup' ? '已连接，环境待准备' : helperStatus === 'unavailable' ? '暂未连接' : helperStatus === 'outdated' ? '版本过旧，需换新版' : '尚未检查'}<span className="block text-xs text-white/50">仅做 3D 预演时需要，点击查看并检查</span></summary>
            <div className="mt-4"><RenderHelperCard onStatusChange={setHelperStatus} /></div>
          </details>
          {helperDownloads && !helperDownloads.lightReady && <p className="mt-3 text-xs leading-5 text-amber-100/75">助手安装包尚未公开发布；已有助手可连接，新用户可先跳过预演进行分镜测试。</p>}
          <div className="mt-5 border-t border-white/10 pt-4 text-sm leading-6 text-white/60"><p>生成阶段不上传原片。API 自动提交角色图与提示词；使用 3D 全能参考时，需要在即梦手动上传预演视频并绑定素材。</p></div>
          <button type="button" onClick={loadDemo} disabled={busy} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/8 py-2.5 text-[10px] text-white/42 transition hover:border-emerald-200/18 hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-35"><Play size={12} /> 查看完整演示结果</button>
        </aside>
      </section>

      <footer className="relative flex w-full flex-col justify-between gap-3 border-t border-white/6 px-6 py-5 text-[9px] text-white/22 sm:flex-row lg:px-10"><p>本地优先 · BYOK · 结构化 JSON · Gemini 临时文件主动删除</p><p>方法参考 video-to-prompt 与 awesome-gpt-image-2；具体实现与提示词协议已重写。</p></footer>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />
      <HistoryDrawer open={historyOpen} projects={historyProjects} loading={historyLoading} onClose={() => setHistoryOpen(false)} onOpen={(id) => void openSavedProject(id)} />
      {/* 上传页也要挂：上次分析没跑完时的「可能已扣费，要不要重提」就发生在这里。 */}
      <ConfirmHost />
    </main>
  );
}
