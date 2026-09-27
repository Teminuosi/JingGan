// Prompt Compiler 主入口。
//
// 职责只有三件：选模板、渲染、按预算裁剪。
// 不去数据库取数、不调网络、不带随机数——保持纯函数，才可能做到「同输入同输出」，
// 而这条性质是缓存、去重、防重复扣费、A/B 对比共同的地基。

import type { ShotDna } from '../shot-dna/types';
import { BUILTIN_TEMPLATES } from './templates';
import type { CompileContext, CompiledPrompt, PromptSection, PromptTarget, PromptTemplate } from './types';

export * from './types';
export { BUILTIN_TEMPLATES, KEYFRAME_TEMPLATE_V1, VIDEO_TEMPLATE_V1 } from './templates';

const registry = new Map<string, PromptTemplate>();
for (const t of BUILTIN_TEMPLATES) registry.set(`${t.name}@${t.version}`, t);

export function registerTemplate(template: PromptTemplate): void {
  registry.set(`${template.name}@${template.version}`, template);
}

/** 不指定版本时取该名字下版本号最大的一个。 */
export function getTemplate(name: string, version?: string): PromptTemplate {
  if (version) {
    const exact = registry.get(`${name}@${version}`);
    if (!exact) throw new Error(`没有提示词模板 ${name}@${version}`);
    return exact;
  }
  const all = [...registry.values()].filter((t) => t.name === name)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!all.length) throw new Error(`没有提示词模板 ${name}`);
  return all[0];
}

export function templatesFor(target: PromptTarget): PromptTemplate[] {
  return [...registry.values()].filter((t) => t.target === target);
}

/**
 * FNV-1a。不用 crypto.subtle 是因为它是异步的，而编译必须是同步纯函数；
 * 这里只要「同输入同输出、不同输入基本不撞」，不需要密码学强度。
 */
export function fingerprint(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function renderSections(sections: PromptSection[]): string {
  return sections.map((s) => `【${s.title}】\n${s.lines.join('\n')}`).join('\n\n');
}

export interface CompileOptions {
  templateName?: string;
  templateVersion?: string;
}

/**
 * 编译一个镜头的提示词。
 *
 * 超长处理：按 priority 从低到高整段丢弃，而不是从中间截断字符串。
 * 截断会把一句话切一半，模型读到残句反而会自由发挥；整段丢弃至少语义是完整的。
 * 丢了什么一定要回报给调用方（dropped），绝不静默——静默降级就是退款。
 */
export function compileShotPrompt(dna: ShotDna, ctx: CompileContext, opts: CompileOptions = {}): CompiledPrompt {
  const template = getTemplate(opts.templateName ?? 'video-shot', opts.templateVersion);
  const { sections, negative } = template.render(dna, ctx);

  const kept = [...sections];
  const dropped: string[] = [];
  const budget = ctx.maxChars ?? Infinity;
  while (renderSections(kept).length > budget && kept.length > 1) {
    // 找优先级最低的一段。同优先级时丢后面的，保持前段稳定。
    let worst = 0;
    for (let i = 1; i < kept.length; i += 1) if (kept[i].priority <= kept[worst].priority) worst = i;
    dropped.push(kept[worst].key);
    kept.splice(worst, 1);
  }

  const text = renderSections(kept);
  const negativeText = [...new Set(negative.filter(Boolean))].join('，');

  return {
    template: template.name,
    version: template.version,
    target: template.target,
    sections: kept,
    text,
    negative: negativeText,
    // 指纹覆盖模板身份 + 正文 + 负向词：任何一处变了就是另一份提示词，
    // 缓存不能命中，重复扣费的判断也不能把它当成同一次请求。
    fingerprint: fingerprint(`${template.name}@${template.version}\n${text}\n${negativeText}`),
    dropped,
    charCount: text.length,
  };
}

/** 两版模板的逐段差异。后台「Prompt 版本对比」直接用。 */
export interface SectionDiff {
  key: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  before?: string[];
  after?: string[];
}

export function diffPrompts(a: CompiledPrompt, b: CompiledPrompt): SectionDiff[] {
  const keys = [...new Set([...a.sections.map((s) => s.key), ...b.sections.map((s) => s.key)])];
  return keys.map((key) => {
    const before = a.sections.find((s) => s.key === key)?.lines;
    const after = b.sections.find((s) => s.key === key)?.lines;
    if (!before) return { key, status: 'added' as const, after };
    if (!after) return { key, status: 'removed' as const, before };
    const same = before.length === after.length && before.every((l, i) => l === after[i]);
    return { key, status: same ? ('same' as const) : ('changed' as const), before, after };
  });
}
