import { assertRelayAccess } from '../../../lib/server/relay';
import { apiError, requireOwner } from '../../../lib/server/auth';
import { notSubmittedResponse } from '../../../lib/auth-protocol';
import { checkContentLength, checkDownloadUrl, isVideoContentType, MAX_REDIRECTS, MAX_SEGMENT_BYTES } from '../../../lib/post/download-guard';

export const dynamic = 'force-dynamic';

/**
 * 把中转返回的成片地址转发给浏览器存到本机（中转的签名链接多半不允许网页跨域读取）。
 * 只给登录用户用；只拉 https 公网地址；只放行 video/*；边收边传，不在服务器上攒整个文件、不落盘。
 * 这一步不调用模型、不计费。
 */
export async function POST(request: Request) {
  try {
    assertRelayAccess(request);
    await requireOwner(request);
  } catch (error) {
    if (error instanceof Error && ['unauthorized', 'auth_not_configured', 'auth_unavailable', 'auth_profile_missing', 'account_banned', 'account_changed'].includes(error.message)) return notSubmittedResponse(apiError(error));
    return Response.json({ error: '请求来源不允许。' }, { status: 400 });
  }
  let target: URL;
  try {
    const { url } = await request.json() as { url?: unknown };
    target = checkDownloadUrl(url);
  } catch (error) {
    return Response.json({ error: error instanceof Error && /[一-龥]/.test(error.message) ? error.message : '视频地址无效。' }, { status: 400 });
  }
  let upstream: Response | null = null;
  try {
    // 跳转一律手动跟，每一跳都重新过一遍地址检查，防止被引到内网。
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      upstream = await fetch(target.href, { method: 'GET', redirect: 'manual', headers: { Accept: 'video/*' }, signal: AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60 * 1000)]) });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECTS) return Response.json({ error: '视频地址跳转过多或无效。' }, { status: 502 });
      target = checkDownloadUrl(new URL(location, target).href);
    }
  } catch (error) {
    if (error instanceof Error && /[一-龥]/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: '下载视频失败或超时。链接可能已过期，可以在「成片包装」里用本机文件补上这一段。' }, { status: 502 });
  }
  if (!upstream || !upstream.ok) {
    await upstream?.body?.cancel().catch(() => {});
    return Response.json({ error: `视频地址返回 HTTP ${upstream?.status ?? '无响应'}，链接可能已过期。可以在「成片包装」里用本机文件补上这一段。` }, { status: 502 });
  }
  const type = upstream.headers.get('content-type');
  if (!isVideoContentType(type)) {
    await upstream.body?.cancel().catch(() => {});
    return Response.json({ error: '对方返回的不是视频，已拒绝转发。可以手动下载后在「成片包装」里用本机文件补上。' }, { status: 415 });
  }
  const length = upstream.headers.get('content-length');
  const tooBig = checkContentLength(length);
  if (tooBig) {
    await upstream.body?.cancel().catch(() => {});
    return Response.json({ error: tooBig }, { status: 413 });
  }
  // 没给长度的也要边传边数，超限就断。
  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_SEGMENT_BYTES) controller.error(new Error('too_large'));
      else controller.enqueue(chunk);
    },
  });
  const headers = new Headers({
    'Content-Type': type!.split(';')[0].trim().toLowerCase(),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment',
  });
  if (length) headers.set('Content-Length', length);
  return new Response(upstream.body!.pipeThrough(limiter), { status: 200, headers });
}
