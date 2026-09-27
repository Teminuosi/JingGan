import type { SavedVideoProject } from '../../lib/types';
import { apiError, assertSameOrigin, noStoreJson, requireOwner } from '../../lib/server/auth';
import { createProject, listProjects } from '../../lib/server/project-store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const ownerId = await requireOwner(request);
    return noStoreJson({ projects: await listProjects(ownerId) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 6 * 1024 * 1024) return noStoreJson({ error: '项目数据过大。' }, { status: 413 });
    const input = await request.json() as Omit<SavedVideoProject, 'id' | 'createdAt' | 'updatedAt'>;
    if (!input?.analysis?.source || !input?.brief || !input.title) {
      return noStoreJson({ error: '项目数据不完整。' }, { status: 400 });
    }
    const project = await createProject(ownerId, {
      ...input,
      stage: 'analysis',
      proposals: null,
      selections: {},
      referenceAssets: [],
      creativePack: null,
    });
    return noStoreJson({ project }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
