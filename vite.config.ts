import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import publicHostingConfig from './hosting.config.json';

const cloudDeployment = process.env.MIRROR_DEPLOY_TARGET === 'cloudflare';
const hostingConfig = !cloudDeployment && existsSync('.openai/hosting.json')
  ? JSON.parse(readFileSync('.openai/hosting.json', 'utf8'))
  : publicHostingConfig;

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

// 生产配置叫 wrangler.cloudflare.jsonc，不是 wrangler.jsonc：@cloudflare/vite-plugin 1.37 会
// 自动发现根目录的 wrangler.json(c) 并与这里的内联 config 合并，哪怕已经显式传了 config。
// 合并的后果是本地 dev 直接起不来——两边都写 nodejs_compat 会让 workerd 报
// 「Compatibility flag specified multiple times」，生产的 compatibility_date 又比本机
// workerd 支持的日期新。换个名字，自动发现就找不到它，dev 与生产彻底分开。
const CLOUDFLARE_CONFIG_PATH = 'wrangler.cloudflare.jsonc';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async ({ mode, command }) => {
  const localEnv = loadEnv(mode, process.cwd(), '');
  const authVariables = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'MIRROR_AUTH_ENABLED', 'MIRROR_BLOG_URL', 'MIRROR_LOCAL_CLAIMS', 'MIRROR_RELAY_REFERRAL_URL'].map(name => [name, process.env[name] ?? localEnv[name] ?? '']));
  const proxyUrl = process.env.MIRROR_DEV_AUTH_PROXY ?? localEnv.MIRROR_DEV_AUTH_PROXY;
  const transportPlugins = [];
  if (!cloudDeployment && command === 'serve' && mode === 'development' && proxyUrl) {
    const { createAuthTransport } = await import('./scripts/dev-auth-transport.mjs');
    const transport = createAuthTransport({ upstreamOrigin: authVariables.SUPABASE_URL, proxyUrl });
    // A separate loopback listener also works when Vite's page port is changed.
    const server = createServer((req, res) => { void transport.middleware(req, res, () => { res.writeHead(404); res.end(); }); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动本地账号连接');
    authVariables.MIRROR_LOCAL_AUTH_TRANSPORT = `http://127.0.0.1:${address.port}/__mirror_auth_transport`;
    authVariables.MIRROR_LOCAL_AUTH_TOKEN = transport.token;
    transportPlugins.push({
      name: 'mirror-local-auth-transport',
      configureServer(viteServer: import('vite').ViteDevServer) {
        viteServer.httpServer?.once('close', () => {
          server.closeAllConnections();
          server.close();
          void transport.close();
        });
      },
    });
  }
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    ...(cloudDeployment ? { publicDir: '.worker/cloudflare-public' } : {}),
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      ...transportPlugins,
      vinext(),
      ...(!cloudDeployment && hostingConfig.project_id ? [sites()] : []),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        ...(cloudDeployment
          ? { configPath: CLOUDFLARE_CONFIG_PATH }
          : { config: { ...localBindingConfig, vars: authVariables } }),
      }),
    ],
  };
});
