// 转发下载生成视频时的把关（纯函数）：只许 https 公网地址、只许视频类型、限大小。
// 镜感服务器只转发、不落盘；这些规则保证它不会变成能随便拉任意内容的开放代理。

/** 单段视频上限。生成段一般几 MB 到几十 MB，留足余量。 */
export const MAX_SEGMENT_BYTES = 512 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

function ipv4Parts(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every(value => value <= 255) ? numbers : null;
}

/** 环回、私网、链路本地、运营商 NAT、保留与组播地址。 */
export function isPrivateIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function isBlockedIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (value === '::' || value === '::1') return true;
  // IPv4 映射/兼容地址：按里面的 IPv4 判断（URL 解析会写成 ::ffff:7f00:1 这种十六进制形式）。
  const mapped = value.match(/^::(?:ffff:)?(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) { const parts = ipv4Parts(mapped[1]); return !parts || isPrivateIpv4(parts); }
    const high = parseInt(mapped[2], 16);
    const low = parseInt(mapped[3], 16);
    return isPrivateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  const first = parseInt(value.split(':')[0] || '0', 16);
  // fc00::/7 唯一本地、fe80::/10 链路本地、ff00::/8 组播、64:ff9b::/96 转换前缀一律不放。
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || value.startsWith('64:ff9b:');
}

/**
 * 检查要转发下载的地址。通过返回规范化后的 URL，不通过抛出给人看的中文原因。
 * 只看字面：域名解析到内网（DNS 重绑定）这里拦不住；Cloudflare Workers 本身连不到内网，本机开发时请注意。
 */
export function checkDownloadUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) throw new Error('视频地址无效。');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('视频地址无效。'); }
  if (url.protocol !== 'https:') throw new Error('只转发 https 视频地址。');
  if (url.username || url.password) throw new Error('视频地址不能带账号密码。');
  if (url.port && url.port !== '443') throw new Error('只转发标准 https 端口的视频地址。');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('视频地址无效。');
  if (host.startsWith('[')) { if (isBlockedIpv6(host)) throw new Error('不转发内网或本机地址。'); return url; }
  const v4 = ipv4Parts(host);
  if (v4) { if (isPrivateIpv4(v4)) throw new Error('不转发内网或本机地址。'); return url; }
  if (!host.includes('.') || host === 'localhost' || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) throw new Error('不转发内网或本机地址。');
  return url;
}

/** 只放行视频类型。中转常见的 application/octet-stream 也不放：宁可让用户手动下载后从本机文件补上。 */
export function isVideoContentType(value: string | null): boolean {
  const type = (value ?? '').split(';')[0].trim().toLowerCase();
  return /^video\/[a-z0-9.+-]+$/.test(type);
}

/** Content-Length 超限或格式不对返回原因；没给长度时放行（由流式转发边传边计）。 */
export function checkContentLength(value: string | null): string | null {
  if (value === null || value === '') return null;
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '视频大小无效。';
  return size > MAX_SEGMENT_BYTES ? `视频超过 ${Math.round(MAX_SEGMENT_BYTES / 1024 / 1024)} MB，不转发。` : null;
}
