import { apiError, noStoreJson, requireOwner } from '../../lib/server/auth';
import { listPipelineProjects } from '../../lib/server/pipeline-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const ownerId = await requireOwner(request);
    return noStoreJson({ projects: await listPipelineProjects(ownerId) });
  } catch (error) {
    return apiError(error);
  }
}
