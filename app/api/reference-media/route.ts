// 上传本段 3D 预演，换一个上游能抓取的签名临时链接。规则与防滥用说明见 lib/server/reference-media.ts。
import { isLoopback } from '../../lib/auth-protocol';
import { apiError, noStoreJson, requireOwner } from '../../lib/server/auth';
import { requireImages } from '../../lib/server/bindings';
import { handleReferenceUpload, referenceMediaSecret } from '../../lib/server/reference-media';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    return await handleReferenceUpload(request, {
      requireOwner,
      bucket: requireImages,
      secret: () => referenceMediaSecret(process.env, process.env.NODE_ENV !== 'production' && isLoopback(request.url)),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'media_signing_not_configured') {
      return noStoreJson({ error: '参考视频签名密钥未配置（MIRROR_MEDIA_SIGNING_SECRET），暂时无法附带 3D 预演。' }, { status: 503 });
    }
    return apiError(error);
  }
}
