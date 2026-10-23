// 参考视频的临时公网链接（seedance-2.5 的 videos[].url）。
//
// 上游是在它自己的服务器上去抓参考素材的，所以本段 3D 预演必须放到一个公网 https 地址上，
// 而且这个地址不能要求登录头。做法：登录用户把 mp4 传进 R2，拿回一个带过期时间和 HMAC 签名的 GET 链接；
// 读的时候只认签名，不认登录。
//
// 为了不变成一个开放的文件托管：只收登录用户上传、只收 mp4/webm（内容头也要对得上）、单个上限 30MB、
// 链接 6 小时后失效（R2 元数据里也记着过期时间，签名再对也不给）。
// 清理：对象不会自动删除。建议在 R2 后台给 jinggan-images 加一条生命周期规则：
// 前缀 reference-media/ 的对象 1 天后删除（本代码不依赖它，只是控制存储量）。
//
// 本文件不引用 cloudflare:workers，路由层把 R2 和登录校验注进来，方便在 node 里直接测。

export const REFERENCE_MEDIA_PREFIX = 'reference-media/';
export const MAX_REFERENCE_VIDEO_BYTES = 30 * 1024 * 1024;
export const REFERENCE_MEDIA_TTL_SECONDS = 6 * 60 * 60;
const TYPES: Record<string, 'mp4' | 'webm'> = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/;

export interface ReferenceMediaBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null; size: number; httpEtag?: string; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } } | null>;
}

export interface ReferenceMediaDeps {
  requireOwner(request: Request): Promise<string>;
  bucket(): ReferenceMediaBucket;
  /** 签名密钥；没配时抛 'media_signing_not_configured'。 */
  secret(): string;
  now?: () => number;
  randomId?: () => string;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const signedText = (id: string, exp: number) => `reference-media:v1:${id}:${exp}`;

export async function signReferenceMedia(secret: string, id: string, exp: number): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(signedText(id, exp)));
  return base64url(new Uint8Array(signature));
}

/** 校验签名与有效期。crypto.subtle.verify 本身是常数时间比较。 */
export async function verifyReferenceMedia(secret: string, id: string, exp: string | null, sig: string | null, nowMs: number): Promise<boolean> {
  if (!ID_PATTERN.test(id) || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  const expires = Number(exp);
  if (expires * 1000 <= nowMs) return false;
  const bytes = fromBase64url(sig);
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, new TextEncoder().encode(signedText(id, expires)));
}

function hasVideoSignature(ext: 'mp4' | 'webm', bytes: Uint8Array): boolean {
  if (ext === 'mp4') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** POST：登录用户上传一段参考视频，返回带签名的临时公网链接。 */
export async function handleReferenceUpload(request: Request, deps: ReferenceMediaDeps): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: '请求来源无效。' }, 403);
  const ownerId = await deps.requireOwner(request);
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[type];
  if (!ext) return json({ error: '参考视频只收 mp4 或 webm。' }, 415);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_REFERENCE_VIDEO_BYTES) return json({ error: '参考视频超过 30MB，请缩短片段后再试。' }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_REFERENCE_VIDEO_BYTES) return json({ error: '参考视频超过 30MB，请缩短片段后再试。' }, 413);
  if (bytes.length === 0 || !hasVideoSignature(ext, bytes)) return json({ error: '文件内容不是有效的视频。' }, 400);
  const secret = deps.secret();
  const now = (deps.now ?? Date.now)();
  const exp = Math.floor(now / 1000) + REFERENCE_MEDIA_TTL_SECONDS;
  const id = `${(deps.randomId ?? (() => crypto.randomUUID()))()}.${ext}`;
  await deps.bucket().put(`${REFERENCE_MEDIA_PREFIX}${id}`, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { owner: ownerId, expiresAt: String(exp) },
  });
  const sig = await signReferenceMedia(secret, id, exp);
  const url = `${new URL(request.url).origin}/api/reference-media/${id}?exp=${exp}&sig=${sig}`;
  return json({ url, expiresAt: exp * 1000, bytes: bytes.length });
}

/** GET：不认登录，只认签名与有效期（上游抓取时不会带我们的登录头）。 */
export async function handleReferenceDownload(request: Request, id: string, deps: Pick<ReferenceMediaDeps, 'bucket' | 'secret' | 'now'>): Promise<Response> {
  const url = new URL(request.url);
  const now = (deps.now ?? Date.now)();
  if (!await verifyReferenceMedia(deps.secret(), id, url.searchParams.get('exp'), url.searchParams.get('sig'), now)) {
    return json({ error: '链接无效或已过期。' }, 403);
  }
  const object = await deps.bucket().get(`${REFERENCE_MEDIA_PREFIX}${id}`);
  const stored = Number(object?.customMetadata?.expiresAt ?? '0');
  if (!object?.body || stored * 1000 <= now) return json({ error: '链接无效或已过期。' }, 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': id.endsWith('.webm') ? 'video/webm' : 'video/mp4',
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  });
}

/** 签名密钥：生产必须配 MIRROR_MEDIA_SIGNING_SECRET（wrangler secret）；本机开发没配时用进程内随机密钥。 */
let devSecret = '';
export function referenceMediaSecret(env: Record<string, string | undefined>, isLocalDev: boolean): string {
  const configured = env.MIRROR_MEDIA_SIGNING_SECRET ?? '';
  if (configured.length >= 32) return configured;
  if (!isLocalDev) throw new Error('media_signing_not_configured');
  if (!devSecret) devSecret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return devSecret;
}
