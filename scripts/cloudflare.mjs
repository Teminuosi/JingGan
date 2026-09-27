import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const command = process.argv[2];
if (!['build', 'check', 'deploy'].includes(command)) throw new Error('Usage: node scripts/cloudflare.mjs build|check|deploy');
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, MIRROR_DEPLOY_TARGET: 'cloudflare' }, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Command failed (${code})`)));
});
const publicDir = path.join(root, '.worker/cloudflare-public');
await fs.mkdir(publicDir, { recursive: true });
// This deployment contains only the public assets used by the application.
// Installer ZIPs and local character experiments are not website assets.
for (const name of ['og.png', 'Gemini网页-视频DNA分析提示词.txt']) await fs.copyFile(path.join(root, 'public', name), path.join(publicDir, name));
if (command === 'build') {
  await run(path.join(root, 'node_modules/vinext/dist/cli.js'), ['build']);
} else {
  const config = path.join(root, 'dist/server/wrangler.json');
  const built = JSON.parse(await fs.readFile(config, 'utf8'));
  if (built.name !== 'jinggan' || built.vars?.MIRROR_LOCAL_CLAIMS !== 'false') throw new Error('请先执行 npm run build:cloudflare，不能部署本地开发构建。');
  if (command === 'deploy' && built.d1_databases?.some(db => db.database_id === '00000000-0000-4000-8000-000000000000')) throw new Error('尚未配置真实 Cloudflare D1 数据库，未开始部署。');
  await run(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ['deploy', '--config', config, ...(command === 'check' ? ['--dry-run', '--outdir', '.worker/cloudflare-dry-run'] : [])]);
}
