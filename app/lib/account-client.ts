'use client';
let accountId: string | null = null;
const legacyProjects = new Set<string>();
let refresh: Promise<Response> | null = null;
let closing = false;
async function sessionMutation(work: () => Promise<Response>): Promise<Response> {
  return await (typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('mirror:auth-session', work)
    : work());
}
export function submitAccount(mode: 'login' | 'register', init: RequestInit) {
  return sessionMutation(() => fetch(`/api/auth/${mode}`, init));
}
export async function logoutAccount(): Promise<Response> {
  closing = true;
  try {
    await refresh?.catch(() => undefined);
    return await sessionMutation(() => fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' }));
  } finally { closing = false; }
}
export function setAccountScope(id: string | null) { accountId = id; legacyProjects.clear(); }
export function currentAccountId() { return accountId; }
export function accountStorageKey(key: string, owner = accountId) { return `mirror:account:${owner || 'guest'}:${key}`; }
export function allowLegacyProjectCache(id: string) { if (accountId) legacyProjects.add(id); }
export function canReadLegacyCache(key: string) { return accountId !== null && [...legacyProjects].some(id => key.includes(id)); }
export async function refreshAccount(): Promise<Response> {
  if (closing) return Response.json({ error: '正在退出登录。' }, { status: 401 });
  refresh ??= sessionMutation(() => fetch('/api/auth/session', { method: 'POST', cache: 'no-store' })).finally(() => { refresh = null; });
  return (await refresh).clone();
}
export async function ensureAccount(expected = accountId): Promise<Response> {
  const session = await refreshAccount();
  if (!session.ok) {
    if (session.status === 401 || session.status === 403) window.dispatchEvent(new Event('mirror:login-required'));
    return session;
  }
  const result = await session.clone().json() as { user?: { id?: string } };
  if (!expected || result.user?.id !== expected || accountId !== expected) {
    window.dispatchEvent(new Event('mirror:login-required'));
    return Response.json({ error: '账号已在其他页面切换。当前操作未提交，请重新登录后继续。' }, { status: 409 });
  }
  return session;
}
export async function accountFetch(input: string, init?: RequestInit): Promise<Response> {
  // Authenticate before a paid request. A failed request is never automatically submitted twice.
  const headers = new Headers(init?.headers);
  const expected = headers.get('x-mirror-account-id') || accountId;
  const session = await ensureAccount(expected);
  if (!session.ok) return session;
  headers.set('x-mirror-account-id', expected!);
  let response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    const session = await ensureAccount(expected);
    if (session.ok && (!init?.method || ['GET', 'HEAD'].includes(init.method.toUpperCase()))) response = await fetch(input, { ...init, headers });
  }
  return response;
}
