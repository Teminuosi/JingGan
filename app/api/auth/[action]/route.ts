import { apiError, assertSameOrigin, noStoreJson } from '../../../lib/server/auth';
import { accountUser, authClient, authConfig, checkAccount, sessionResponse, sessionTokens, verifiedUser } from '../../../lib/server/auth-session';
import { isLoopback, registrationSource } from '../../../lib/auth-protocol';
import { recordAccountVisit } from '../../../lib/server/account-store';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ action: string }> };
const blogUrl = () => process.env.MIRROR_BLOG_URL || 'https://3yuedaohang.com';
async function record(userId: string, source: unknown) { await recordAccountVisit(userId, registrationSource(source)); }

export async function GET(request: Request, context: Context) {
  try {
    const { action } = await context.params;
    if (action === 'config') return noStoreJson({ configured: authConfig().configured, blogUrl: blogUrl(), referralUrl: process.env.MIRROR_RELAY_REFERRAL_URL || '', localClaims: process.env.NODE_ENV !== 'production' && process.env.MIRROR_LOCAL_CLAIMS === 'true' && isLoopback(request.url) });
    if (action !== 'session') return noStoreJson({ error: '接口不存在。' }, { status: 404 });
    return noStoreJson({ user: await verifiedUser(request) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    if (request.headers.get('origin') !== new URL(request.url).origin) throw new Error('forbidden_origin');
    const { action } = await context.params;
    if (action === 'logout') return sessionResponse(request, { user: null }, null);
    if (action === 'session') {
      try { return noStoreJson({ user: await verifiedUser(request) }); }
      catch (cause) { if (!(cause instanceof Error) || cause.message !== 'unauthorized') throw cause; }
      const refresh = sessionTokens(request).refresh;
      if (!refresh) return sessionResponse(request, { error: '登录已过期，请重新登录。' }, null, 401);
      const { data, error } = await authClient().auth.refreshSession({ refresh_token: refresh });
      if (error || !data.session) {
        if (error && (!error.status || error.status >= 500)) throw new Error('auth_unavailable');
        return sessionResponse(request, { error: '登录已过期，请重新登录。' }, null, 401);
      }
      const user = await checkAccount(data.session.user, data.session.access_token);
      return sessionResponse(request, { user }, data.session);
    }
    if (!['login', 'register'].includes(action)) return noStoreJson({ error: '接口不存在。' }, { status: 404 });
    if (Number(request.headers.get('content-length')) > 8192) return noStoreJson({ error: '提交内容过长。' }, { status: 400 });
    const raw = await request.text();
    if (raw.length > 8192) return noStoreJson({ error: '提交内容过长。' }, { status: 400 });
    let input: { email?: unknown; password?: unknown; source?: unknown };
    try { input = JSON.parse(raw); } catch { return noStoreJson({ error: '提交内容格式无效。' }, { status: 400 }); }
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 6 || password.length > 128) return noStoreJson({ error: '请输入有效邮箱和 6–128 位密码。' }, { status: 400 });
    const client = authClient();
    const result = action === 'login' ? await client.auth.signInWithPassword({ email, password }) : await client.auth.signUp({ email, password, options: { emailRedirectTo: blogUrl(), data: { register_source: registrationSource(input.source) } } });
    if (result.error) {
      if (!result.error.status || result.error.status >= 500) throw new Error('auth_unavailable');
      const code = result.error.code;
      const message = result.error.status === 429 ? '操作太频繁，请稍后重试。' : code === 'email_not_confirmed' ? '请先到邮箱完成验证，再回来登录。' : code === 'weak_password' ? '密码强度不足，请更换更长的密码。' : action === 'login' ? '邮箱或密码不正确。' : '注册未完成，请检查邮箱、密码，或尝试登录已有账号。';
      return noStoreJson({ error: message }, { status: result.error.status === 429 ? 429 : 400 });
    }
    if (!result.data.session) return noStoreJson({ user: null, verifyEmail: true, message: '请查收验证邮件；完成邮箱验证后，再回来登录。' });
    const session = result.data.session;
    const user = await checkAccount(session.user, session.access_token);
    await record(user.id, input.source);
    return sessionResponse(request, { user: accountUser(session.user) }, session);
  } catch (error) { return apiError(error); }
}
