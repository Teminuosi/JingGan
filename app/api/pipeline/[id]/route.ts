import { apiError, noStoreJson, requireOwner } from '../../../lib/server/auth';
import { loadPipeline } from '../../../lib/server/pipeline-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const ownerId = await requireOwner(request);
    const { id } = await ctx.params;
    const view = await loadPipeline(id, ownerId);
    if (!view) return noStoreJson({ error: '项目不存在。' }, { status: 404 });
    return noStoreJson({ pipeline: view });
  } catch (error) {
    return apiError(error);
  }
}
