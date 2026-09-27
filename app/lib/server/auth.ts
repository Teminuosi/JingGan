import { authEnabled, verifiedUser } from './auth-session';
import { isLoopback } from '../auth-protocol';

export async function requireOwner(request: Request): Promise<string> {
  if (!authEnabled() && process.env.NODE_ENV !== 'production' && isLoopback(request.url)) return 'local_seedy';
  const owner = (await verifiedUser(request)).id;
  const expected = request.headers.get('x-mirror-account-id');
  if (expected && expected !== owner) throw new Error('account_changed');
  return owner;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new Error('forbidden_origin');
}

export function apiError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'unauthorized') return noStoreJson({ error: '请先登录后继续使用镜感。' }, { status: 401 });
  if (message === 'auth_not_configured') return noStoreJson({ error: '账号服务尚未配置，请查看登录接入说明。' }, { status: 503 });
  if (message === 'auth_unavailable') return noStoreJson({ error: '账号服务暂时无法连接，请稍后重试；已有内容已保留。' }, { status: 503 });
  if (message === 'auth_profile_missing') return noStoreJson({ error: '账号资料尚未建立，请联系站长检查 profiles 建档配置。' }, { status: 503 });
  if (message === 'account_banned') return noStoreJson({ error: '该账号已停用，请联系站长。' }, { status: 403 });
  if (message === 'account_changed') return noStoreJson({ error: '账号已切换，当前操作未提交。请重新登录后继续。' }, { status: 409 });
  if (message === 'forbidden_origin') return Response.json({ error: '请求来源无效。' }, { status: 403 });
  if (message === 'not_found') return Response.json({ error: '项目不存在或无权访问。' }, { status: 404 });
  if (message === 'invalid_asset') return Response.json({ error: '参考图与当前角色方案不匹配。' }, { status: 400 });
  if (message === 'corrupt_project') return Response.json({ error: '项目记录损坏，无法安全恢复。' }, { status: 500 });
  if (message === 'write_conflict') return Response.json({ error: '项目刚被另一操作更新，请重试。' }, { status: 409 });
  if (message === 'storage_unavailable') return Response.json({ error: '项目存储暂不可用。' }, { status: 503 });
  // 人工修正被闸门拦下时，必须把具体原因带回去。吞成「保存失败，请稍后重试」等于让用户对着一个
  // 永远重试不好的错误干瞪眼——他改的东西本来就不许改，重试一百次也一样。
  if (message.startsWith('edit_rejected: ')) return Response.json({ error: message.slice('edit_rejected: '.length) }, { status: 400 });
  return Response.json({ error: '项目保存失败，请稍后重试。' }, { status: 500 });
}

export function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return Response.json(value, { ...init, headers });
}
