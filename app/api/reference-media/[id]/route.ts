// 上游抓参考视频用的公开读取口：不认登录，只认签名与有效期。见 lib/server/reference-media.ts。
import { isLoopback } from '../../../lib/auth-protocol';
import { requireImages } from '../../../lib/server/bindings';
import { handleReferenceDownload, referenceMediaSecret } from '../../../lib/server/reference-media';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return await handleReferenceDownload(request, id, {
      bucket: requireImages,
      secret: () => referenceMediaSecret(process.env, process.env.NODE_ENV !== 'production' && isLoopback(request.url)),
    });
  } catch {
    return Response.json({ error: '参考视频暂时无法读取。' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
