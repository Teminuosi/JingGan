export interface AccountUser { id: string; email: string; name: string }
// Set only when this app rejected a request before forwarding it to the model.
export const SUBMISSION_HEADER = 'X-Mirror-Submission';
export function notSubmittedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(SUBMISSION_HEADER, 'not-submitted');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export interface AccountConfig { configured: boolean; blogUrl: string; referralUrl: string; localClaims: boolean; pipelineEnabled?: boolean; helperDownloads?: { light: string; offline: string; lightReady: boolean; offlineReady: boolean } }
export function registrationSource(value: unknown): string {
  const channel = typeof value === 'string' ? value.replace(/^jinggan_/, '') : '';
  return ['github', 'blog', 'bilibili', 'douyin'].includes(channel) ? `jinggan_${channel}` : 'jinggan';
}
export function isLoopback(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}
