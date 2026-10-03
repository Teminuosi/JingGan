'use client';

import { useEffect, useRef, useState } from 'react';
import { applyDialogueTranslation, assertPreservedDraft, buildDialogueTranslationTask, buildDraftPromptSet, ORIGINAL_PROMPT_CHARACTER_LIMIT, buildStoryTask, LOCK_LABELS, ORIGINAL_WORKFLOW, parseStoryDraft, projectPreservedDraft, resizePreservedBeat, splitPreservedBeat, suggestSplitPoint } from '../lib/original-story';
import { generateRelayText, loadConnection, recoverRelayTask } from '../lib/relay-client';
import { videoModel } from '../lib/video-models';
import { redactRelayError, requireRelayText } from '../lib/relay-protocol';
import { downloadText } from '../lib/export';
import { DEFAULT_LOCKS } from '../lib/types';
import { DIALOGUE_LANGUAGES } from '../lib/dialogue-languages';
import type { ActionBeat, CreativeBeat, DnaLockKey, RemixBrief, VideoDnaAnalysis } from '../lib/types';

const inputClass = 'mt-2 w-full rounded-xl border border-white/15 bg-[#07120f] p-3 text-sm leading-6 text-white/85';
const buttonClass = 'rounded-xl border border-emerald-200/25 px-4 py-3 text-sm text-emerald-100 disabled:opacity-40';

export function StoryPanel({ analysis, brief, projectId, videoModelId, onChange, onSave, onContinue, onBusy }: {
  analysis: VideoDnaAnalysis; brief: RemixBrief; projectId: string; videoModelId: string;
  onChange: (brief: RemixBrief) => void;
  onSave: (brief: RemixBrief) => Promise<void>;
  onContinue: () => void;
  onBusy: (value: boolean) => void;
}) {
  const [text, setText] = useState(() => brief.storyDraft ? JSON.stringify(brief.storyDraft, null, 2) : '');
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [showGeneration, setShowGeneration] = useState(!brief.storyDraft);
  const [copied, setCopied] = useState('');
  // 复制区在页面下方，顶部的消息框滚出视野后看不到；复制相关的提示就地显示。
  const [promptNote, setPromptNote] = useState<{ text: string; error?: boolean }>();
  const [promptTarget, setPromptTarget] = useState<'jimeng' | 'full'>('jimeng');
  const [promptLang, setPromptLang] = useState<'zh' | 'en'>('zh');
  // 生成成功这类一次性通知几秒后自动收起，报错留着。
  const [transient, setTransient] = useState(false);
  const current = useRef(brief);
  const alive = useRef(true);
  useEffect(() => { current.current = brief; }, [brief]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!transient || !message) return;
    const timer = setTimeout(() => { setMessage(''); setTransient(false); }, 6000);
    return () => clearTimeout(timer);
  }, [transient, message]);
  const notify = (text: string) => { setMessage(text); setTransient(true); };
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);
  const acceptResult = async (raw: string, recovered = false) => {
    if (!alive.current) return;
    let checked;
    try {
      checked = parseStoryDraft(raw, analysis);
    } catch (cause) {
      // 只有校验不过才把原始返回摊进 JSON 框供手工修；正常成功时不该拿 JSON 糊用户一脸。
      setText(raw);
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} 这次的原始返回已放进下方“高级：导入或修改完整故事 JSON”，可以手工改好再点确认；看不懂就点“下载本次返回诊断”。`);
    }
    await onSave({ ...current.current, workflow: ORIGINAL_WORKFLOW, mode: 'full_original', storyMode: 'rewrite', storyDraft: checked, storyConfirmed: false, storyJobId: undefined });
    if (alive.current) {
      setShowGeneration(false);
      setText(JSON.stringify(checked, null, 2));
      notify(recovered
        ? `已找回上次那份《${checked.title}》并保存，没有重新调用模型，也没有再次扣费。请检查对白后确认。`
        : '故事已生成并保存，请检查对白后确认。');
    }
  };
  const preserve = brief.storyMode === 'preserve';
  // 保留原剧情：本地确定性投影源 DNA（不花钱），只有翻译台词那一步调模型。
  const translate = async () => {
    if (waiting || running) return;
    setWaiting(true); setRunning(true); onBusy(true);
    setMessage(translating && hasDialogue
      ? '正在本地投影原片分镜，然后只把台词送去翻译。剧情、镜头、动作与时长不经过模型。'
      : '正在本地投影原片分镜，成片不带对白，全程不调用模型。');
    try {
      const projected = projectPreservedDraft(analysis, { dialogue: translating });
      const speaking = projected.beats.filter(b => b.dialogue.trim()).length;
      let draft = projected;
      if (speaking > 0) {
        const raw = await generateRelayText(buildDialogueTranslationTask(analysis, brief), `translate:${projectId}`);
        draft = applyDialogueTranslation(projected, raw, brief);
      }
      await onSave({ ...current.current, workflow: ORIGINAL_WORKFLOW, mode: 'character_swap', storyMode: 'preserve', storyDraft: draft, storyConfirmed: false, storyJobId: undefined });
      if (alive.current) {
        setShowGeneration(false);
        setText(JSON.stringify(draft, null, 2));
        notify(speaking > 0
          ? `原片 ${projected.beats.length} 个镜头已逐镜保留，${speaking} 条台词已译成${brief.outputLanguage}。请检查后确认。`
          : `原片 ${projected.beats.length} 个镜头已逐镜保留；翻译选的是「无」${hasDialogue ? `，原片那 ${dialogueCount} 条台词不写进成片` : '（原片本来没有对白）'}，提示词会明确禁止配音。未调用模型、未产生费用。请检查后确认。`);
      }
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) { setWaiting(false); setRunning(false); onBusy(false); } }
  };
  const generate = async () => {
    if (waiting || running) return;
    setWaiting(true); setRunning(true); onBusy(true);
    setMessage('正在通过中转文本模型设计故事，请保持此页面打开。旧结果保留，不再次调用视频分析。');
    try {
      const raw = await generateRelayText(buildStoryTask(analysis, brief, shotCap).replace('输出 story-draft.json。', '仅返回 JSON 内容，不创建文件。'), `story:${projectId}`);
      await acceptResult(raw);
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) { setWaiting(false); setRunning(false); onBusy(false); } }
  };
  const recover = async () => {
    if (waiting || running) return;
    setWaiting(true);
    try {
      if (preserve) {
        // 没调过模型就没有可找回的东西。原来这里照样重新投影一遍并保存，
        // 等于用一份新草稿把用户改过的内容冲掉——找回失败必须什么都不动。
        if (!translating || !hasDialogue) {
          setMessage(hasDialogue
            ? '「翻译」选的是「无」，这一步全部在本地完成，没有调用过模型，也就没有可找回的结果。要重做分镜，用上面的「生成原剧情分镜」。'
            : '原片没有对白，这一步全部在本地完成，没有调用过模型，也就没有可找回的结果。要重做分镜，用上面的「生成原剧情分镜」。');
          return;
        }
        const projected = projectPreservedDraft(analysis, { dialogue: translating });
        const draft = projected.beats.some(b => b.dialogue.trim())
          ? applyDialogueTranslation(projected, requireRelayText(await recoverRelayTask(`translate:${projectId}`)), brief)
          : projected;
        await onSave({ ...current.current, workflow: ORIGINAL_WORKFLOW, mode: 'character_swap', storyMode: 'preserve', storyDraft: draft, storyConfirmed: false, storyJobId: undefined });
        if (alive.current) {
          setShowGeneration(false);
          setText(JSON.stringify(draft, null, 2));
          setMessage('已恢复原片分镜与对白并保存，未重新调用模型。请检查后确认。');
        }
      } else {
        await acceptResult(requireRelayText(await recoverRelayTask(`story:${projectId}`)), true);
      }
    }
    catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setWaiting(false); }
  };
  const downloadDiagnostic = async () => {
    try {
      const result = await recoverRelayTask(`${preserve ? 'translate' : 'story'}:${projectId}`);
      const safe = JSON.stringify(result, (key, value) => /^(authorization|api[_-]?key|access_token|refresh_token|x-relay-key)$/i.test(key) ? '[密钥已隐藏]' : value, 2);
      downloadText('story-relay-diagnostic.json', redactRelayError(safe, loadConnection('text').apiKey, Infinity), 'application/json');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const confirm = async () => {
    setWaiting(true);
    try {
      const parsed = JSON.parse(text) as typeof brief.storyDraft;
      const roleIds = new Set(analysis.source_roles.map((_, index) => `CHAR_${String.fromCharCode(65 + index)}`));
      for (const beat of parsed?.beats ?? []) {
        let previous = beat.start_seconds;
        for (const step of beat.action_beats ?? []) {
          if (!Number.isFinite(step.at_seconds) || step.at_seconds < previous || step.at_seconds >= beat.end_seconds) throw new Error(`${beat.beat_id} 的动作时间必须按顺序排列，且位于本段起止时间内。`);
          if (!step.action.trim()) throw new Error(`${beat.beat_id} 有空的动作拍点，请填写动作。`);
          if (!step.actor_ids.length || [...step.actor_ids, ...(step.toward_ids ?? [])].some(id => !roleIds.has(id))) throw new Error(`${beat.beat_id} 的动作角色无效，请使用已有 CHAR_A 等角色编号。`);
          previous = step.at_seconds;
        }
      }
      // 保留模式的草稿只有两条差异轴、时间轴照抄源片，套重写线的校验会被误拦。
      if (preserve) { if (!parsed) throw new Error('草稿为空。'); assertPreservedDraft(parsed, analysis); }
      const draft = preserve ? parsed! : parseStoryDraft(text, analysis);
      await onSave({ ...brief, workflow: ORIGINAL_WORKFLOW, mode: preserve ? 'character_swap' : 'full_original', storyMode: preserve ? 'preserve' : 'rewrite', storyDraft: draft, storyConfirmed: true, storyJobId: undefined });
      if (alive.current) onContinue();
    } catch (error) { if (alive.current) setMessage(String(error)); }
    finally { if (alive.current) setWaiting(false); }
  };
  // 拆镜和改时长只动时间轴，不改剧情内容：源片有超过目标模型上限的长镜时，这是唯一的出路。
  const applyDraft = (next: ReturnType<typeof splitPreservedBeat>) => {
    setText(JSON.stringify(next, null, 2));
    onChange({ ...brief, storyDraft: next, storyConfirmed: false });
    setMessage('');
  };
  const splitAt = (index: number, atSeconds?: number) => {
    if (!brief.storyDraft) return;
    try { applyDraft(splitPreservedBeat(brief.storyDraft, index, atSeconds)); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const resizeAt = (index: number, seconds: number) => {
    if (!brief.storyDraft || !Number.isFinite(seconds)) return;
    try {
      const next = resizePreservedBeat(brief.storyDraft, index, seconds);
      applyDraft(next);
      // 改边界不会改动作文字：这一镜要装的内容没变、时间变了，下一镜同理，需要人工把描述改到对得上。
      const after = next.beats[index + 1];
      setMessage(`第 ${index + 1} 镜改为 ${seconds} 秒，少的时间由第 ${index + 2} 镜吸收（现在 ${+(after.end_seconds - after.start_seconds).toFixed(1)} 秒），总长仍是 ${next.beats.at(-1)!.end_seconds} 秒。注意：动作与场景文字没有跟着改，这两镜的描述要自己调到与新时长相称；想让内容跟着一起分开，用「从中间拆成两镜」。`);
    }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
  };
  const editBeat = (index: number, field: keyof CreativeBeat, value: string | string[]) => {
    const draft = brief.storyDraft;
    if (!draft) return;
    const next = { ...draft, beats: draft.beats.map((b, i) => i === index ? { ...b, [field]: value } : b) };
    setText(JSON.stringify(next, null, 2));
    onChange({ ...brief, storyDraft: next, storyConfirmed: false });
  };
  const editActionBeat = (index: number, stepIndex: number, patch: Partial<ActionBeat>) => {
    const draft = brief.storyDraft;
    if (!draft) return;
    const next = { ...draft, beats: draft.beats.map((beat, i) => i === index
      ? { ...beat, action_beats: beat.action_beats?.map((step, n) => n === stepIndex ? { ...step, ...patch } : step) }
      : beat) };
    setText(JSON.stringify(next, null, 2));
    onChange({ ...brief, storyDraft: next, storyConfirmed: false });
  };
  // 提示词随草稿实时生成：改了分镜文字，复制出来的就是改后的版本，不用先确认。
  // 中英文都在本地拼：英文用的是拆解时 Gemini 一起给的英文，不再调模型。
  const copyPrompt = async (key: string, name: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setPromptNote({ error: true, text: '复制失败，请检查浏览器是否允许访问剪贴板。' });
      return;
    }
    setCopied(key);
    setTimeout(() => { if (alive.current) setCopied(''); }, 2000);
    setPromptNote({ text: `已复制${name}（${text.length.toLocaleString()} 字）。` });
  };
  const locked = running || waiting;
  // 拆镜建议要瞄准目标模型一次能生成多长；这里用整档上限，不套用重写线那条 10 秒叙事约束。
  const modelCap = (() => { const target = videoModel(videoModelId); return target.fixedSeconds ?? target.maxSeconds; })();
  // 重写线每镜上限：默认 min(10, 档位)，用户可以在下面改到档位上限——想要长镜就得让他改得动。
  const defaultShotCap = Math.min(10, modelCap);
  const shotCap = Math.max(3, Math.min(modelCap, Math.floor(brief.maxShotSeconds ?? defaultShotCap)));
  const modelRatios = videoModel(videoModelId).ratios ?? [];
  // 即梦就是 seedance：选的是 seedance 档就按它的单次上限切；选了别家模型时按即梦最常见的 15 秒档切。
  const jimengCap = videoModelId.startsWith('seedance') ? modelCap : 15;
  const prompts = (() => {
    if (!brief.storyDraft) return null;
    try { return buildDraftPromptSet(brief.storyDraft, analysis, brief, jimengCap); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  })();
  const locks = brief.locks ?? DEFAULT_LOCKS;
  // 源片有没有台词，决定这一步到底要不要翻译。
  // 逻辑上本来就跳过了（speaking === 0 时不调模型），但界面一路写着「只翻译对白」
  // 「正在翻译台词」，还花大段解释翻译怎么计费——看着像要干一件根本不会发生的事。
  const dialogueCount = analysis.beats.filter(b => b.dialogue?.source_text?.trim()).length;
  const hasDialogue = dialogueCount > 0;
  // 「翻译」选「无」是默认：不调模型、不花钱，成片也不会凭空多出一段人声。
  // 只有显式选了语种才翻译；outputLanguage 始终是真实语种，不塞哨兵值进提示词。
  const translating = brief.translateDialogue === true;
  const toggleLock = (key: DnaLockKey) => onChange({ ...brief, locks: { ...locks, [key]: !locks[key] }, storyConfirmed: false });
  const draft = brief.storyDraft;
  const primaryClass = 'min-h-11 rounded-xl bg-emerald-300 px-5 py-3 text-sm font-semibold text-[#082018] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="min-w-0 w-full space-y-7 pb-10 text-white/85">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-white">改编故事</h2>
          <p className="mt-2 text-sm leading-6 text-white/60">先确定故事和对白，再为角色设计形象。</p>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-200/20 px-3 py-1.5 text-xs text-emerald-100">{brief.storyConfirmed ? '已确认' : draft ? '待确认' : '待开始'}</span>
      </header>

      <section aria-label="改编方式" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="mr-2 text-sm font-medium text-white/65">改编方式</h3>
          {([['preserve', '保留原剧情'], ['rewrite', '重写新故事']] as const).map(([id, label]) => <button key={id} type="button" disabled={locked} aria-pressed={(brief.storyMode ?? 'rewrite') === id}
            onClick={() => { onChange({ ...brief, storyMode: id, storyConfirmed: false }); setShowGeneration(true); setMessage(''); }}
            className={`min-h-11 rounded-xl border px-4 py-2.5 text-sm transition disabled:opacity-40 ${(brief.storyMode ?? 'rewrite') === id ? 'border-emerald-300/60 bg-emerald-300/10 text-emerald-100' : 'border-white/15 text-white/65 hover:border-white/35'}`}>{label}</button>)}
        </div>
        <p className="text-sm leading-6 text-white/60">{preserve
          ? '沿用原片的剧情、镜头、动作与时长。角色形象在下一步更换。'
          : '沿用原片的拍摄风格与节奏，重新设计剧情、场景和对白。'}</p>
        {draft && <button type="button" disabled={locked} aria-expanded={showGeneration} onClick={() => setShowGeneration(!showGeneration)} className="min-h-11 text-sm text-emerald-200 underline decoration-emerald-200/30 underline-offset-4 disabled:opacity-40">{showGeneration ? '收起生成选项' : '需要调整？重新生成故事'}</button>}
        {(!draft || showGeneration) && <div className="space-y-5 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6">
          {draft && <p className="text-sm text-amber-100/85">重新生成成功后会替换当前故事，已有角色图会保留。</p>}
          {!preserve && <label className="block text-sm">故事方向<textarea className={`${inputClass} min-h-28`} disabled={locked}
            placeholder="想把故事改成什么？留空则由模型构思。"
            value={brief.newConcept} onChange={e => onChange({ ...brief, newConcept: e.target.value, storyConfirmed: false })} /></label>}
          <label className="block max-w-sm text-sm">{preserve ? '翻译' : '对白语言'}
            <select className={inputClass} disabled={locked}
              value={preserve && !translating ? 'none' : brief.outputLanguage}
              onChange={e => onChange(e.target.value === 'none'
                ? { ...brief, translateDialogue: false, storyConfirmed: false }
                : { ...brief, translateDialogue: true, outputLanguage: e.target.value, storyConfirmed: false })}>
              {preserve && <option value="none">无 · 没有对白的片子</option>}
              {!DIALOGUE_LANGUAGES.some(item => item.value === brief.outputLanguage) && <option value={brief.outputLanguage}>{brief.outputLanguage}</option>}
              {DIALOGUE_LANGUAGES.map(item => <option key={item.value} value={item.value}>{preserve ? `译成${item.label}` : item.label}</option>)}
            </select>
            <span className="mt-2 block text-xs leading-5 text-white/55">{!preserve
              ? '新故事的对白用这个语言写。已有台词不会自动改写，切换后请重新生成或自行编辑。'
              : translating
                ? '原片台词译成这个语言，说话人和说话窗口不变。调用一次文本模型，按用量计费。'
                : hasDialogue
                  ? `成片没有人说话。原片这 ${dialogueCount} 条台词不会写进提示词，也不会生成配音。想保留台词就在上面选一个语种。`
                  : '原片没有对白，保持「无」即可。不调用模型，不产生费用。'}</span>
          </label>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <button type="button" className={primaryClass} disabled={locked || !projectId} onClick={() => void (preserve ? translate() : generate())}>
              {running ? '正在生成，请稍候…' : preserve ? (translating && hasDialogue ? '保留原剧情并翻译对白' : '生成原剧情分镜') : '生成新故事'}
            </button>
            <p className="text-xs leading-5 text-white/55">{preserve ? translating && hasDialogue ? '分镜本地生成，仅对白翻译会调用模型计费。' : '全部本地生成，不调用模型、不计费。' : '调用文本模型生成，按模型用量计费。'}</p>
          </div>
        </div>}
      </section>

      {message && <div role="status" aria-live="polite" className="rounded-xl border border-emerald-200/20 bg-emerald-300/5 px-5 py-4 text-sm leading-6 text-emerald-50">{message}</div>}

      {draft && <section aria-label="故事结果" className="min-w-0 space-y-5 border-t border-white/10 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><p className="text-xs font-medium tracking-widest text-emerald-200">故事草稿 · {draft.beats.length} 个分镜</p><h3 className="mt-2 text-xl font-semibold leading-8 text-white">{draft.title}</h3></div>
        </div>
        <p className="text-sm leading-7 text-white/70">{draft.concept_summary}</p>
        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className={primaryClass} disabled={locked || !text.trim()} onClick={() => void confirm()}>确认故事，继续设计角色 →</button>
          <span className="text-xs leading-5 text-white/55">确认时保存修改；角色图会继续保留。</span>
        </div>
        {prompts && <section aria-label="复制视频提示词" className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h4 className="mr-1 text-sm font-medium text-white">复制视频提示词</h4>
            {([['jimeng', '即梦版'], ['full', '其他 AI 版']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={promptTarget === id} onClick={() => { setPromptTarget(id); setPromptNote(undefined); }} className={`min-h-9 rounded-lg border px-3 text-sm ${promptTarget === id ? 'border-emerald-300/60 bg-emerald-300/10 text-emerald-100' : 'border-white/15 text-white/60 hover:border-white/35'}`}>{label}</button>)}
            <span aria-hidden="true" className="h-5 w-px bg-white/15" />
            {([['zh', '中文'], ['en', '英文']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={promptLang === id} onClick={() => { setPromptLang(id); setPromptNote(undefined); }} className={`min-h-9 rounded-lg border px-3 text-sm ${promptLang === id ? 'border-emerald-300/60 bg-emerald-300/10 text-emerald-100' : 'border-white/15 text-white/60 hover:border-white/35'}`}>{label}</button>)}
            <details className="ml-auto text-xs text-white/55">
              <summary className="min-h-9 cursor-pointer leading-9 text-white/55">说明</summary>
              <p className="mt-1 max-w-xl leading-5">不用等角色设计，角色已写成文字描述。即梦单次最多 {jimengCap} 秒、{ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字，所以分段，按顺序逐段生成再拼接，每段都能单独粘贴；其他 AI 版是整片一条。中英文都在本地生成，不花钱，英文来自拆解时 Gemini 同时给出的英文。</p>
            </details>
          </div>
          {'error' in prompts ? <p className="text-sm leading-6 text-amber-100">{prompts.error}</p>
            : promptLang === 'en' && prompts.englishUnavailable ? <p className="text-sm leading-6 text-amber-100">{prompts.englishUnavailable}</p>
              : <>
                {promptLang === 'en' && !!prompts.englishMissing.length && <p className="text-xs leading-5 text-amber-100/85">{prompts.englishMissing.join('、')} 改过内容，英文版里这几镜仍是中文。想要全英文，把改动撤回或重新生成原剧情分镜。</p>}
                <ol className="divide-y divide-white/10 border-y border-white/10">
                  {(promptTarget === 'jimeng' ? prompts.segments : [prompts.full]).map((item, i, list) => {
                    const text = promptLang === 'en' ? item.en : item.zh;
                    const key = `${promptTarget}${i}${promptLang}`;
                    const name = `${promptTarget === 'jimeng' ? (list.length > 1 ? `即梦版第 ${i + 1} 段` : '即梦版') : '整片'}${promptLang === 'en' ? '英文' : '中文'}提示词`;
                    return <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                      <span className="w-14 shrink-0 text-sm tabular-nums text-emerald-200">{promptTarget === 'jimeng' ? (list.length > 1 ? `第 ${i + 1} 段` : '即梦版') : '整片'}</span>
                      <span className="min-w-0 flex-1 text-xs tabular-nums text-white/60">{item.start}–{item.end} 秒 · {text.length.toLocaleString()} 字{promptTarget === 'jimeng' && text.length > ORIGINAL_PROMPT_CHARACTER_LIMIT && <span className="text-amber-200"> · 单镜就超过 {ORIGINAL_PROMPT_CHARACTER_LIMIT.toLocaleString()} 字，粘贴到即梦会被截断</span>}</span>
                      <button type="button" className={buttonClass} disabled={locked} onClick={() => void copyPrompt(key, name, text)}>{copied === key ? '已复制' : '复制'}</button>
                    </li>;
                  })}
                </ol>
              </>}
          {promptNote && <p role="status" aria-live="polite" className={`text-xs leading-5 ${promptNote.error ? 'text-amber-100' : 'text-emerald-100/80'}`}>{promptNote.text}</p>}
        </section>}
        <div className="pt-2">
          <div className="mb-3 flex items-baseline justify-between gap-3"><h4 className="text-sm font-medium">逐镜检查</h4><span className="text-xs text-white/50">展开分镜，查看或修改内容</span></div>
          <div className="min-w-0 divide-y divide-white/10 border-y border-white/10">
            {draft.beats.map((b, i) => {
              const cut = suggestSplitPoint(b, preserve ? modelCap : shotCap);
              const duration = +(b.end_seconds - b.start_seconds).toFixed(3);
              return <details key={b.beat_id} className="group">
                <summary className="flex cursor-pointer list-none items-start gap-3 py-5 [&::-webkit-details-marker]:hidden">
                  <span className="mt-0.5 w-7 shrink-0 text-sm font-medium tabular-nums text-emerald-200">{String(i + 1).padStart(2, '0')}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-white/55"><span>{b.start_seconds}–{b.end_seconds} 秒</span><span>{duration} 秒</span>{duration > modelCap && <span className="text-amber-200">超过模型单次 {modelCap} 秒上限 · 可拆镜</span>}</div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/85">{b.action || '暂无动作描述'}</p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-white/55">{b.dialogue ? `对白：${b.dialogue}` : '未提取到对白原文；声音详情见下方'}</p>
                  </div>
                  <span aria-hidden="true" className="mt-1 text-white/50 transition-transform group-open:rotate-90">›</span>
                </summary>
                <fieldset disabled={locked} className="space-y-4 pb-6 sm:pl-10">
                  <p className="text-xs text-white/55">出场角色：{b.character_ids.join(' / ') || '未指定'}</p>
                  {([['action', '动作与剧情'], ['environment', '场景'], ['dialogue', '对白']] as const).map(([field, label]) => <label className="block text-sm" key={field}>{label}<textarea className={`${inputClass} ${field === 'action' ? 'min-h-28' : ''}`} value={b[field]} onChange={e => editBeat(i, field, e.target.value)} />{field === 'dialogue' && <span className="mt-1 block text-xs text-white/50">有对白时请保留 CHAR_A: 等说话人标记。</span>}</label>)}
                  <div className="grid gap-5 border-y border-white/10 py-5 md:grid-cols-2">
                    {([['story_function', '段落作用'], ['performance', '角色表演'], ['framing', '景别'], ['camera_motion', '运镜'], ['lighting', '光线与色彩'], ['continuity', '构图与连续性'], ['sound', '声音与音效']] as const).map(([field, label]) => <label key={field} className="block text-sm text-emerald-200/80">{label}<textarea className={inputClass} value={b[field]} onChange={e => editBeat(i, field, e.target.value)} /></label>)}
                    <label className="block text-sm text-emerald-200/80">道具（每行一个）<textarea className={inputClass} value={b.props.join('\n')} onChange={e => editBeat(i, 'props', e.target.value.split('\n').filter(value => value.trim()))} /></label>
                  </div>
                  {!!b.action_beats?.length && <div>
                    <h5 className="mb-3 text-sm font-medium text-emerald-200">完整动作顺序 · {b.action_beats.length} 个拍点</h5>
                    <p className="mb-4 text-xs leading-6 text-white/55">可直接修改；时间是相对整片的秒数。修改后请重新确认故事。</p>
                    <ol className="space-y-5">
                      {b.action_beats.map((step, n) => <li key={n} className="space-y-4 rounded-xl border border-white/10 p-4">
                        <div className="flex flex-wrap items-end gap-4">
                          <label className="text-sm">时间（秒）<input type="number" step="0.1" min={b.start_seconds} max={b.end_seconds} className={`${inputClass} max-w-28`} value={step.at_seconds} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value)) editActionBeat(i, n, { at_seconds: value }); }} /></label>
                          <label className="text-sm">执行角色<input className={inputClass} value={step.actor_ids.join(', ')} onChange={e => editActionBeat(i, n, { actor_ids: e.target.value.split(/[,，、\s]+/).filter(Boolean) })} /></label>
                          <label className="text-sm">指向角色<input className={inputClass} value={(step.toward_ids ?? []).join(', ')} onChange={e => editActionBeat(i, n, { toward_ids: e.target.value.split(/[,，、\s]+/).filter(Boolean) })} /></label>
                        </div>
                        <label className="block text-sm">动作<textarea className={inputClass} value={step.action} onChange={e => editActionBeat(i, n, { action: e.target.value })} /></label>
                        <div className="grid gap-4 md:grid-cols-2">
                          <label className="block text-sm">反应<textarea className={inputClass} value={step.reaction ?? ''} onChange={e => editActionBeat(i, n, { reaction: e.target.value })} /></label>
                          <label className="block text-sm">结果<textarea className={inputClass} value={step.consequence ?? ''} onChange={e => editActionBeat(i, n, { consequence: e.target.value })} /></label>
                        </div>
                      </li>)}
                    </ol>
                  </div>}
                  <details className="rounded-xl border border-white/10 px-4">
                    <summary className="min-h-11 cursor-pointer py-3 text-xs text-white/65">调整时长与拆镜</summary>
                    <div className="space-y-3 pb-4 text-xs leading-6 text-white/60">
                      <p>修改时长会调整与下一镜的边界；动作文字需要同步检查。</p>
                      <div className="flex flex-wrap items-center gap-3">
                        <label>本镜时长<input aria-label={`第 ${i + 1} 镜时长`} type="number" step="0.5" min="1" className="ml-2 min-h-11 w-20 rounded-lg border border-white/15 bg-[#07120f] px-2 text-white" disabled={locked || i === draft.beats.length - 1} value={duration} onChange={e => resizeAt(i, Number(e.target.value))} /> 秒</label>
                        <button type="button" disabled={locked || duration < 2} className={buttonClass} onClick={() => splitAt(i, cut?.at)}>{cut ? `在 ${cut.at} 秒处拆镜` : '从中间拆成两镜'}</button>
                      </div>
                      {i === draft.beats.length - 1 && <p>最后一镜的时长由前面镜头决定，请调整前一镜。</p>}
                    </div>
                  </details>
                </fieldset>
              </details>;
            })}
          </div>
        </div>
      </section>}

      <div className="min-w-0 divide-y divide-white/10 border-y border-white/10">
        <details>
          <summary className="min-h-12 cursor-pointer py-4 text-sm text-white/65">更多设置 · 画幅{!preserve && '与创作偏好'}</summary>
          <fieldset disabled={locked} className="grid gap-5 pb-6 sm:grid-cols-2">
            <label className="text-sm">画幅<select className={inputClass} value={brief.aspectRatio} onChange={e => onChange({ ...brief, aspectRatio: e.target.value, storyConfirmed: false })}><option value={analysis.source.aspect_ratio}>跟随原片 · {analysis.source.aspect_ratio}</option>{modelRatios.filter(r => r !== analysis.source.aspect_ratio).map(r => <option key={r} value={r}>{r}</option>)}</select><span className="mt-1 block text-xs leading-5 text-white/50">改变比例后，需要重新检查原片构图。</span></label>
            {!preserve && <label className="text-sm">每镜最长秒数<input type="number" min={3} max={modelCap} step="1" className={inputClass} value={shotCap} onChange={e => onChange({ ...brief, maxShotSeconds: Number(e.target.value), storyConfirmed: false })} /><span className="mt-1 block text-xs leading-5 text-white/50">默认 {defaultShotCap} 秒；{videoModelId} 单次最长 {modelCap} 秒。</span></label>}
            {!preserve && ([
              ['settingBrief', '场景与道具偏好', '例如：把豪宅争执改为工作室误会'],
              ['characterBrief', '角色与审美偏好', '描述角色形象方向'],
              ['dialogueBrief', '对白语气与内容', '例如：短句、试探性的口气']
            ] as const).map(([key, label, placeholder]) => <label key={key} className="text-sm">{label}<textarea className={inputClass} placeholder={placeholder} value={brief[key]} onChange={e => onChange({ ...brief, [key]: e.target.value, storyConfirmed: false })} /></label>)}
            <label className="text-sm">声线偏好<input className={inputClass} value={brief.voiceBrief} onChange={e => onChange({ ...brief, voiceBrief: e.target.value, storyConfirmed: false })} /></label>
            <label className="text-sm">参考素材权利声明<select className={inputClass} value={brief.sourceRightsScope === 'unselected' ? 'owned_or_authorized' : brief.sourceRightsScope} onChange={e => onChange({ ...brief, sourceRightsScope: e.target.value as RemixBrief['sourceRightsScope'] })}><option value="owned_or_authorized">自有 / 已获授权</option><option value="third_party_reference">第三方参考（只学形式，重写内容）</option></select></label>
            {!preserve && <div className="sm:col-span-2"><p className="text-sm">沿用原片的拍摄方式</p><p className="mt-1 text-xs leading-5 text-white/50">选中的维度沿用原片；其余由模型根据新故事设计。</p><div className="mt-3 flex flex-wrap gap-2">{(Object.keys(LOCK_LABELS) as DnaLockKey[]).map(key => <button key={key} type="button" aria-pressed={locks[key]} onClick={() => toggleLock(key)} className={`min-h-11 rounded-xl border px-3 py-2 text-xs ${locks[key] ? 'border-emerald-300/45 bg-emerald-300/10 text-emerald-100' : 'border-white/15 text-white/60'}`}>{locks[key] ? '✓ ' : ''}{LOCK_LABELS[key]}</button>)}</div></div>}
          </fieldset>
        </details>
        <details>
          <summary className="min-h-12 cursor-pointer py-4 text-sm text-white/65">上次生成中断？找回结果</summary>
          <div className="space-y-3 pb-5"><p className="text-sm leading-6 text-white/55">从本机缓存找回当前模式最近一次的结果，不重新调用模型。找回成功后会替换当前故事；没有缓存时，已有故事不受影响。</p><button type="button" className={buttonClass} disabled={locked || !projectId} onClick={() => void recover()}>找回上次结果</button></div>
        </details>
        <details>
          <summary className="min-h-12 cursor-pointer py-4 text-sm text-white/65">高级编辑与诊断</summary>
          <div className="space-y-4 pb-5">
            {draft && <details><summary className="min-h-11 cursor-pointer py-3 text-sm">查看改编说明</summary><ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-white/60">{draft.differentiation_log.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
            <label className="block text-sm">高级：导入或修改完整故事 JSON<textarea aria-label="故事 JSON" className={`${inputClass} min-h-64 font-mono`} value={text} disabled={locked} onChange={e => { setText(e.target.value); onChange({ ...brief, storyConfirmed: false }); }} /></label>
            {!draft && <button type="button" className={buttonClass} disabled={locked || !text.trim()} onClick={() => void confirm()}>确认导入故事，继续设计角色</button>}
            <button type="button" className={buttonClass} disabled={locked || !projectId} onClick={() => void downloadDiagnostic()}>下载本次返回诊断</button>
          </div>
        </details>
      </div>
    </div>
  );
}
