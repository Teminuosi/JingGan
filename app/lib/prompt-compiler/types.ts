// Prompt Compiler 的数据契约。
//
// 规格第十四章要求把提示词生成独立成一层并且版本化。为什么值得单独一层：
// 现在提示词散在 prompts.ts / original-story.ts / VideoTargetPanel.tsx 三处拼字符串，
// 改一处另外两处不知道，也没法回答「上周那批片子是用哪版提示词跑的」。
//
// 三条硬要求：
//  1. 确定性 —— 同样的输入必须产出逐字相同的字符串。否则缓存、去重、A/B 对比全不成立。
//  2. 分段 —— 输出不是一坨字符串，而是有名字的段落。质检要能说「是 camera 段写错了」，
//     A/B 对比要能逐段 diff，超长时要能按优先级砍段而不是从中间截断。
//  3. 带版本指纹 —— 每次产出都记下模板名+版本+输入指纹，存进 shots.prompt_template。

import type { ShotDna } from '../shot-dna/types';

/** 提示词段落。priority 越大越重要，超长裁剪时从小的开始砍。 */
export interface PromptSection {
  key: string;
  title: string;
  lines: string[];
  priority: number;
}

export interface CompiledPrompt {
  template: string;
  version: string;
  target: PromptTarget;
  sections: PromptSection[];
  /** 拼接后的正文。 */
  text: string;
  negative: string;
  /** 输入指纹：同样的 Shot DNA + 同样的模板 → 同样的指纹。用于缓存和防重复扣费。 */
  fingerprint: string;
  /** 被裁掉的段落 key。不为空说明提示词超限，必须让用户看见，不许静默丢内容。 */
  dropped: string[];
  charCount: number;
}

export type PromptTarget = 'video' | 'image_keyframe' | 'blender' | 'qa';

/** 编译一个镜头需要的全部外部信息。Shot DNA 之外的东西都从这里进，模板不许自己去别处取。 */
export interface CompileContext {
  /** 角色 ID → 外观描述。视频模型靠它保持形象一致。 */
  characters: Record<string, CharacterBrief>;
  /** 全片统一的风格锁，每镜都要带，否则镜与镜之间画风会漂。 */
  styleLock: {
    pacing: string;
    camera: string;
    visual: string;
    performance: string;
    sound: string;
    negativeConstraints: string[];
  };
  /** 对白语言。空表示这一镜不要对白。 */
  dialogueLanguage: string;
  /** 目标模型的提示词字符上限。超了就按 priority 砍段。 */
  maxChars?: number;
  /** 上一镜的收尾状态，用于写「承接」段。首镜为空。 */
  previousShot?: Pick<ShotDna, 'shot_id' | 'continuity' | 'environment' | 'camera'>;
  /** 本镜是否已有 Blender 预演，有的话提示词要引用它的空间关系。 */
  blenderPreview?: { cameraPath: string; blocking: string };
  /** 重试时传入：上一次失败的原因，模板会据此加强对应段落。 */
  retryHint?: { failureClass: string; note: string };
}

export interface CharacterBrief {
  character_id: string;
  name: string;
  appearance: string;
  wardrobe: string;
  /** 参考图槽位标记，如 `图1`。有参考图时提示词要显式指认「谁是图1」。 */
  referenceSlot?: string;
}

export interface PromptTemplate {
  name: string;
  version: string;
  target: PromptTarget;
  /** 这一版改了什么。后台对比两版效果时看的就是它。 */
  changelog: string;
  render(dna: ShotDna, ctx: CompileContext): { sections: PromptSection[]; negative: string[] };
}
