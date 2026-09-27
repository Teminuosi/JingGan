import { apiError, assertSameOrigin, noStoreJson, requireOwner } from '../../../../lib/server/auth';
import { requireImages } from '../../../../lib/server/bindings';
import {
  approveReferenceAsset,
  discardReferenceAsset,
  purgeRetiredAssetRecords,
  getProject,
  retireTrackedAsset,
  saveReferenceAsset,
  trackRetiredAsset,
} from '../../../../lib/server/project-store';
import type { ReferenceAsset } from '../../../../lib/types';

export const dynamic = 'force-dynamic';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARACTERS = 12_000;
const UPLOAD_LEASE_MS = 60 * 60 * 1000;

function activeAssets(assets: ReferenceAsset[]): ReferenceAsset[] {
  return assets.filter((asset) => !asset.retired);
}

async function cleanupRetiredAssets(
  images: R2Bucket,
  ownerId: string,
  projectId: string,
  assets: ReferenceAsset[],
): Promise<string | null> {
  const now = Date.now();
  const retired: ReferenceAsset[] = [];
  for (const asset of assets) {
    if (!asset.retired || !asset.uri.startsWith(`/api/assets/${projectId}/`)) continue;
    if (asset.uploading) {
      if (now - Date.parse(asset.created_at) <= UPLOAD_LEASE_MS) continue;
      try {
        if (!(await retireTrackedAsset(ownerId, projectId, asset.asset_id))) continue;
      } catch {
        continue;
      }
    }
    retired.push({ ...asset, uploading: false });
  }
  const deletedIds = (await Promise.all(retired.map(async (asset) => {
    try {
      await images.delete(`projects/${projectId}/${asset.asset_id}`);
      return asset.asset_id;
    } catch {
      return null;
    }
  }))).filter((assetId): assetId is string => Boolean(assetId));
  if (deletedIds.length === 0) return null;
  try {
    const project = await purgeRetiredAssetRecords(ownerId, projectId, deletedIds);
    return project.updatedAt;
  } catch {
    // The tombstones stay in D1 so a later asset operation can safely retry cleanup.
    return null;
  }
}

function hasExpectedSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  }
  return false;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const { id: projectId } = await params;
    const form = await request.formData();
    const file = form.get('file');
    const characterId = String(form.get('characterId') ?? '');
    const candidateId = String(form.get('candidateId') ?? '');
    const submittedPrompt = String(form.get('prompt') ?? '');
    const selectCandidate = String(form.get('selectCandidate') ?? 'true') !== 'false';
    if (!(file instanceof File) || !characterId || !candidateId) {
      return noStoreJson({ error: '参考图数据不完整。' }, { status: 400 });
    }
    if (submittedPrompt.length > MAX_PROMPT_CHARACTERS) {
      return noStoreJson({ error: '参考图提示词过长。' }, { status: 400 });
    }
    const currentProject = await getProject(ownerId, projectId);
    const candidate = currentProject?.proposals?.role_sets
      .flatMap((roleSet) => roleSet.candidates)
      .find((item) => item.character_id === characterId && item.candidate_id === candidateId);
    if (!candidate) return noStoreJson({ error: '参考图与当前角色方案不匹配。' }, { status: 409 });
    const prompt = candidate.reference_image_prompt;
    if (!ALLOWED_MIME.has(file.type) || file.size > MAX_IMAGE_BYTES) {
      return noStoreJson({ error: '只接受 8 MB 以内的 PNG、JPEG 或 WebP 图片。' }, { status: 415 });
    }
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    if (!hasExpectedSignature(file.type, fileBytes)) {
      return noStoreJson({ error: '图片内容与文件类型不一致。' }, { status: 415 });
    }
    const assetId = crypto.randomUUID();
    const key = `projects/${projectId}/${assetId}`;
    const images = requireImages();
    const asset = {
      asset_id: assetId,
      project_id: projectId,
      character_id: characterId,
      candidate_id: candidateId,
      kind: 'identity_sheet' as const,
      uri: `/api/assets/${projectId}/${assetId}`,
      mime_type: file.type,
      prompt,
      approved: false,
      created_at: new Date().toISOString(),
    };
    await trackRetiredAsset(ownerId, projectId, asset);
    try {
      await images.put(key, fileBytes, {
        httpMetadata: { contentType: file.type, cacheControl: 'private, no-store' },
      });
    } catch (error) {
      let cleanupClaimed = false;
      try {
        cleanupClaimed = await retireTrackedAsset(ownerId, projectId, asset.asset_id);
      } catch {
        // The upload is being aborted; its lease record remains safe to retry later.
      }
      if (cleanupClaimed) {
        await cleanupRetiredAssets(images, ownerId, projectId, [{ ...asset, retired: true, uploading: false }]);
      }
      throw error;
    }
    let saved;
    try {
      saved = await saveReferenceAsset(ownerId, projectId, asset, { selectCandidate });
    } catch (error) {
      let cleanupClaimed = false;
      try {
        cleanupClaimed = await retireTrackedAsset(ownerId, projectId, asset.asset_id);
      } catch {
        // An ambiguous D1 outcome must not delete a possibly active R2 object.
      }
      if (cleanupClaimed) {
        await cleanupRetiredAssets(images, ownerId, projectId, [{ ...asset, retired: true, uploading: false }]);
      }
      throw error;
    }
    const cleanedUpdatedAt = await cleanupRetiredAssets(images, ownerId, projectId, saved.project.referenceAssets);
    return noStoreJson({
      asset,
      referenceAssets: activeAssets(saved.project.referenceAssets),
      updatedAt: cleanedUpdatedAt ?? saved.project.updatedAt,
    }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const { id: projectId } = await params;
    const { assetId } = await request.json() as { assetId?: string };
    if (!assetId) return noStoreJson({ error: '缺少参考图 ID。' }, { status: 400 });
    const images = requireImages();
    const result = await approveReferenceAsset(ownerId, projectId, assetId);
    const cleanedUpdatedAt = await cleanupRetiredAssets(images, ownerId, projectId, result.project.referenceAssets);
    return noStoreJson({
      asset: result.approvedAsset,
      referenceAssets: activeAssets(result.project.referenceAssets),
      updatedAt: cleanedUpdatedAt ?? result.project.updatedAt,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const ownerId = await requireOwner(request);
    const { id: projectId } = await params;
    const { assetId } = await request.json() as { assetId?: string };
    if (!assetId) return noStoreJson({ error: '缺少参考图 ID。' }, { status: 400 });
    const images = requireImages();
    const result = await discardReferenceAsset(ownerId, projectId, assetId);
    const cleanedUpdatedAt = await cleanupRetiredAssets(images, ownerId, projectId, result.project.referenceAssets);
    return noStoreJson({
      referenceAssets: activeAssets(result.project.referenceAssets),
      updatedAt: cleanedUpdatedAt ?? result.project.updatedAt,
    });
  } catch (error) {
    return apiError(error);
  }
}
