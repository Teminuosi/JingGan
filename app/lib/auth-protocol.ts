export interface AccountUser { id: string; email: string; name: string }
export interface AccountConfig { configured: boolean; blogUrl: string; referralUrl: string; localClaims: boolean }
export function registrationSource(value: unknown): string {
  const channel = typeof value === 'string' ? value.replace(/^jinggan_/, '') : '';
  return ['github', 'blog', 'bilibili', 'douyin'].includes(channel) ? `jinggan_${channel}` : 'jinggan';
}
export function isLoopback(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
