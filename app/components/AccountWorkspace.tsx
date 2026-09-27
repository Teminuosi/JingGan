'use client';
import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';
import { ArrowRight, Archive, ChevronDown, LogOut, Settings, UserRound, Video } from 'lucide-react';
import type { AccountConfig, AccountUser, } from '../lib/auth-protocol';
import { registrationSource } from '../lib/auth-protocol';
import { accountFetch, currentAccountId, logoutAccount, refreshAccount, setAccountScope } from '../lib/account-client';
import type { SavedVideoProjectSummary } from '../lib/types';
import { StudioApp } from './StudioApp';
import { AuthDialog } from './AuthDialog';
import { Modal, overlayButton } from './Overlay';

interface WorkspaceAccount { user: AccountUser; config: AccountConfig; logout: () => Promise<void>; claim: () => void }
const AccountContext = createContext<WorkspaceAccount | null>(null);
const fallback: AccountConfig = { configured: false, blogUrl: 'https://3yuedaohang.com', referralUrl: '', localClaims: false };
export function AccountMenu({ busy, onHistory, onSettings }: { busy: boolean; onHistory: () => void; onSettings: () => void }) {
  const account = useContext(AccountContext);
  if (!account) return null;
  const close = (event: React.MouseEvent) => { event.currentTarget.closest('details')?.removeAttribute('open'); };
  return <details className="relative text-sm"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-white/75"><UserRound size={16} /><span className="max-w-28 truncate">{account.user.name || '我的账号'}</span><ChevronDown size={13} /></summary><div className="absolute right-0 z-40 mt-2 w-64 rounded-2xl border border-white/15 bg-[#0c1a16] p-2 shadow-2xl"><p className="truncate border-b border-white/10 px-3 py-3 text-xs text-white/50">{account.user.email}</p>{[{ label: '项目记录', icon: Archive, action: onHistory }, { label: 'AI 服务设置', icon: Settings, action: onSettings }, ...(account.config.localClaims ? [{ label: '认领本机旧项目', icon: Archive, action: account.claim }] : [])].map(item => <button key={item.label} type="button" disabled={busy} onClick={event => { close(event); item.action(); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-white/75 hover:bg-white/5 disabled:opacity-40"><item.icon size={16} />{item.label}</button>)}<a href={account.config.blogUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl px-3 py-3 text-white/75 hover:bg-white/5"><UserRound size={16} />账号信息</a><button type="button" disabled={busy} onClick={event => { close(event); void account.logout(); }} className="flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-white/60 hover:bg-white/5 disabled:opacity-40"><LogOut size={16} />退出登录</button></div></details>;
}
export function useAccountConfig() { return useContext(AccountContext)?.config || fallback; }

export function AccountWorkspace() {
  const epoch = useRef(0);
  const signingOut = useRef(false);
  const [config, setConfig] = useState(fallback);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'login' | 'register' | null>(null);
  const [source, setSource] = useState('jinggan');
  const [error, setError] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [oldProjects, setOldProjects] = useState<SavedVideoProjectSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [claimBusy, setClaimBusy] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const login = useCallback((next: AccountUser) => { epoch.current++; if (currentAccountId() !== next.id) setAccountScope(next.id); setUser(next); setAuthenticated(true); setMode(null); setError(''); }, []);
  const check = useCallback(async () => {
    if (signingOut.current) return;
    const started = epoch.current;
    try {
      const response = await refreshAccount();
      if (started !== epoch.current) return;
      if (response.ok) { const result = await response.json() as { user?: AccountUser }; if (result.user) { if (currentAccountId() !== result.user.id) setAccountScope(result.user.id); setUser(result.user); setAuthenticated(true); } }
      else if (response.status === 401 || response.status === 403) { setAuthenticated(false); }
      else { const result = await response.json() as { error?: string }; setError(result.error || '账号服务暂不可用。'); }
    } catch { setError('连接账号服务失败，请检查网络。'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    let signupSource = 'jinggan';
    try {
      const raw = query.get('channel') || query.get('ref') || query.get('utm_source');
      if (raw) localStorage.setItem('mirror:signup-source', JSON.stringify({ source: registrationSource(raw), expires: Date.now() + 30 * 864e5 }));
      const saved = JSON.parse(localStorage.getItem('mirror:signup-source') || 'null');
      if (saved && saved.expires > Date.now()) signupSource = registrationSource(saved.source);
    } catch { /* Attribution must not block login. */ }
    void fetch('/api/auth/config', { cache: 'no-store' }).then(response => response.json() as Promise<AccountConfig>).then(value => { setConfig(value); setSource(signupSource); void check(); }).catch(() => { setError('无法读取账号配置。'); setChecking(false); });
    const requireLogin = () => { setAuthenticated(false); setMode('login'); };
    const focus = () => { void check(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, 60000);
    window.addEventListener('mirror:login-required', requireLogin); window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('mirror:login-required', requireLogin); window.removeEventListener('focus', focus); };
  }, [check]);
  const logout = async () => {
    signingOut.current = true; epoch.current++;
    try {
      const response = await logoutAccount();
      if (!response.ok) throw new Error();
      setAccountScope(null); setUser(null); setAuthenticated(false); setMode(null); setClaimOpen(false); setOldProjects([]); setSelected([]);
    } catch { setError('退出未完成，请重试。'); }
    finally { signingOut.current = false; }
  };
  const loadClaims = async () => {
    setClaimOpen(true); setClaimBusy(true); setError(''); setSelected([]);
    try { const response = await accountFetch('/api/account/legacy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) }); const result = await response.json() as { error?: string; projects: SavedVideoProjectSummary[] }; if (!response.ok) throw new Error(result.error); setOldProjects(result.projects); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '读取旧项目失败。'); }
    finally { setClaimBusy(false); }
  };
  const claim = async () => {
    setClaimBusy(true); setError('');
    try { const response = await accountFetch('/api/account/legacy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim', ids: selected }) }); const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error); setClaimOpen(false); setWorkspaceRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '认领失败，请刷新列表确认已认领项目。'); }
    finally { setClaimBusy(false); }
  };
  return <>
    {user ? <AccountContext.Provider value={{ user, config, logout, claim: () => void loadClaims() }}><div inert={!authenticated || undefined}><StudioApp key={`${user.id}:${workspaceRevision}`} /></div>{!authenticated && <div className="fixed inset-0 z-40 bg-[#040b09]/95" />}</AccountContext.Provider> : <main className="min-h-screen bg-[#07120f] text-white"><header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-10"><span className="flex items-center gap-3 font-semibold"><Video size={22} className="text-emerald-300" />镜感<span className="hidden text-xs font-normal text-white/40 sm:inline">视频创作工作台</span></span><div className="flex gap-2"><button type="button" className={overlayButton.secondary} onClick={() => setMode('login')}>登录</button><button type="button" className={overlayButton.primary} onClick={() => setMode('register')}>免费注册</button></div></header><section className="mx-auto grid max-w-[1600px] gap-12 px-6 py-16 lg:grid-cols-[1.15fr_1fr] lg:px-12 lg:py-28"><div><p className="mb-5 text-sm text-emerald-200">保留镜头的感觉，创作你的故事</p><h1 className="max-w-3xl text-balance text-4xl font-semibold leading-tight sm:text-6xl">从一段参考视频，<span className="block text-emerald-200">开始你的下一部作品。</span></h1><p className="mt-7 max-w-xl text-base leading-8 text-white/60">拆解剧情和镜头，改写故事与对白，设计你自己的角色。用 3D 预演检查走位，再复制每个分镜的提示词去测试。</p><button type="button" className={`${overlayButton.primary} mt-8 px-6 py-3.5`} onClick={() => setMode('login')}>{checking ? '正在检查登录…' : '登录并开始创作'}<ArrowRight size={17} /></button><p className="mt-4 text-sm leading-6 text-white/40">已有三月导航账号可直接登录。工具免费，模型调用使用你自己的 API Key。</p>{error && <p role="alert" className="mt-5 text-sm leading-6 text-amber-100">{error}</p>}</div><div className="rounded-3xl border border-emerald-200/15 bg-emerald-200/[0.025] p-6 sm:p-9"><p className="mb-6 text-sm font-semibold text-white/80">你的创作流程</p>{[['拆解原片', '看懂剧情节奏、角色动作与镜头安排'], ['改编故事', '保留原剧情或写新故事，选择对白语言'], ['设计角色', '自由调整性别、物种和形象，编辑提示词'], ['生成预演', '查看每个分镜的 3D 参考与对应提示词'], ['分镜创作', '下载角色图，复制提示词，逐段验证效果']].map(([title, description], index) => <div key={title} className="flex gap-4 border-t border-white/8 py-5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-200/10 text-sm text-emerald-200">{index + 1}</span><div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-white/45">{description}</p></div></div>)}</div></section></main>}
    {(mode || (user && !authenticated)) && <AuthDialog mode={mode || 'login'} config={config} source={source} locked={Boolean(user && !authenticated)} onMode={setMode} onClose={() => setMode(null)} onLogin={login} />}
    {claimOpen && authenticated && <Modal open size="md" title="认领本机旧项目" onClose={() => { if (!claimBusy) setClaimOpen(false); }} description="这是这台电脑在未启用账号时保存的项目。选择后归属当前账号；项目、角色图片和预演文件保持原样。共享电脑请先确认这些是你的作品。"><div className="space-y-3">{claimBusy ? <p className="text-sm text-white/60">正在处理…</p> : oldProjects.length ? oldProjects.map(project => <label key={project.id} className="flex gap-3 rounded-xl border border-white/10 p-3"><input type="checkbox" checked={selected.includes(project.id)} onChange={event => setSelected(old => event.target.checked ? [...old, project.id] : old.filter(id => id !== project.id))} /><span className="min-w-0 text-sm"><span className="block">{project.title}</span><span className="mt-1 block truncate text-xs text-white/40">{project.sourceName}</span></span></label>) : <p className="text-sm text-white/60">没有待认领的本机旧项目。</p>}{error && <p role="alert" className="text-sm text-rose-200">{error}</p>}<button type="button" disabled={claimBusy || !selected.length} className={`${overlayButton.primary} disabled:opacity-40`} onClick={() => void claim()}>将所选 {selected.length} 个项目归入我的账号</button></div></Modal>}
  </>;
}
