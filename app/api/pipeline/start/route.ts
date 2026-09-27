import { apiError, assertSameOrigin, noStoreJson, requireOwner } from '../../../lib/server/auth';
import { startPipeline } from '../../../lib/server/pipeline-start';
import { getProject } from '../../../lib/server/project-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const body = await request.json() as { projectId?: string; videoModel?: string; hosted?: boolean; previsMode?: 'full' | 'per_shot' | 'off' };
    if (!body?.projectId) return noStoreJson({ error: '缺少项目 id。' }, { status: 400 });

    const project = await getProject(ownerId, body.projectId);
    if (!project) return noStoreJson({ error: '项目不存在或无权访问。' }, { status: 404 });
    if (!project.analysis?.beats?.length) {
      return noStoreJson({ error: '这个项目还没有分析结果，不能开始复刻。' }, { status: 400 });
    }

    const result = await startPipeline({
      ownerId,
      legacyProjectId: body.projectId,
      project,
      videoModel: body.videoModel || 'mock/video',
      previsMode: body.previsMode ?? 'off',
      // hosted 模式才走钱包扣费；默认 byok，平台不碰钱。
      userId: body.hosted ? ownerId : undefined,
    });
    return noStoreJson({ result }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
