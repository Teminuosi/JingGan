'use client';

import { useState } from 'react';
import { forgetStoredKeys, hasLegacyConnections, importLegacyConnections, listRelayModels, loadConnection, roles, saveConnection, type RelayConnection, type RelayRole } from '../lib/relay-client';
import { relayOrigin } from '../lib/relay-protocol';
import { Modal, overlayButton } from './Overlay';
import { useAccountConfig } from './AccountWorkspace';

interface Props {
  open: boolean;
  onClose: () => void; onSave: () => void;
}
const field = 'mt-2 w-full rounded-xl border border-white/15 bg-[#07120f] px-3 py-2.5 text-sm text-white';
const labels: Record<RelayRole, string> = { analysis: '① 视频分析 · Gemini', text: '② 故事和角色方案 · 文本模型', image: '③ 角色参考图 · 图片模型', video: '④ 视频生成 · 视频模型' };
// 视频模型只在视频分组里可用，分组由 Key 自身决定；请求体里不写分组。
const roleHint: Partial<Record<RelayRole, string>> = { video: '这一类的令牌要在控制台选“视频分组”，否则拉不到视频模型，提交时会报 model_not_found。各档的时长上限、参考图上限和单价差别很大，选完在“Seedance 包”页会显示对应能力与积分估算。' };
function RelaySettings({ onClose, onSave }: Props) {
  const config = useAccountConfig();
  const [legacyAvailable, setLegacyAvailable] = useState(hasLegacyConnections);
  const [connections, setConnections] = useState(() => Object.fromEntries(roles.map(role => [role, loadConnection(role)])) as Record<RelayRole, RelayConnection>);
  const [loading, setLoading] = useState<RelayRole | null>(null);
  const [messages, setMessages] = useState<Partial<Record<RelayRole, string>>>({});
  const [error, setError] = useState('');
  const update = (role: RelayRole, patch: Partial<RelayConnection>) => setConnections(old => ({ ...old, [role]: { ...old[role], ...patch } }));
  const fetchModels = async (role: RelayRole) => {
    setLoading(role); setMessages(old => ({ ...old, [role]: '正在读取此 Key 的模型列表…' }));
    try {
      const models = await listRelayModels(connections[role]);
      update(role, { models, model: models.includes(connections[role].model) ? connections[role].model : '' });
      setMessages(old => ({ ...old, [role]: `返回 ${models.length} 个模型，请选择。列表可见不代表所有输入能力已验证。` }));
    } catch (cause) { setMessages(old => ({ ...old, [role]: cause instanceof Error ? cause.message : String(cause) })); }
    finally { setLoading(null); }
  };
  const save = () => {
    try { for (const role of roles) relayOrigin(connections[role].baseUrl); for (const role of roles) saveConnection(role, connections[role]); onSave(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Modal
    open
    size="lg"
    onClose={onClose}
    title="AI 服务设置"
    footer={<div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={loading !== null} onClick={save} className={overlayButton.primary}>保存设置</button>
      <button type="button" disabled={loading !== null} onClick={() => { forgetStoredKeys(); setConnections(old => Object.fromEntries(roles.map(role => [role, { ...old[role], apiKey: '' }])) as Record<RelayRole, RelayConnection>); setMessages({}); setError(''); }} className={overlayButton.secondary}>清除我的 Key</button>
      {error && <p role="alert" className="w-full text-xs text-rose-200">{error}</p>}
    </div>}
    description="填入你自己的 API Key 并选择模型。调用费用从你的中转账户余额扣除；配置仅保存在当前浏览器，按镜感账号分别保存，不会写入项目导出。"
  >
      {legacyAvailable && <div className="mb-5 rounded-xl border border-amber-200/20 bg-amber-200/5 p-4"><p className="text-sm leading-6 text-amber-100">发现这台电脑在启用账号前保存的 AI 配置。只有确认这些 Key 属于你时才导入。</p><button type="button" className={`${overlayButton.secondary} mt-3`} onClick={() => { try { importLegacyConnections(); setConnections(Object.fromEntries(roles.map(role => [role, loadConnection(role)])) as Record<RelayRole, RelayConnection>); setLegacyAvailable(false); } catch { setError('旧配置无法导入，请手动填写。'); } }}>导入这台电脑已有 AI 配置</button></div>}
      <details className="mb-5 rounded-xl border border-white/10 p-4 text-sm"><summary className="cursor-pointer text-emerald-200">没有 API Key？查看获取方式</summary><ol className="mt-3 list-decimal space-y-2 pl-5 text-white/60"><li>到中转平台注册独立账号。</li><li>按需要充值，费用由中转平台收取。</li><li>创建对应模型分组的 API Key。</li><li>回到这里粘贴 Key，读取并选择模型。</li></ol>{config.referralUrl && <a href={config.referralUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block text-emerald-200 underline">前往推荐中转平台</a>}<p className="mt-3 text-xs leading-5 text-white/40">中转账号与镜感账号独立，镜感不代充值、不提供共享 Key。</p></details>
      <div className="space-y-4">{roles.map(role => <fieldset key={role} disabled={loading !== null} className="rounded-2xl border border-white/10 p-4">
        <legend className="px-2 text-sm font-semibold text-emerald-200">{labels[role]}</legend>
        {roleHint[role] && <p className="mt-1 text-xs leading-5 text-white/45">{roleHint[role]}</p>}
        <details className="mt-3 text-sm text-white/50"><summary className="cursor-pointer">高级设置 · 服务地址</summary><label className="mt-2 block">Base URL<input className={field} value={connections[role].baseUrl} onChange={e => update(role, { baseUrl: e.target.value, models: [], model: '' })} /></label></details>
        <label className="mt-3 block text-sm">API Key<input type="password" autoComplete="off" spellCheck={false} className={field} placeholder="sk-…（不要填写官方 Key）" value={connections[role].apiKey} onChange={e => update(role, { apiKey: e.target.value, models: [], model: '' })} /></label>
        <button type="button" disabled={!connections[role].apiKey.trim()} className="mt-3 rounded-xl border border-emerald-200/25 px-4 py-2 text-sm text-emerald-200 disabled:opacity-40" onClick={() => void fetchModels(role)}>{loading === role ? '读取中…' : '通过 Key 拉取模型（不生成内容）'}</button>
        <label className="mt-3 block text-sm">选择模型<select className={field} value={connections[role].models.includes(connections[role].model) ? connections[role].model : ''} onChange={e => update(role, { model: e.target.value })}><option value="">请选择此阶段使用的模型</option>{connections[role].models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        <details className="mt-2 text-sm text-white/50"><summary>手动填写模型 ID（列表接口不可用时）</summary><input aria-label={`${labels[role]}模型 ID`} className={field} value={connections[role].model} onChange={e => update(role, { model: e.target.value })} /></details>
        {role === 'text' && <label className="mt-3 block text-sm">文本协议<select className={field} value={connections.text.protocol} onChange={e => update(role, { protocol: e.target.value as 'responses' | 'chat' })}><option value="responses">Responses（GPT / Codex 分组）</option><option value="chat">Chat Completions（兼容聊天接口）</option></select></label>}
        {messages[role] && <p role="status" className="mt-3 text-sm leading-6 text-amber-100/80">{messages[role]}</p>}
      </fieldset>)}</div>
      <p className="mt-4 text-xs leading-6 text-white/40">Key 保存在本机浏览器中，同源脚本和浏览器扩展可能读取。共用电脑请退出账号；Key 泄露时清除配置并到中转平台重置。生成前会另行确认付费调用。</p>
  </Modal>;
}
export function SettingsDialog(props: Props) { return props.open ? <RelaySettings {...props} /> : null; }
