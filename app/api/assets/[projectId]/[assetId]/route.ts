import { apiError, requireOwner } from '../../../../lib/server/auth';
import { requireImages } from '../../../../lib/server/bindings';
import { getProject } from '../../../../lib/server/project-store';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; assetId: string }> },
) {
  try {
    const ownerId = await requireOwner(request);
    const { projectId, assetId } = await params;
    const project = await getProject(ownerId, projectId);
    const asset = project?.referenceAssets.find((item) => item.asset_id === assetId && !item.retired);
    if (!asset) throw new Error('not_found');
    const images = requireImages();
    const object = await images.get(`projects/${projectId}/${assetId}`);
    if (!object) throw new Error('not_found');
    const headers = new Headers({ 'Cache-Control': 'private, no-store', ETag: object.httpEtag });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  } catch (error) {
    return apiError(error);
  }
}
