import { createClient, type Session, type User } from '@supabase/supabase-js';
import { isLoopback, type AccountUser } from '../auth-protocol';

const ACCESS = 'mirror_access';
const REFRESH = 'mirror_refresh';
export function authEnabled() { return process.env.MIRROR_AUTH_ENABLED !== 'false'; }
export function authConfig() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
  let publicKey = key.startsWith('sb_publishable_');
  try { publicKey ||= JSON.parse(atob(key.split('.')[1])).role === 'anon'; } catch { /* Invalid configuration. */ }
  let validUrl = false;
  try { validUrl = new URL(url).protocol === 'https:' && !new URL(url).username && !new URL(url).password; } catch { /* Missing configuration. */ }
  return { url, key, configured: validUrl && publicKey };
}
export function authClient() {
  const config = authConfig();
  if (!config.configured) throw new Error('auth_not_configured');
  return createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
function cookies(request: Request) {
  return Object.fromEntries((request.headers.get('cookie') || '').split(';').flatMap(part => {
    const i = part.indexOf('=');
    if (i < 0) return [];
    try { return [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))]]; } catch { return []; }
  }));
}
export function sessionTokens(request: Request) { const values = cookies(request); return { access: values[ACCESS] || '', refresh: values[REFRESH] || '' }; }
export function accountUser(user: User): AccountUser {
  return { id: user.id, email: user.email || '', name: typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : (user.email || '').split('@')[0] };
}
export async function checkAccount(user: User, access: string): Promise<AccountUser> {
  const config = authConfig();
  let response: Response;
  try {
    response = await fetch(`${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_banned`, {
      headers: { apikey: config.key, Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10000), cache: 'no-store',
    });
  } catch { throw new Error('auth_unavailable'); }
  if (!response.ok) throw new Error('auth_unavailable');
  const profiles = await response.json() as { is_banned?: boolean }[];
  if (!Array.isArray(profiles) || profiles.length !== 1) throw new Error('auth_profile_missing');
  if (profiles[0].is_banned) throw new Error('account_banned');
  return accountUser(user);
}
export async function verifiedUser(request: Request): Promise<AccountUser> {
  const { access } = sessionTokens(request);
  if (!access) throw new Error('unauthorized');
  const { data, error } = await authClient().auth.getUser(access);
  if (error) throw new Error(error.status && error.status >= 400 && error.status < 500 ? 'unauthorized' : 'auth_unavailable');
  if (!data.user) throw new Error('unauthorized');
  return checkAccount(data.user, access);
}
export function sessionResponse(request: Request, value: unknown, session: Session | null, status = 200): Response {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  for (const [name, token] of [[ACCESS, session?.access_token], [REFRESH, session?.refresh_token]]) {
    headers.append('Set-Cookie', `${name}=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 2592000 : 0}${secure}`);
  }
  return Response.json(value, { status, headers });
}
export function assertLocalClaim(request: Request) {
  const origin = request.headers.get('origin');
  if (process.env.NODE_ENV === 'production' || process.env.MIRROR_LOCAL_CLAIMS !== 'true' || !isLoopback(request.url) || origin !== new URL(request.url).origin) throw new Error('forbidden_origin');
}
