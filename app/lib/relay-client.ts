'use client';

import { readRelayResponse, relayOrigin, requireRelayText } from './relay-protocol';
import { confirmAction } from './confirm';
import { accountFetch, accountStorageKey, canReadLegacyCache, currentAccountId } from './account-client';

export type RelayRole = 'analysis' | 'text' | 'image' | 'video';
export interface RelayConnection { baseUrl: string; apiKey: string; model: string; models: string[]; protocol: 'chat' | 'responses'; videoTransport: 'inline' | 'files'; advancedVideo: boolean; accountId?: string }
const prefix = 'mirror:relay:v1:';
export const roles: RelayRole[] = ['analysis', 'text', 'image', 'video'];
// Key 按用户要求长期记在本机 localStorage，关标签页后仍在；代价是它明文落盘，浏览器扩展与同源脚本可读。
// 仍然只在浏览器保存：不进入项目记录、导出文件和服务端数据库。
const preferenceOf = (role: RelayRole) => accountStorageKey(`${prefix}${role}`);
const keyOf = (role: RelayRole) => accountStorageKey(`${prefix}${role}:key`);
// 分析参数由程序统一处理，旧版手动参数不再作为隐藏覆盖值。
export function loadConnection(role: RelayRole): RelayConnection {
  const defaults: RelayConnection = { baseUrl: 'https://heyroute.ai/v1', apiKey: '', model: '', models: [], protocol: role === 'text' ? 'responses' : 'chat', videoTransport: 'inline', advancedVideo: true };
  if (typeof window === 'undefined' || !currentAccountId()) return defaults;
  try {
    const stored = JSON.parse(localStorage.getItem(preferenceOf(role)) || '{}');
    // 老版本把 Key 存在 sessionStorage，本标签页还留着就继续认，等下次保存时迁到 localStorage。
    const apiKey = localStorage.getItem(keyOf(role)) || sessionStorage.getItem(keyOf(role)) || '';
    return { ...defaults, ...stored, apiKey, accountId: currentAccountId()!, ...(role === 'analysis' ? { videoTransport: 'inline' as const, advancedVideo: true } : {}) };
  } catch { return defaults; }
}
export function saveConnection(role: RelayRole, value: RelayConnection) {
  if (!currentAccountId()) throw new Error('请先登录，再保存 AI 服务配置。');
  relayOrigin(value.baseUrl);
  const { apiKey, ...preferences } = value;
  localStorage.setItem(preferenceOf(role), JSON.stringify(preferences));
  sessionStorage.removeItem(keyOf(role));
  if (apiKey.trim()) localStorage.setItem(keyOf(role), apiKey.trim());
  else localStorage.removeItem(keyOf(role));
}
export function hasLegacyConnections() {
  return roles.some(role => localStorage.getItem(`${prefix}${role}:key`) || sessionStorage.getItem(`${prefix}${role}:key`));
}
export function importLegacyConnections() {
  if (!currentAccountId()) throw new Error('请先登录。');
  for (const role of roles) {
    const key = localStorage.getItem(`${prefix}${role}:key`) || sessionStorage.getItem(`${prefix}${role}:key`);
    if (!key) continue;
    const old = JSON.parse(localStorage.getItem(prefix + role) || '{}');
    saveConnection(role, { ...loadConnection(role), ...old, apiKey: key });
    localStorage.removeItem(`${prefix}${role}:key`); sessionStorage.removeItem(`${prefix}${role}:key`);
    localStorage.removeItem(prefix + role);
  }
}
/** 设置弹窗里的“清除本机 Key”用；三类 Key 一起删干净，两种存储都清。 */
export function forgetStoredKeys() {
  for (const role of roles) {
    localStorage.removeItem(keyOf(role));
    sessionStorage.removeItem(keyOf(role));
  }
}
export function requireConnection(role: RelayRole) {
  const config = loadConnection(role);
  relayOrigin(config.baseUrl);
  if (!config.apiKey || !config.model) throw new Error(`请在“AI 服务设置”填写${{ analysis: '视频分析', text: '故事与角色设计', image: '生图', video: '视频生成' }[role]} Key，并拉取、选择模型。`);
  return config;
}
export const relayHeaders = (config: RelayConnection) => ({ 'x-relay-base': config.baseUrl, 'x-relay-key': config.apiKey, 'x-mirror-account-id': config.accountId || currentAccountId() || '' });
export async function relayRequest(config: RelayConnection, kind: string, payload?: unknown, onEvent?: (event: string) => void) {
  const response = await accountFetch('/api/relay/request', { method: 'POST', headers: { ...relayHeaders(config), 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, payload }), signal: AbortSignal.timeout(kind === 'models' ? 30000 : 20 * 60 * 1000) });
  return readRelayResponse(response, onEvent);
}
export async function listRelayModels(config: RelayConnection): Promise<string[]> {
  const result = await relayRequest(config, 'models') as { data?: { id: string }[]; models?: { name: string }[] };
  const models = [...new Set(result.data?.map(m => m.id) || result.models?.map(m => m.name.replace(/^models\//, '')) || [])].filter(m => typeof m === 'string' && m.length > 0).sort();
  if (!models.length) throw new Error('接口未返回模型列表；请确认 Key 分组和中转地址。');
  return models;
}

type CachedTask = { status: 'pending' | 'completed' | 'unknown' | 'failed'; startedAt: number; result?: unknown; failedAt?: number; error?: string };
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('mirror-relay-results', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('results');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地结果缓存；为避免生成后丢失，未提交付费请求。'));
  });
}
async function cachedTask(key: string, value?: CachedTask, scopedKey = accountStorageKey(key), legacyAllowed = canReadLegacyCache(key)): Promise<CachedTask | undefined> {
  const legacyKey = key;
  key = scopedKey;
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('results', value ? 'readwrite' : 'readonly');
      const request = value ? tx.objectStore('results').put(value, key) : tx.objectStore('results').get(key);
      tx.oncomplete = () => {
        if (!value && !request.result && legacyAllowed) {
          const oldTx = db.transaction('results', 'readonly');
          const old = oldTx.objectStore('results').get(legacyKey);
          oldTx.oncomplete = () => resolve(old.result);
          oldTx.onerror = () => reject(new Error('旧项目缓存读取失败。'));
        } else resolve(value || request.result);
      };
      tx.onerror = () => reject(new Error('本地结果缓存写入失败，请勿重复生成。'));
      tx.onabort = () => reject(new Error('本地结果缓存写入中断。'));
    });
  } finally { db.close(); }
}
const active = new Set<string>();
export async function runRelayTask(key: string, execute: () => Promise<unknown>): Promise<unknown> {
  const owner = currentAccountId();
  const scopedKey = accountStorageKey(key);
  const legacyAllowed = canReadLegacyCache(key);
  const run = async () => {
    if (active.has(scopedKey)) throw new Error('此任务正在处理，请勿重复点击。');
    active.add(scopedKey);
    try {
      const old = await cachedTask(key, undefined, scopedKey, legacyAllowed);
      // 「明确失败」和「提交后失联」要分开说：前者知道原因、多半没产出，后者才需要担心已经扣了钱。
      // 一律用最吓人的那句会让人对每次重试都犹豫，久了就不看了。
      if (old && old.status !== 'completed' && !await confirmAction(old.status === 'failed' ? {
        title: '上次这一步失败了',
        message: `失败时间：${new Date(old.failedAt ?? old.startedAt).toLocaleString('zh-CN')}\n原因：${old.error || '未记录'}\n\n上次没有产出任何结果。如果失败原因是参数或配置问题，改好后重试即可。`,
        confirmLabel: '重新运行',
        cancelLabel: '先不跑',
      } : {
        title: '上次这一步没有跑完',
        message: '上次请求提交后就失去了联系，可能仍在中转生成并计费。建议先到中转站的使用日志确认那一次的状态，再决定要不要重来。',
        confirmLabel: '仍然重新提交（可能再次扣费）',
        cancelLabel: '先不提交',
        danger: true,
      })) throw new Error('已保留上次任务，不重复提交。');
      const startedAt = Date.now();
      if (currentAccountId() !== owner) throw new Error('账号已切换，任务未提交。');
      await cachedTask(key, { status: 'pending', startedAt }, scopedKey);
      let result: unknown;
      try {
        result = await execute();
        await cachedTask(key, { status: 'completed', startedAt, result }, scopedKey);
      } catch (cause) {
        // 失败必须留痕。以前失败只留一条没有结果的 pending 记录，错误原因随页面一起消失，
        // 于是用户重跑失败后看到的还是上一次的旧数据，看起来像「跑了但没变化」——
        // 实际是根本没跑成。把原因和时间点存下来，界面和诊断才有东西可说。
        await cachedTask(key, { status: 'failed', startedAt, failedAt: Date.now(), error: cause instanceof Error ? cause.message : String(cause) }, scopedKey).catch(() => {});
        throw cause;
      }
      if (currentAccountId() !== owner) throw new Error('账号已切换，结果已保存在原账号的本机缓存中，请登录原账号恢复。');
      return result;
    } finally { active.delete(scopedKey); }
  };
  if (navigator.locks) return navigator.locks.request(prefix + scopedKey, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('另一个标签页正在生成此结果。');
    return run();
  });
  return run();
}
/** 上次提交是否停在未完成状态；返回它的开始时间，供界面把话说准。 */
export async function pendingRelayTask(key: string): Promise<number | undefined> {
  const task = await cachedTask(key);
  return task && task.status !== 'completed' ? task.startedAt : undefined;
}

/** 上一次这一步的结局：成功 / 明确失败（带原因）/ 提交后失联。界面据此把话说准，不让人以为「跑了但没变化」。 */
export async function lastRelayOutcome(key: string): Promise<{ status: CachedTask['status']; startedAt: number; failedAt?: number; error?: string } | undefined> {
  const task = await cachedTask(key);
  if (!task) return undefined;
  return { status: task.status, startedAt: task.startedAt, failedAt: task.failedAt, error: task.error };
}

/** 上游明确拒绝、没有建任务时用，清掉 pending 记录，免得下次提交被虚报成"可能已计费"。 */
export async function clearRelayTask(key: string, owner = currentAccountId()): Promise<void> {
  const scopedKey = accountStorageKey(key, owner);
  const legacyAllowed = currentAccountId() === owner && canReadLegacyCache(key);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').delete(scopedKey);
      if (legacyAllowed) tx.objectStore('results').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('清理本地任务记录失败。'));
    });
  } finally { db.close(); }
}

export async function recoverRelayTask(key: string): Promise<unknown> {
  const task = await cachedTask(key);
  if (!task) throw new Error('没有此任务的本地中转结果。已有项目和旧图不受影响。');
  if (task.status !== 'completed') throw new Error('未收到完整结果。请先查看中转使用日志，关闭页面或断线不代表上游未扣费。');
  return task.result;
}
export async function completedRelayTask(key: string): Promise<unknown | undefined> {
  const task = await cachedTask(key);
  return task?.status === 'completed' ? task.result : undefined;
}
export async function generateRelayText(prompt: string, cacheKey: string, onEvent: (event: string) => void = () => {}) {
  const config = requireConnection('text');
  const result = await runRelayTask(cacheKey, () => relayRequest(config, config.protocol, config.protocol === 'responses'
    ? { model: config.model, input: prompt, stream: true, max_output_tokens: 32768 }
    : { model: config.model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 32768 }, onEvent));
  return requireRelayText(result);
}
export async function generateRelayImage(prompt: string, cacheKey: string, onEvent: (event: string) => void, source?: Blob): Promise<Blob> {
  const config = requireConnection('image');
  const result = await runRelayTask(cacheKey, async () => {
    if (!source) return relayRequest(config, 'image', { model: config.model, prompt, n: 1, response_format: 'b64_json' }, onEvent);
    const form = new FormData();
    form.set('model', config.model); form.set('prompt', prompt); form.set('n', '1'); form.set('response_format', 'b64_json');
    form.set('image', source, 'reference.' + (source.type === 'image/jpeg' ? 'jpg' : source.type === 'image/webp' ? 'webp' : 'png'));
    return readRelayResponse(await accountFetch('/api/relay/edit', { method: 'POST', headers: relayHeaders(config), body: form, signal: AbortSignal.timeout(20 * 60 * 1000) }), onEvent);
  });
  return imageFromResult(result);
}
export async function imageFromResult(result: unknown): Promise<Blob> {
  const data = result as { data?: { b64_json?: string; url?: string }[] };
  const item = data?.data?.[0];
  if (!item?.b64_json && item?.url) {
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.endsWith('.local') || url.hostname.endsWith('.localhost')) throw new Error('中转返回了不安全的图片地址，已拒绝读取。');
    try {
      const response = await fetch(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('链接无效');
      const blob = await response.blob();
      if (blob.size > 8 * 1024 * 1024) throw new Error('图片超过项目 8 MB 限制');
      return blob;
    } catch { throw new Error('图片临时链接下载失败（可能跨域、过期或超过 8 MB），原始结果已缓存。请先恢复结果或从中转下载后手动上传，不要再次付费生成。'); }
  }
  if (!item?.b64_json) throw new Error('中转已结束但没有返回图片，原始结果已缓存。');
  const binary = atob(item.b64_json.replace(/^data:[^,]*,/, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const type = bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x52 ? 'image/webp' : 'image/png';
  return new Blob([bytes], { type });
}

// ---- 视频生成：异步任务，提交即扣费 ----
// 防重复扣费的关键是缓存 task_id 而不是成片：提交是唯一的扣费点，轮询不花钱。
// 只要 task_id 还在本地，关页面、断线、换标签页回来都能接着轮询，不需要也不应该再提交一次。

export interface VideoTaskState { status: string; progress?: number; videoUrl?: string; error?: string }

/** 找回缓存里那次提交的原始返回，供界面在解析不出任务 ID 时原样展示——钱已经花了，不能让结果彻底取不回来。 */
export async function rawRelayVideoResult(cacheKey: string): Promise<unknown | undefined> {
  return completedRelayTask(cacheKey);
}

const TASK_ID_KEY = /^(task_?id|id|taskId|videoTaskId|job_?id|request_?id)$/i;
const TASK_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;

/**
 * 任务 ID 的字段名各家不一样，文档里只写了"返回 JSON 里有 TASK_ID"。
 * 与其猜几个名字猜不中就抛错（那次提交已经扣过费了），不如整个响应递归找一遍；
 * 真找不到也要把原始返回塞进报错里，让人能自己把 ID 摘出来。
 */
function taskIdFrom(result: unknown): string {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && TASK_ID_KEY.test(key) && TASK_ID_SHAPE.test(value.trim())) return value.trim();
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = Array.isArray(value)
        ? value.map(walk).find(Boolean)
        : walk(value);
      if (found) return found;
    }
    return undefined;
  };
  const id = walk(result);
  if (id) return id;
  const dump = (() => { try { return JSON.stringify(result); } catch { return String(result); } })();
  throw new Error([
    '这次提交已经发出去（很可能已计费），但返回里找不到任务 ID，所以没法自动轮询。',
    '原始返回如下，请从里面找到任务 ID，用下面的「用任务 ID 继续查」接着查，不要重新提交：',
    dump.slice(0, 1200),
  ].join('\n'));
}

/** 提交一次生成。已经提交过同一份内容就直接复用旧 task_id，不再扣一次费。 */
export async function submitRelayVideo(body: Record<string, unknown>, cacheKey: string): Promise<string> {
  const config = requireConnection('video');
  const owner = currentAccountId();
  const cached = await completedRelayTask(cacheKey);
  if (cached !== undefined) return taskIdFrom(cached);
  // 上次没跑完时，runRelayTask 会弹一句泛泛的"可能已计费"。视频这条线知道得更多：
  // 没拿到 task_id 就说明任务多半没建成，所以这里自己问一次把话说准，并清掉旧记录避免二次弹窗。
  const stalledAt = await pendingRelayTask(cacheKey);
  if (stalledAt !== undefined) {
    const minutes = Math.max(1, Math.round((Date.now() - stalledAt) / 60000));
    const proceed = await confirmAction({
      title: `这一段 ${minutes} 分钟前提交过一次`,
      message: [
        '上次提交没有拿到任务 ID。',
        '',
        '· 如果当时上游是明确报错（例如「可用渠道不存在」、模型未开通、参数无效），任务没有创建，也没有扣费，可以放心重提。',
        '· 如果当时是断网、关页面或超时，任务可能已经建好并在计费——请先到中转站的使用日志确认，再决定。',
      ].join('\n'),
      confirmLabel: '重新提交',
      cancelLabel: '先去查日志',
      danger: true,
    });
    if (!proceed) throw new Error('已取消，没有重复提交。可以先去中转使用日志确认上一次的状态。');
    if (owner !== currentAccountId()) throw new Error('账号已切换，任务未提交。');
    await clearRelayTask(cacheKey, owner).catch(() => {});
  }
  try {
    const result = await runRelayTask(cacheKey, () => relayRequest(config, 'video', { ...body, model: config.model }));
    return taskIdFrom(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // 上游明确回了一个拒绝（渠道不存在、模型没开通、参数不合法），说明任务压根没建、也没扣费，
    // 那就把 pending 记录清掉；否则下次提交会被虚报成"上次可能已计费"。
    // 网络中断、超时这类"不知道对面收没收"的情况必须保留记录，宁可多问一句。
    // 524/504/超时：请求到了上游但没等到回复，任务可能已经建好并在计费——绝不能当成"没发生过"。
    if (/(524|504|408)|超时|timeout|timed out/i.test(message)) {
      throw new Error(
        `${message}
这是"请求发出去了但没等到回复"，不是明确失败：任务可能已经建好并在计费。
`
        + `先去中转站的使用日志看有没有新任务——有就用「用任务 ID 继续查」接着轮询，没有再重新提交。
`
        + `常见原因是请求体太大（角色参考图会随请求一起上传），本地已按长边 1280px 压缩，仍然超时就减少本段出场角色或换个网络环境。`,
      );
    }
    if (/渠道不存在|model_not_found|不支持|无效|未开通|分组|400|404/.test(message)) {
      await clearRelayTask(cacheKey, owner).catch(() => {});
      if (/渠道不存在/.test(message)) {
        // 上面一行是中转的原话，下面是我们的解释——两者必须能被用户分开看，不能糊成一片。
        //
        // 「换一个视频模型」这条建议 2026-09-10 被实测证伪：那天 seedance-2.5 先掉线，换到 MiniMax-H3
        // 半小时后同样掉线。中转的上游线路是按模型逐条上下线的，可能一条挂，也可能一批一起挂，
        // 所以不能一口咬定换档就行，得让人自己用免费探测问一遍。
        //
        // 「没有扣费」以前是直接下的断言。其实我们只知道"渠道都没选到，请求不可能转发上游"，
        // 这是推断不是证据。所以现在把话说准，并指向真正能证实它的地方：用量里程表。
        throw new Error(`${message}
———— 以上是中转的原话，以下是本机的解释 ————
这一档在你 Key 所属的视频分组下没有可用上游线路。可能是该分组没开通这个模型，也可能是中转站的这条线路临时挂了。

怎么办：先重试一次；仍然失败就展开「请求参数」点「探测这一档的真实限制」（免费，不建任务），换别的视频模型各探一次——
上游回参数报错＝那一档还能用；同样回"可用渠道不存在"＝那一档也挂了。全都挂就是中转站的视频线路整体掉了，只能等站主处理。

关于扣费：渠道都没选到，请求不可能转发给上游，按理不会计费。但这是推断不是证据——
要坐实就去中转站看使用日志，或者用探测功能的用量对账（它会在探测前后各读一次累计用量）。`);
      }
    }
    throw cause;
  }
}

/**
 * 中转的累计用量。当里程表用：付费动作前后各读一次，差值就是这一次真实扣了多少。
 * 参数探测靠它自证"确实没扣费"，而不是嘴上保证。
 */
export async function relayUsage(): Promise<{ totalUsage: number | null; hardLimitUsd: number | null; accessUntil: number | null }> {
  const config = requireConnection('video');
  return await relayRequest(config, 'usage') as { totalUsage: number | null; hardLimitUsd: number | null; accessUntil: number | null };
}

/**
 * 参数探测：故意发一个上游必然拒绝的请求，从拒绝的原话里读出这一档的真实限制。
 *
 * 之所以敢发，是因为 prompt 传的是空串——没有提示词就没有可生成的内容，任何一家上游都会先拦下来，
 * 任务建不成也就没有计费。越界值（例如 seconds: 9999）只是搭车，用来换一句带范围的报错。
 * 绝不走 runRelayTask 的缓存：探测不是提交，不该在本机留下"这份内容提交过"的记录。
 *
 * ⚠️ 绝不能带参考素材。2026-09-10 手工试过一次：空 prompt 但带了 images，中转没有当场拒绝，
 * 而是把请求转发给了上游并一直挂着——因为"图生视频"本来就允许没有提示词，空 prompt 这道保险失效了。
 * 所以这里把所有素材字段硬删掉，宁可探不到参考图的规则，也不能让一次探测变成一次可能计费的提交。
 */
const PROBE_FORBIDDEN = ['images', 'input_reference', 'reference_images', 'reference_videos', 'reference_audios', 'first_frame', 'last_frame', 'video', 'image'];

export async function probeVideoParam(body: Record<string, unknown>): Promise<{ rejected: boolean; message: string; model: string }> {
  const config = requireConnection('video');
  const payload: Record<string, unknown> = { ...body, prompt: '', model: config.model };
  for (const key of PROBE_FORBIDDEN) delete payload[key];
  try {
    const result = await relayRequest(config, 'video', payload);
    // 没被拒是意外情况：如实说清，让人自己去日志确认，而不是假装无事发生。
    return { rejected: false, message: JSON.stringify(result).slice(0, 800), model: config.model };
  } catch (cause) {
    return { rejected: true, message: cause instanceof Error ? cause.message : String(cause), model: config.model };
  }
}

/** 找回这份内容上次提交的 task_id；没有就返回空，不会顺手提交一次。 */
export async function recoverRelayVideoTask(cacheKey: string): Promise<string | ''> {
  const cached = await completedRelayTask(cacheKey);
  return cached === undefined ? '' : taskIdFrom(cached);
}

/** 轮询任务状态。这一步不计费，可以放心重试。 */
export async function pollRelayVideo(taskId: string): Promise<VideoTaskState> {
  const config = requireConnection('video');
  const result = await relayRequest(config, 'video_task', { taskId }) as Record<string, unknown>;
  const nested = (result?.data ?? result?.task ?? {}) as Record<string, unknown>;
  const pick = (key: string) => result?.[key] ?? nested?.[key];
  const status = String(pick('status') ?? 'unknown').toLowerCase();
  const videoUrl = pick('video_url') ?? pick('videoUrl') ?? pick('url');
  const progress = pick('progress');
  const error = pick('error') ?? pick('message');
  return {
    status,
    progress: typeof progress === 'number' ? progress : undefined,
    videoUrl: typeof videoUrl === 'string' ? videoUrl : undefined,
    error: typeof error === 'string' ? error : undefined,
  };
}

/** 内容指纹：提示词、模型、分辨率或参考图任一变了就是另一个任务，不复用旧 task_id。 */
export async function videoCacheKey(projectId: string, runId: string, body: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const hex = [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `video:${projectId}:${runId}:${hex}`;
}
