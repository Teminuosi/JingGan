'use client';

import { useState } from 'react';
import type { RemixBrief, RoleDesignSettings, VideoDnaAnalysis } from '../lib/types';
import { buildCharacterDesignInstruction } from '../lib/prompts';
import { resolveSourceRoleCastingEnvelope, resolveSourceRoleEntity } from '../lib/entity-profile';

const input = 'mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-[#07120f] px-3 py-2 text-sm text-white/85';
const typeHints = {
  unknown: { label: '物种 / 角色名称', options: ['自定义角色'], age: '填写年龄或生命阶段', wardrobe: '填写服装、外壳或配饰', prompt: '描述角色外观、材质和表情', body: '描述身体、四肢和操作道具的结构' },
  human: { label: '人物身份 / 名称', options: ['人类', '厨师', '青年探险家', '工程师'], age: '例如：青年、成年、中年、老年', wardrobe: '例如：厨师服、工作服、眼镜', prompt: '例如：短发、沉稳神态、蓝色工作服', body: '例如：人类双足、正常人类手部结构' },
  animal: { label: '物种 / 角色名称', options: ['狗', '金毛犬', '猫', '兔子', '熊猫', '狐狸'], age: '例如：幼年、成年、老年', wardrobe: '例如：无服装、项圈、胸背带', prompt: '例如：金色短毛、圆耳、蓬松尾巴', body: '例如：犬科四足、保留犬爪' },
  anthropomorphic_animal: { label: '物种 / 角色名称', options: ['拟人猫', '拟人狗', '拟人兔子', '拟人狐狸'], age: '例如：幼年、成年、老年', wardrobe: '例如：围裙、夹克、帽子', prompt: '例如：金色短毛、憨厚神态、蓝色围裙', body: '例如：拟人双足、保留动物头部和爪部' },
  robot: { label: '机器人型号 / 名称', options: ['服务机器人', '工业机器人', '仿生机器人', '机械宠物'], age: '例如：全新、使用多年、老旧型号', wardrobe: '例如：金属外壳、工具腰带、显示屏', prompt: '例如：白色外壳、蓝色指示灯、圆形头部', body: '例如：机械双足、机械臂、轮式底盘' },
  creature: { label: '幻想种族 / 名称', options: ['龙', '精灵', '树人', '史莱姆'], age: '例如：幼体、成体、远古', wardrobe: '例如：护甲、斗篷、无配饰', prompt: '例如：蓝色鳞片、透明双翼、发光双眼', body: '例如：四足双翼、树枝手臂、软体结构' },
  anthropomorphic_object: { label: '物体类型 / 名称', options: ['拟人茶杯', '拟人台灯', '拟人玩具', '拟人面包'], age: '例如：崭新、旧款、复古', wardrobe: '例如：蝴蝶结、贴纸、小帽子', prompt: '例如：陶瓷杯身、杯把手臂、活泼表情', body: '例如：保留杯身、短腿、杯把作为手臂' },
};
export function RoleDesignEditor({ analysis, brief, busy, onChange, onDesign }: {
  analysis: VideoDnaAnalysis; brief: RemixBrief; busy: boolean;
  onChange: (value: RemixBrief) => void; onDesign: (roleId?: string) => void;
}) {
  const [notice, setNotice] = useState('');
  const update = (id: string, key: keyof RoleDesignSettings, value: string) => onChange({ ...brief, roleDesigns: { ...brief.roleDesigns, [id]: { ...brief.roleDesigns?.[id], [key]: value || undefined } } });
  return <section className="space-y-4" aria-label="角色创作设定">
    <div><h3 className="text-base font-semibold text-white/90">设定你想要的角色</h3><p className="mt-2 text-sm leading-6 text-white/60">可以改性别、换物种，也可以沿用原片。修改设定不影响已有图，重新设计后才产生新方案。</p></div>
    <label className="flex flex-wrap items-center gap-3 text-sm text-white/70">每个角色设计<select className="min-h-11 rounded-xl border border-white/15 bg-[#07120f] px-3" disabled={busy} value={brief.candidateCount ?? 4} onChange={e => onChange({ ...brief, candidateCount: Number(e.target.value) })}>{[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} 套候选</option>)}</select><span className="text-xs text-white/50">本步只生成文字方案，不自动生图</span></label>
    <div className="grid items-start gap-4 xl:grid-cols-2 2xl:grid-cols-3">
      {analysis.source_roles.map((role, index) => {
        const settings = brief.roleDesigns?.[role.role_id] ?? {};
        const entity = resolveSourceRoleEntity(role);
        const hints = typeHints[settings.entity_type || entity.entity_type];
        const listId = `role-species-options-${index}`;
        const casting = resolveSourceRoleCastingEnvelope(role, analysis.style_dna.visual.medium);
        const custom = Object.values(settings).some(Boolean);
        let prompt = '';
        let invalid = '';
        try { prompt = buildCharacterDesignInstruction(analysis, brief, role.role_id); } catch (error) { invalid = error instanceof Error ? error.message : String(error); }
        return <details key={role.role_id} className="min-w-0 rounded-xl border border-white/10 px-4 py-1">
          <summary className="min-h-12 cursor-pointer py-3 text-sm text-white/85">角色 {index + 1} · {role.narrative_function} <span className="ml-2 text-xs text-emerald-200">{custom ? '已自定义' : '沿用原片'}</span></summary>
          <fieldset disabled={busy} className="space-y-4 pb-5">
            <button type="button" disabled={busy || !!invalid} onClick={() => onDesign(role.role_id)} className="min-h-11 rounded-xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-[#082018] disabled:opacity-40">按当前设定生成此角色候选 · {brief.candidateCount ?? 4} 套</button>
            <p className="text-xs leading-6 text-white/55">原片：{entity.species} · {casting.gender_expression}。留空的选项沿用原设定。</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">角色类型<select className={input} value={settings.entity_type ?? ''} onChange={e => update(role.role_id, 'entity_type', e.target.value)}><option value="">沿用原片</option><option value="human">人类</option><option value="animal">自然动物</option><option value="anthropomorphic_animal">拟人动物</option><option value="robot">机器人</option><option value="creature">幻想生物</option><option value="anthropomorphic_object">拟人物体</option></select></label>
              <label className="text-sm">{hints.label}<input list={listId} className={input} placeholder={`例如：${hints.options.slice(0, 3).join('、')}`} value={settings.species ?? ''} onChange={e => update(role.role_id, 'species', e.target.value)} /><datalist id={listId}>{hints.options.map(value => <option key={value} value={value} />)}</datalist></label>
              <label className="text-sm">性别表达<select className={input} value={settings.gender_expression ?? ''} onChange={e => update(role.role_id, 'gender_expression', e.target.value)}><option value="">沿用原片</option><option value="男性">男性</option><option value="女性">女性</option><option value="中性">中性</option><option value="不限定性别表达">不限定</option></select></label>
              {([['apparent_age_band', '年龄 / 生命阶段', hints.age], ['build_silhouette', '体型', '例如：高瘦、健壮、圆润'], ['wardrobe_function', '服装与配饰', hints.wardrobe], ['visual_medium', '画风', '例如：写实摄影、水彩、动画 3D']] as const).map(([key, label, placeholder]) => <label key={key} className="text-sm">{label}<input className={input} placeholder={placeholder} value={settings[key] ?? ''} onChange={e => update(role.role_id, key, e.target.value)} /></label>)}
            </div>
            <label className="block text-sm">自由创作要求<textarea className={`${input} min-h-24 leading-6`} placeholder={`${hints.prompt}。类型和名称请在上方填写。`} value={settings.prompt ?? ''} onChange={e => update(role.role_id, 'prompt', e.target.value)} /></label>
            <details><summary className="min-h-11 cursor-pointer py-3 text-sm text-white/65">身体结构与动作适配</summary><label className="block text-sm">目标身体结构<input className={input} placeholder={hints.body} value={settings.body_plan ?? ''} onChange={e => update(role.role_id, 'body_plan', e.target.value)} /></label><p className="mt-2 text-xs leading-6 text-amber-100/80">更换身体结构后，请检查拿物、走路等动作是否适合新角色。当前 3D 预演展示原片动作，不会自动重排；故事和分镜可返回上一步调整。</p></details>
            {invalid && <p role="status" className="text-sm text-amber-100">{invalid}</p>}
            <button type="button" onClick={() => onChange({ ...brief, roleDesigns: { ...brief.roleDesigns, [role.role_id]: {} } })} className="min-h-11 px-3 text-sm text-white/65">重置为原片设定</button>
            <details><summary className="min-h-11 cursor-pointer py-3 text-sm text-white/65">查看并复制角色设计任务</summary><p className="text-xs leading-6 text-white/55">上方设定与自由要求会实时组成任务；复制后可自行修改。生成候选后，每张图还有独立可编辑的生图提示词。</p><textarea readOnly aria-label={`角色 ${index + 1} 设计任务`} className={`${input} min-h-40 font-mono text-xs`} value={prompt} /><button type="button" disabled={!!invalid} className="min-h-11 text-sm text-emerald-200" onClick={async () => { try { await navigator.clipboard.writeText(prompt); setNotice('角色设计任务已复制。'); } catch { setNotice('无法自动复制，请在文本框中手动选中复制。'); } }}>复制设计任务</button></details>
          </fieldset>
        </details>;
      })}
    </div>
    {notice && <p role="status" className="text-sm text-emerald-100">{notice}</p>}
  </section>;
}
