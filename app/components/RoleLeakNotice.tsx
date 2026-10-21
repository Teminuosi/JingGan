import type { RoleLeak } from '../lib/types';

const KIND_LABELS: Record<RoleLeak['kind'], string> = { species: '物种', appearance: '外观', voice: '叫声', motion: '动作习惯' };

/** 被换掉物种的角色，原有说法还留在出片文字里：按词合并列出出现位置。只提示，不自动改。 */
export function RoleLeakNotice({ leaks, className = '' }: { leaks?: RoleLeak[]; className?: string }) {
  if (!leaks?.length) return null;
  const groups = new Map<string, { leak: RoleLeak; where: Set<string> }>();
  for (const leak of leaks) {
    const key = `${leak.characterId}|${leak.term}`;
    const group = groups.get(key) ?? { leak, where: new Set<string>() };
    group.where.add(leak.where);
    groups.set(key, group);
  }
  const hard = [...groups.values()].filter(({ leak }) => leak.kind !== 'motion');
  const soft = [...groups.values()].filter(({ leak }) => leak.kind === 'motion');
  const line = ({ leak, where }: { leak: RoleLeak; where: Set<string> }) => <li key={`${leak.characterId}|${leak.term}`}><span className="font-medium text-amber-50">{leak.characterId} 原{KIND_LABELS[leak.kind]}词「{leak.term}」</span><span className="ml-2 text-amber-100/70">出现在：{[...where].join('、')}</span></li>;
  return <div role="status" className={`border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs leading-6 text-amber-100 ${className}`}>
    {hard.length > 0 && <><p className="font-medium">换了物种的角色，提示词里还留着原角色的说法（{hard.length} 个词）。提交前请手动改掉，否则画面可能和角色图打架。</p><ul className="mt-1 list-disc pl-5">{hard.map(line)}</ul></>}
    {soft.length > 0 && <><p className={hard.length ? 'mt-2 font-medium' : 'font-medium'}>以下是原角色的动作习惯，请确认新角色做得出来：</p><ul className="mt-1 list-disc pl-5">{soft.map(line)}</ul></>}
  </div>;
}
