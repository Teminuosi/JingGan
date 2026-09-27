'use client';

import { analysisPreview } from '../lib/gemini';
import { Drawer, overlayButton } from './Overlay';
import { loadConnection } from '../lib/relay-client';
import { LOCK_LABELS, ORIGINAL_PROMPT_CHARACTER_LIMIT, ORIGINAL_RUN_MAX_SECONDS, PRESERVE_RUN_MAX_SECONDS } from '../lib/original-story';
import { loadParamProbes, videoModel, videoParamSpecs, type ParamProbe } from '../lib/video-models';
import { DEFAULT_LOCKS } from '../lib/types';
import type { AnalysisSettings, DnaLockKey, LocalVideoMetadata, RemixBrief, VideoDnaAnalysis } from '../lib/types';

/**
 * 一条片子从分析到生成，中间每一个会影响成片的设定都摆在这里。
 *
 * 为什么要有这个面板：单个旋钮就近摆在各自那一步是对的（改完立刻看到影响），
 * 但用户随时会想问「我这条片子到底是在什么设置下做出来的」。没有总览时这个问题只能靠翻四个页面回答，
 * 而且「哪些还是默认值」根本看不出来——静默按默认值跑出次品，正是最容易导致退款的那类体验。
 */

type Row = {
  label: string;
  value: string;
  /** true = 当前就是默认值。用来标出「你还没管过这一项」。 */
  isDefault?: boolean;
  /** 系统硬限制，只能看不能改；要写清楚这条线是谁定的。 */
  fixed?: boolean;
  hint?: string;
  /** 明确的风险：会让产出变差的设置，要显眼。 */
  warn?: boolean;
  where?: string;
};

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return <section className="rounded-2xl border border-white/10 p-4">
    <h3 className="text-xs font-semibold tracking-wide text-emerald-200">{title}</h3>
    <dl className="mt-3 space-y-2.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[9rem_1fr] gap-3 text-xs leading-5">
          <dt className="text-white/40">{row.label}</dt>
          <dd className={row.warn ? 'text-amber-200' : 'text-white/75'}>
            <span>{row.value}</span>
            {row.fixed && <span className="ml-2 rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/40">系统限制</span>}
            {row.isDefault && !row.fixed && <span className="ml-2 rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-white/35">默认值</span>}
            {(row.hint || row.where) && <p className="mt-0.5 text-[10px] leading-4 text-white/30">{row.hint}{row.hint && row.where ? ' · ' : ''}{row.where && `改这里：${row.where}`}</p>}
          </dd>
        </div>
      ))}
    </dl>
  </section>;
}

export function ProductionSettingsDrawer({ open, onClose, analysis, brief, settings, videoModelId, videoMetadata, onReset }: {
  open: boolean;
  onClose: () => void;
  analysis: VideoDnaAnalysis | null;
  brief: RemixBrief;
  settings: AnalysisSettings;
  videoModelId: string;
  videoMetadata: LocalVideoMetadata;
  onReset: () => void;
}) {
  if (!open) return null;
  const connection = loadConnection('analysis');
  const preview = analysisPreview(connection, settings, videoMetadata.durationSeconds ? videoMetadata : { durationSeconds: analysis?.source.duration_seconds });
  const target = videoModel(videoModelId);
  const modelCap = target.fixedSeconds ?? target.maxSeconds;
  const preserve = brief.storyMode === 'preserve';
  const locks = preserve ? DEFAULT_LOCKS : (brief.locks ?? DEFAULT_LOCKS);
  const lockedNames = (Object.keys(LOCK_LABELS) as DnaLockKey[]).filter((key) => locks[key]).map((key) => LOCK_LABELS[key]);
  const shotCap = Math.max(3, Math.min(modelCap, Math.floor(brief.maxShotSeconds ?? Math.min(10, modelCap))));
  // 视频参数与它们的来源：本页是总览，用户在这儿就该看清"这一档有几项是真试过的"。
  const videoSpecs = videoParamSpecs(target, loadParamProbes(videoModelId) as Record<string, ParamProbe>);
  const tally = { verified: 0, documented: 0, assumed: 0 };
  for (const spec of videoSpecs) tally[spec.source] += 1;
  const savedSeconds = (() => {
    if (typeof window === 'undefined') return undefined;
    try {
      const raw = (JSON.parse(localStorage.getItem('mirror:video-params') || '{}') as Record<string, Record<string, unknown>>)[videoModelId]?.seconds;
      const value = Number(raw);
      return raw === undefined || raw === '' || !Number.isFinite(value) ? undefined : value;
    } catch { return undefined; }
  })();
  const secondsValue = target.fixedSeconds !== undefined ? `固定 ${target.fixedSeconds} 秒`
    : savedSeconds !== undefined ? `手动固定为 ${savedSeconds} 秒`
    : `自动：按每段分镜时长（${target.allowedSeconds ? `只能取 ${target.allowedSeconds.join(' / ')} 秒` : `${target.minSeconds ?? 1}–${target.maxSeconds} 秒`}）`;
  const candidates = Math.max(2, Math.min(6, Math.floor(brief.candidateCount ?? 4)));

  return <Drawer
    open
    onClose={onClose}
    eyebrow="PRODUCTION"
    title="本片产出参数"
    description="这条片子从分析到生成用的全部设定。标「默认值」的是你还没管过的，标「系统限制」的改不了但你该知道它存在。"
    footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[10px] leading-4 text-white/30">「恢复推荐值」只改回本页列出的产出设定，不动 Key、模型选择和已生成的内容。</p>
      <div className="flex gap-2">
        <button type="button" onClick={onReset} className={overlayButton.secondary}>全部恢复推荐值</button>
        <button type="button" onClick={onClose} className={overlayButton.primary}>知道了</button>
      </div>
    </div>}
  >
      <div className="space-y-4">
        <Section title="① 分析 · 决定 DNA 有多准" rows={[
          { label: '分析模型', value: connection.model || '未选择', where: '齿轮 →① 视频分析' },
          { label: '本次预计用量', value: preview.frames ? `约 ${preview.promptTokens.toLocaleString()} 输入 token` : '需要视频时长才能估算', fixed: true },
          { label: '中转视频上限', value: '尚未确认；24.2 MB 已实际分析成功', hint: 'HeyRoute 文档写的是 100 MB 请求体入口限制；base64 约增加三分之一体积，不能视作视频可用上限' },
          { label: '本地预演边界', value: '源片 ≤512 MiB、≤10 分钟、≤150 镜', fixed: true, hint: '这是本应用处理边界；单次全片编排还受模型输出长度限制，超出会停止，不自动增加调用' },
        ]} />

        <Section title="② 故事 · 决定讲什么、怎么拍" rows={[
          { label: '模式', value: preserve ? '保留原剧情 · 只翻译对白' : '重写新故事', isDefault: !preserve, where: '新故事页顶部' },
          { label: 'DNA 锁', value: lockedNames.length ? `锁住 ${lockedNames.length}/6：${lockedNames.join('、')}` : '六项全部解锁，风格完全交给模型重新设计',
            isDefault: !preserve && lockedNames.length === 6, hint: preserve ? '保留原剧情是逐镜复刻，六项强制全锁' : '锁住的维度逐字沿用源片，解锁的由模型重新设计', where: '新故事页 · 产出控制' },
          { label: '每镜最长', value: preserve ? '由源片镜头边界决定' : `${shotCap} 秒`, isDefault: !preserve && brief.maxShotSeconds === undefined, where: '新故事页 · 产出控制' },
          { label: '画幅', value: brief.aspectRatio || '未设置', isDefault: brief.aspectRatio === analysis?.source.aspect_ratio, hint: analysis ? `源片是 ${analysis.source.aspect_ratio}` : undefined, where: '新故事页 · 产出控制' },
          { label: '对白语言', value: brief.outputLanguage || 'English', isDefault: brief.outputLanguage === 'English', where: '新故事页' },
          { label: '权利声明', value: brief.sourceRightsScope === 'owned_or_authorized' ? '自有 / 已获授权' : '第三方参考', isDefault: brief.sourceRightsScope === 'owned_or_authorized', where: '新故事页' },
        ]} />

        <Section title="③ 角色 · 决定形象与花销" rows={[
          { label: '文本模型', value: loadConnection('text').model || '未选择', where: '齿轮 →② 故事和角色方案' },
          { label: '图片模型', value: loadConnection('image').model || '未选择', where: '齿轮 →③ 角色参考图' },
          { label: '每角色候选数', value: `${candidates} 套`, isDefault: brief.candidateCount === undefined,
            hint: analysis ? `本步将生成 ${analysis.source_roles.length * candidates} 张图` : undefined, where: '角色映射页' },
          { label: '参考图提示词', value: '可逐个角色改写', hint: '改词后该角色的旧图不再算数，需要重新生成', where: '角色映射页 · 参考图提示词' },
        ]} />

        <Section title="④ 视频生成 · 决定成片" rows={[
          { label: '视频模型', value: videoModelId || '未选择', hint: `单次最长 ${modelCap} 秒`, where: '齿轮 →④ 视频生成' },
          { label: '单段时长', value: secondsValue, isDefault: target.fixedSeconds === undefined && savedSeconds === undefined,
            fixed: target.fixedSeconds !== undefined,
            hint: target.fixedSeconds !== undefined ? '这一档只出这个长度，写别的值会被上游拒'
              : savedSeconds !== undefined ? '所有段都按这个秒数提交并计费，画面节奏会和分镜对不上'
              : '留空就按每段分镜自己的时长推导；想统一固定长度可以在请求参数里手填',
            where: 'Seedance 包页 · 请求参数' },
          { label: '请求参数', value: `${videoSpecs.filter((spec) => spec.editable !== false).length} 项可配 / 共 ${videoSpecs.length} 项`, hint: '时长、分辨率、比例、尺寸、种子、音频、负面词、分镜表、输出格式——这一档不认的也会列出来并写明原因，不会悄悄发送', where: 'Seedance 包页 · 请求参数' },
          { label: '参数来源', value: `实测 ${tally.verified} · 据文档 ${tally.documented} · 未验证 ${tally.assumed}`,
            warn: tally.assumed > 0,
            hint: '「据文档」= 中转参数表这么写但本机没试过；「未验证」= 文档没写清、是保守推断。在请求参数里点「探测这一档的真实限制」可以免费试真',
            where: 'Seedance 包页 · 请求参数' },
          { label: '参考图清晰度', value: '默认 1280px', isDefault: true, hint: '越高清请求体越大，角色多时更容易超时', where: 'Seedance 包页 · 请求参数' },
          { label: '分段时长上限', value: `重写线 ${ORIGINAL_RUN_MAX_SECONDS} 秒 / 保留线 ${PRESERVE_RUN_MAX_SECONDS} 秒`, fixed: true, hint: 'Seedance 单次生成能力，超过会被拦下并提示拆镜' },
          { label: '提示词长度上限', value: `${ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字符`, fixed: true, hint: '上游对单条提示词的硬限制；接近上限时会自动按镜头边界分段，不会截断内容' },
        ]} />
      </div>

  </Drawer>;
}
