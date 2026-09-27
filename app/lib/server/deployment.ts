import { isLoopback } from '../auth-protocol';

const releases = 'https://github.com/Teminuosi/JingGan/releases';
function downloadUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Invalid deployment configuration never becomes a browser link. */ }
  return null;
}
export function deploymentFeatures(request: Request) {
  const local = process.env.NODE_ENV !== 'production' && isLoopback(request.url);
  const light = downloadUrl(process.env.MIRROR_HELPER_DOWNLOAD_URL);
  const offline = downloadUrl(process.env.MIRROR_HELPER_OFFLINE_URL);
  return {
    pipelineEnabled: local || process.env.MIRROR_PIPELINE_ENABLED === 'true',
    helperDownloads: {
      light: light || (local ? '/downloads/mirror-render-helper-windows-x64.zip' : releases),
      offline: offline || (local ? '/downloads/mirror-render-helper-windows-x64-offline.zip' : releases),
      lightReady: Boolean(light || local), offlineReady: Boolean(offline || local),
    },
  };
}
