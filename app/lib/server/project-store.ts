import { MIGRATIONS } from '../../../db/migrations';
import type { ReferenceAsset, SavedVideoProject, SavedVideoProjectSummary } from '../types';
import { requireDatabase } from './bindings';
import { normalizeMinuteSecondTimeline } from '../timeline-normalization.mjs';

interface ProjectRow {
  id: string;
  title: string;
  source_name: string;
  duration_seconds: number;
  aspect_ratio: string;
  stage: SavedVideoProject['stage'];
  analysis_json: string;
  brief_json: string;
  proposals_json: string | null;
  selections_json: string;
  reference_assets_json: string;
  creative_pack_json: string | null;
  model_version: string;
  usage_json: string;
  created_at: number;
  updated_at: number;
}

let schemaReady = false;

async function dbReady(): Promise<D1Database> {
  const db = requireDatabase();
  if (!schemaReady) {
    await db.batch(MIGRATIONS.map((statement) => db.prepare(statement)));
    schemaReady = true;
  }
  return db;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error('corrupt_project');
  }
}

function toProject(row: ProjectRow): SavedVideoProject {
  return {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    stage: row.stage,
    analysis: normalizeMinuteSecondTimeline(parseJson(row.analysis_json, null as never)),
    brief: parseJson(row.brief_json, null as never),
    proposals: parseJson(row.proposals_json, null),
    selections: parseJson(row.selections_json, {}),
    referenceAssets: parseJson(row.reference_assets_json, []),
    creativePack: parseJson(row.creative_pack_json, null),
    modelVersion: row.model_version,
    usage: parseJson(row.usage_json, { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 }),
  };
}

export async function listProjects(ownerId: string): Promise<SavedVideoProjectSummary[]> {
  const db = await dbReady();
  const result = await db.prepare(
    `SELECT id, title, source_name, duration_seconds, aspect_ratio, stage, created_at, updated_at
     FROM video_projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100`,
  ).bind(ownerId).all<Pick<ProjectRow, 'id' | 'title' | 'source_name' | 'duration_seconds' | 'aspect_ratio' | 'stage' | 'created_at' | 'updated_at'>>();
  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    stage: row.stage,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function claimLocalProjects(ownerId: string, ids: string[]): Promise<void> {
  const db = await dbReady();
  for (const id of ids) {
    const results = await db.batch([
      db.prepare("UPDATE video_projects SET owner_id = ? WHERE id = ? AND owner_id = 'local_seedy'").bind(ownerId, id),
      db.prepare("UPDATE projects SET owner_id = ? WHERE legacy_project_id = ? AND owner_id = 'local_seedy' AND EXISTS (SELECT 1 FROM video_projects WHERE id = ? AND owner_id = ?)").bind(ownerId, id, id, ownerId),
    ]);
    if (!results[0].meta.changes) throw new Error('write_conflict');
  }
}

export async function getProject(ownerId: string, id: string): Promise<SavedVideoProject | null> {
  const db = await dbReady();
  const row = await db.prepare('SELECT * FROM video_projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<ProjectRow>();
  return row ? toProject(row) : null;
}

export async function createProject(ownerId: string, input: Omit<SavedVideoProject, 'id' | 'createdAt' | 'updatedAt'>): Promise<SavedVideoProject> {
  const db = await dbReady();
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO video_projects (
      id, owner_id, title, source_name, duration_seconds, aspect_ratio, stage,
      analysis_json, brief_json, proposals_json, selections_json, reference_assets_json,
      creative_pack_json, model_version, usage_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    ownerId,
    input.title,
    input.sourceName,
    input.analysis.source.duration_seconds,
    input.analysis.source.aspect_ratio,
    input.stage,
    JSON.stringify(input.analysis),
    JSON.stringify(input.brief),
    input.proposals ? JSON.stringify(input.proposals) : null,
    JSON.stringify(input.selections),
    JSON.stringify(input.referenceAssets),
    input.creativePack ? JSON.stringify(input.creativePack) : null,
    input.modelVersion,
    JSON.stringify(input.usage),
    now,
    now,
  ).run();
  const created = await getProject(ownerId, id);
  if (!created) throw new Error('not_found');
  return created;
}

export async function updateProject(
  ownerId: string,
  id: string,
  input: Partial<Omit<SavedVideoProject, 'id' | 'createdAt' | 'updatedAt' | 'analysis' | 'sourceName'>> & { analysis?: SavedVideoProject['analysis']; sourceName?: string },
  expectedUpdatedAt: string,
): Promise<SavedVideoProject> {
  const db = await dbReady();
  const previousRevision = Date.parse(expectedUpdatedAt);
  if (!Number.isFinite(previousRevision)) throw new Error('write_conflict');
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (input.title !== undefined) add('title', input.title);
  if (input.sourceName !== undefined) add('source_name', input.sourceName);
  if (input.stage !== undefined) add('stage', input.stage);
  if (input.analysis !== undefined) {
    add('analysis_json', JSON.stringify(input.analysis));
    add('duration_seconds', input.analysis.source.duration_seconds);
    add('aspect_ratio', input.analysis.source.aspect_ratio);
  }
  if (input.brief !== undefined) add('brief_json', JSON.stringify(input.brief));
  if (input.proposals !== undefined) add('proposals_json', input.proposals ? JSON.stringify(input.proposals) : null);
  if (input.selections !== undefined) add('selections_json', JSON.stringify(input.selections));
  if (input.referenceAssets !== undefined) add('reference_assets_json', JSON.stringify(input.referenceAssets));
  if (input.creativePack !== undefined) add('creative_pack_json', input.creativePack ? JSON.stringify(input.creativePack) : null);
  if (input.modelVersion !== undefined) add('model_version', input.modelVersion);
  if (input.usage !== undefined) add('usage_json', JSON.stringify(input.usage));
  if (assignments.length > 0) {
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects
       SET ${assignments.join(', ')}, updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(...values, nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) === 0) {
      if (!(await getProject(ownerId, id))) throw new Error('not_found');
      throw new Error('write_conflict');
    }
  }
  const updated = await getProject(ownerId, id);
  if (!updated) throw new Error('not_found');
  return updated;
}

export async function saveReferenceAsset(
  ownerId: string,
  id: string,
  asset: ReferenceAsset,
  options: { selectCandidate?: boolean } = {},
): Promise<{ project: SavedVideoProject; discardedAssets: ReferenceAsset[] }> {
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    const trackedAsset = current.referenceAssets.find((item) => item.asset_id === asset.asset_id);
    if (!trackedAsset?.retired || !trackedAsset.uploading) throw new Error('invalid_asset');
    const roleSet = current.proposals?.role_sets.find((set) =>
      set.candidates.some((candidate) =>
        candidate.candidate_id === asset.candidate_id &&
        candidate.character_id === asset.character_id &&
        candidate.reference_image_prompt === asset.prompt,
      ),
    );
    if (!roleSet) throw new Error('invalid_asset');
    const discardedAssets = current.referenceAssets.filter((item) =>
      !item.retired && item.character_id === asset.character_id && item.candidate_id === asset.candidate_id && !item.approved &&
      !current.proposals?.archived_role_sets?.some(s => s.candidates.some(c => c.candidate_id === item.candidate_id && c.reference_image_prompt === item.prompt)),
    );
    const discardedIds = new Set(discardedAssets.map((item) => item.asset_id));
    let replacedTrackedAsset = false;
    const nextAssets = current.referenceAssets.map((item) => {
      if (item.asset_id === asset.asset_id) {
        replacedTrackedAsset = true;
        return { ...asset, approved: false, retired: false, uploading: false };
      }
      return discardedIds.has(item.asset_id) ? { ...item, retired: true } : item;
    });
    if (!replacedTrackedAsset) nextAssets.push({ ...asset, approved: false, retired: false, uploading: false });
    const nextSelections = options.selectCandidate === false ? current.selections : { ...current.selections, [roleSet.source_role_id]: asset.candidate_id };
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects
       SET reference_assets_json = ?, selections_json = ?, stage = 'references', updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), JSON.stringify(nextSelections), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) {
      const project = await getProject(ownerId, id);
      if (!project) throw new Error('not_found');
      return { project, discardedAssets };
    }
  }
  throw new Error('write_conflict');
}

export async function approveReferenceAsset(
  ownerId: string,
  id: string,
  assetId: string,
): Promise<{ project: SavedVideoProject; approvedAsset: ReferenceAsset; discardedAssets: ReferenceAsset[] }> {
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    const target = current.referenceAssets.find((item) => item.asset_id === assetId && !item.retired);
    if (!target || target.uri.startsWith('data:')) throw new Error('invalid_asset');
    const roleSet = current.proposals?.role_sets.find((set) =>
      set.candidates.some((candidate) =>
        candidate.candidate_id === target.candidate_id &&
        candidate.character_id === target.character_id &&
        candidate.reference_image_prompt === target.prompt,
      ),
    );
    if (!roleSet || current.selections[roleSet.source_role_id] !== target.candidate_id) throw new Error('invalid_asset');
    const discardedAssets = current.referenceAssets.filter((item) =>
      !item.retired && item.character_id === target.character_id && item.candidate_id === target.candidate_id && item.asset_id !== target.asset_id &&
      !current.proposals?.archived_role_sets?.some(s => s.candidates.some(c => c.candidate_id === item.candidate_id && c.reference_image_prompt === item.prompt)),
    );
    const discardedIds = new Set(discardedAssets.map((item) => item.asset_id));
    const approvedAsset = { ...target, approved: true, retired: false };
    const nextAssets = current.referenceAssets.map((item) => {
      if (item.asset_id === target.asset_id) return approvedAsset;
      if (discardedIds.has(item.asset_id)) return { ...item, retired: true };
      return item;
    });
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects
       SET reference_assets_json = ?, stage = 'references', updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) {
      const project = await getProject(ownerId, id);
      if (!project) throw new Error('not_found');
      return { project, approvedAsset, discardedAssets };
    }
  }
  throw new Error('write_conflict');
}

export async function discardReferenceAsset(
  ownerId: string,
  id: string,
  assetId: string,
): Promise<{ project: SavedVideoProject; discardedAsset: ReferenceAsset }> {
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    const target = current.referenceAssets.find((item) => item.asset_id === assetId && !item.retired);
    if (!target || target.approved || target.uri.startsWith('data:')) throw new Error('invalid_asset');
    const nextAssets = current.referenceAssets.map((item) =>
      item.asset_id === target.asset_id ? { ...item, retired: true } : item,
    );
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects
       SET reference_assets_json = ?, stage = 'references', updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) {
      const project = await getProject(ownerId, id);
      if (!project) throw new Error('not_found');
      return { project, discardedAsset: target };
    }
  }
  throw new Error('write_conflict');
}

export async function purgeRetiredAssetRecords(ownerId: string, id: string, assetIds: string[]): Promise<SavedVideoProject> {
  const ids = new Set(assetIds);
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    const nextAssets = current.referenceAssets.filter((item) =>
      !(item.retired && !item.uploading && ids.has(item.asset_id)),
    );
    if (nextAssets.length === current.referenceAssets.length) return current;
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects SET reference_assets_json = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) {
      const project = await getProject(ownerId, id);
      if (!project) throw new Error('not_found');
      return project;
    }
  }
  throw new Error('write_conflict');
}

export async function trackRetiredAsset(ownerId: string, id: string, asset: ReferenceAsset): Promise<void> {
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    if (current.referenceAssets.some((item) => item.asset_id === asset.asset_id)) return;
    const nextAssets = [...current.referenceAssets, { ...asset, approved: false, retired: true, uploading: true }];
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects SET reference_assets_json = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) return;
  }
  throw new Error('write_conflict');
}

export async function retireTrackedAsset(ownerId: string, id: string, assetId: string): Promise<boolean> {
  const db = await dbReady();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await getProject(ownerId, id);
    if (!current) throw new Error('not_found');
    const tracked = current.referenceAssets.find((item) =>
      item.asset_id === assetId && item.retired && item.uploading,
    );
    if (!tracked) return false;
    const nextAssets = current.referenceAssets.map((item) =>
      item.asset_id === assetId ? { ...item, uploading: false } : item,
    );
    const previousRevision = Date.parse(current.updatedAt);
    const nextRevision = Math.max(Date.now(), previousRevision + 1);
    const result = await db.prepare(
      `UPDATE video_projects SET reference_assets_json = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(JSON.stringify(nextAssets), nextRevision, id, ownerId, previousRevision).run();
    if ((result.meta.changes ?? 0) > 0) return true;
  }
  throw new Error('write_conflict');
}

export async function projectExists(ownerId: string, id: string): Promise<boolean> {
  const db = await dbReady();
  const row = await db.prepare('SELECT id FROM video_projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<{ id: string }>();
  return Boolean(row);
}
