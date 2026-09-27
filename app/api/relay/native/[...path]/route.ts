import { assertRelayAccess, forwardRelay } from '../../../../lib/server/relay';
import { apiError, requireOwner } from '../../../../lib/server/auth';
export const dynamic = 'force-dynamic';
async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    assertRelayAccess(request);
    await requireOwner(request);
    const { path } = await params;
    const target = '/' + path.join('/');
    // 白名单：只放行确实要用的几个原生接口，别把任意路径转给上游。
    // streamGenerateContent 是分析必须的——非流式时整个分析期间连接不走字节，
    // 中转前面的 Cloudflare 等满 100 秒就返回 524，长片必中。
    if (!/^\/(?:upload\/v1beta\/files|v1beta\/files(?:\/[a-zA-Z0-9_-]+)?|v1beta\/models\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent))$/.test(target)) return Response.json({ error: '此原生接口未开放。' }, { status: 400 });
    const headers = new Headers();
    for (const [name, value] of request.headers) if (name === 'content-type' || name.startsWith('x-goog-upload-')) headers.set(name, value);
    const query = new URL(request.url).searchParams;
    query.delete('key');
    return await forwardRelay(request, target + (query.size ? `?${query}` : ''), ['GET', 'DELETE'].includes(request.method) ? null : request.body, request.method, headers);
  } catch (error) {
    if (error instanceof Error && ['unauthorized', 'auth_not_configured', 'auth_unavailable', 'auth_profile_missing', 'account_banned', 'account_changed'].includes(error.message)) return apiError(error);
    return Response.json({ error: 'Gemini 原生请求无效。' }, { status: 400 });
  }
}
export const POST = proxy;
export const GET = proxy;
export const DELETE = proxy;
