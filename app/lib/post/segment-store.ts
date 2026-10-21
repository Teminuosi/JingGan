// 生成好的段落存在浏览器 IndexedDB：拼接、包装都在本机完成，不再依赖 7 天就过期的签名链接。
// 键 = 账号 | 项目 | 段落 | 请求指纹；同一段只留最新一份（新的存进来就删旧的，视频文件大，别越攒越多）。
import { accountFetch, currentAccountId } from '../account-client';
import { loadConnection } from '../relay-client';
import { latestByRun, type SegmentMeta } from './segments';

export interface SegmentRecord extends SegmentMeta { key: string; account: string; projectId: string; blob: Blob }

const DATABASE = 'mirror-post-segments';
const STORE = 'segments';
export const SEGMENTS_CHANGED = 'mirror:segments-changed';

const accountOf = () => currentAccountId() || 'guest';
const prefix = (account: string, projectId: string) => `${account}|${projectId}|`;

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('本机存储写入被中止（可能空间不足）。'));
  });
}

/** 这个项目在本机存着的全部段落（当前账号）。 */
export async function listSegments(projectId: string, account = accountOf()): Promise<SegmentRecord[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const start = prefix(account, projectId);
      const request = db.transaction(STORE).objectStore(STORE).getAll(IDBKeyRange.bound(start, `${start}￿`));
      request.onsuccess = () => resolve((request.result as SegmentRecord[]).filter(record => record?.blob instanceof Blob));
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function latestSegments(projectId: string): Promise<Record<string, SegmentRecord>> {
  return latestByRun(await listSegments(projectId));
}

/** 存一段；同一段的旧记录一并删掉。 */
export async function saveSegment(projectId: string, meta: SegmentMeta, blob: Blob): Promise<SegmentRecord> {
  const account = accountOf();
  const key = `${prefix(account, projectId)}${meta.runId}|${meta.requestHash || `local-${meta.createdAt}`}`;
  const record: SegmentRecord = { ...meta, key, account, projectId, blob };
  const old = (await listSegments(projectId, account)).filter(item => item.runId === meta.runId && item.key !== key);
  const db = await database();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(record, key);
    for (const item of old) store.delete(item.key);
    await done(tx);
  } finally { db.close(); }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEGMENTS_CHANGED, { detail: { projectId } }));
  return record;
}

export async function deleteSegment(projectId: string, key: string): Promise<void> {
  const db = await database();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await done(tx);
  } finally { db.close(); }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEGMENTS_CHANGED, { detail: { projectId } }));
}

/** 读出实测时长；同时确认这个文件浏览器解得开（解不开就不收）。 */
export async function measureBlob(blob: Blob): Promise<number> {
  const { measureSegments } = await import('./compose');
  const [seconds] = await measureSegments([blob]);
  if (!(seconds > 0)) throw new Error('读不出这段视频的时长，文件可能损坏或格式不支持。');
  return seconds;
}

/**
 * 把生成好的视频取回来。先试浏览器直接读（链接允许跨域时最省事）；不行再走镜感服务器转发
 * （/api/relay/video-file：要登录、只转 https 公网视频、不落盘）。都不计费。
 */
export async function fetchSegmentVideo(url: string, signal?: AbortSignal): Promise<Blob> {
  try {
    const direct = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    if (direct.ok && /^video\//i.test(direct.headers.get('content-type') ?? '')) return await direct.blob();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    /* 跨域被拦是预期内的，走转发 */
  }
  const config = loadConnection('video');
  const response = await accountFetch('/api/relay/video-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-base': config.baseUrl },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!response.ok) {
    const message = await response.json().then(value => (value as { error?: string }).error).catch(() => undefined);
    throw new Error(message || `取回视频失败（HTTP ${response.status}）。`);
  }
  return await response.blob();
}
