import type { SavedVideoProject } from '../../../lib/types';
import { apiError, assertSameOrigin, noStoreJson, requireOwner } from '../../../lib/server/auth';
import { getProject, updateProject } from '../../../lib/server/project-store';
import { assertEditableAnalysisPatch } from '../../../lib/validation';

export const dynamic = 'force-dynamic';

function withoutRetiredAssets(project: SavedVideoProject): SavedVideoProject {
  return { ...project, referenceAssets: project.referenceAssets.filter((asset) => !asset.retired) };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ownerId = await requireOwner(request);
    const { id } = await params;
    const project = await getProject(ownerId, id);
    if (!project) throw new Error('not_found');
    return noStoreJson({ project: withoutRetiredAssets(project) });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const { id } = await params;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 6 * 1024 * 1024) return noStoreJson({ error: '项目数据过大。' }, { status: 413 });
    const patch = await request.json() as Partial<SavedVideoProject> & { expectedUpdatedAt?: string };
    if (!patch.expectedUpdatedAt) return noStoreJson({ error: '缺少项目版本，请刷新后重试。' }, { status: 409 });
    const allowed: Partial<SavedVideoProject> = {};
    for (const key of ['stage', 'brief', 'proposals', 'selections', 'creativePack', 'modelVersion', 'usage'] as const) {
      if (patch[key] !== undefined) Object.assign(allowed, { [key]: patch[key] });
    }
    // 分析层可以被人工修正，但只能改「这一镜发生了什么」；时间轴、镜头数、边界、置信度是取证事实，
    // 服务端按已存的那份逐项比对，改了就拒——客户端校验不算数，绕过去就成了伪造证据。
    if (patch.analysis !== undefined) {
      const current = await getProject(ownerId, id);
      if (!current) throw new Error('not_found');
      Object.assign(allowed, { analysis: assertEditableAnalysisPatch(patch.analysis, current.analysis) });
    }
    const project = await updateProject(ownerId, id, allowed, patch.expectedUpdatedAt);
    return noStoreJson({ project: withoutRetiredAssets(project) });
  } catch (error) {
    return apiError(error);
  }
}
