// 读取 worker 落在本地磁盘的产物（成片、关键帧、预演图）。
//
// 只读，且必须把路径钉死在对象根目录内——key 是从数据库来的，
// 但仍然要挡 `..`：一旦有别的写入路径被污染，这里就是最后一道。

import { apiError, requireOwner } from '../../../lib/server/auth';
import { requireDatabase } from '../../../lib/server/bindings';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

export async function GET(request: Request, ctx: { params: Promise<{ key: string[] }> }) {
  try {
    const ownerId = await requireOwner(request);
    const { key } = await ctx.params;
    const rel = key.join('/');
    if (rel.includes('..') || rel.startsWith('/')) {
      return Response.json({ error: '非法路径。' }, { status: 400 });
    }
    const asset = await requireDatabase().prepare('SELECT a.id FROM assets a JOIN projects p ON p.id = a.project_id WHERE a.object_key = ? AND p.owner_id = ?').bind(rel, ownerId).first();
    if (!asset) throw new Error('not_found');

    // Workers 运行时读不了磁盘，本地开发下走 Node 的 fs。
    // 上生产时这里换成对象存储的签名 URL 重定向。
    const { readFile, stat } = await import('node:fs/promises');
    const path = await import('node:path');
    const root = process.env.WORKER_OBJECTS ?? path.join(process.cwd(), '.worker', 'objects');
    const file = path.join(root, rel);
    if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) {
      return Response.json({ error: '非法路径。' }, { status: 400 });
    }

    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return Response.json({ error: '文件不存在。' }, { status: 404 });

    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': TYPES[rel.split('.').pop() ?? ''] ?? 'application/octet-stream',
        'content-length': String(info.size),
        'cache-control': 'private, max-age=60',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
