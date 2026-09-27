import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const exec = promisify(execFile);
export const BLENDER_PACKAGE = Object.freeze({
  version: '4.5.3', folder: 'blender-4.5.3-windows-x64',
  url: 'https://download.blender.org/release/Blender4.5/blender-4.5.3-windows-x64.zip',
  sha256: '6b657c8bdd3a7b65b07b9e1ae17eb4be7dd4aa23121da7f3d3354fc2551330a7',
});
export async function testBlender(binary, directory, signal) {
  const { stdout } = await exec(binary, ['--version'], { windowsHide: true, timeout: 15000, signal });
  if (!/^Blender 4\.5\./m.test(stdout)) throw new Error('需要兼容的 Blender 4.5 版本；原有版本不会被替换。');
  await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, 'check.py'), output = path.join(directory, 'check.png');
  await fs.rm(output, { force: true });
  await fs.writeFile(script, `import bpy\nbpy.ops.wm.read_factory_settings(use_empty=False)\ns=bpy.context.scene\ns.render.engine='BLENDER_WORKBENCH'\ns.render.resolution_x=64\ns.render.resolution_y=64\ns.render.resolution_percentage=100\ns.render.image_settings.file_format='PNG'\ns.render.filepath=${JSON.stringify(output)}\nbpy.ops.render.render(write_still=True)\n`, 'utf8');
  await exec(binary, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script], { windowsHide: true, timeout: 90000, signal, maxBuffer: 4 * 1024 * 1024 });
  if ((await fs.stat(output)).size < 50) throw new Error('测试渲染未产出有效图片。');
}
async function extractZip(archive, directory, signal) {
  // Paths are arguments, never interpolated into PowerShell source.
  const script = path.join(path.dirname(archive), 'extract.ps1');
  await fs.writeFile(script, 'param([string]$Archive,[string]$Destination)\n$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force\n');
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, archive, directory], { windowsHide: true, timeout: 10 * 60 * 1000, signal });
}
export function createRenderRuntime({ directory, candidates = [], platform = process.platform, arch = process.arch, manifest = BLENDER_PACKAGE, fetchImpl, extract = extractZip, test = testBlender } = {}) {
  let binary, controller, active;
  let state = { ready: false, phase: 'missing', message: '尚未准备 Blender 渲染环境', received: 0, total: 0, version: manifest.version };
  const portable = path.join(directory, 'blender', manifest.folder, 'blender.exe');
  const change = (phase, message, extra = {}) => { state = { ...state, phase, message, ...extra }; };
  const check = async candidate => { await test(candidate, path.join(directory, 'check'), controller?.signal); binary = candidate; change('ready', '渲染环境已就绪', { ready: true }); };
  const detect = async () => {
    if (active) return;
    for (const candidate of [portable, ...candidates].filter(Boolean)) {
      try { await fs.access(candidate); change('checking', '正在测试 Blender', { ready: false }); await check(candidate); return; }
      catch { /* Unusable system installs are preserved; managed install is offered. */ }
    }
    change('missing', '未找到可用的 Blender 4.5，一键准备即可开始', { ready: false });
  };
  const install = async localArchive => {
    if (platform !== 'win32' || arch !== 'x64') throw new Error('自动准备目前支持 Windows x64。');
    if (new URL(manifest.url).origin !== 'https://download.blender.org' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('下载清单无效');
    await fs.mkdir(directory, { recursive: true });
    const free = await fs.statfs(directory);
    if (free.bavail * free.bsize < 3 * 1024 ** 3) throw new Error('磁盘空间不足，请至少保留 3GB 空间。');
    controller = new AbortController();
    const signal = controller.signal, archive = path.join(directory, 'blender-download.zip');
    const staging = await fs.mkdtemp(path.join(directory, 'unpack-'));
    try {
      change('downloading', '正在下载官方 Blender 便携版', { ready: false, received: 0, total: 0 });
      let digest;
      if (localArchive) {
        change('verifying', '正在校验离线 Blender 安装包');
        await fs.copyFile(localArchive, archive);
        const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) { signal.throwIfAborted(); hash.update(chunk); }
        digest = hash.digest('hex');
      } else if (!fetchImpl) {
        // Windows curl uses the user's network/proxy settings; SHA256 remains mandatory.
        change('downloading', state.message, { total: manifest.version === '4.5.3' ? 400100678 : 0 });
        const timer = setInterval(() => { void fs.stat(archive).then(stat => { if (state.phase === 'downloading') change('downloading', state.message, { received: stat.size }); }).catch(() => {}); }, 500);
        try {
          await exec('curl.exe', ['--fail', '--silent', '--show-error', '--proto', '=https', '--max-redirs', '0', '--connect-timeout', '30', '--max-time', '1800', '--retry', '2', '--output', archive, manifest.url], { windowsHide: true, signal, timeout: 32 * 60 * 1000 });
        } finally { clearInterval(timer); }
        const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) { signal.throwIfAborted(); hash.update(chunk); }
        digest = hash.digest('hex');
      } else {
      const response = await fetchImpl(manifest.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error(`下载失败（${response.status}），请检查网络后重试。`);
      const total = Number(response.headers.get('content-length') || 0);
      if (total > 1024 ** 3) throw new Error('下载文件大小异常');
      change('downloading', state.message, { total });
      const file = await fs.open(archive, 'w'), hash = createHash('sha256');
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          const bytes = Buffer.from(chunk); hash.update(bytes); await file.writeFile(bytes);
          change('downloading', state.message, { received: state.received + bytes.length });
          if (state.received > 1024 ** 3) throw new Error('下载文件大小异常');
        }
      } finally { await file.close(); }
      digest = hash.digest('hex');
      }
      signal.throwIfAborted(); change('verifying', '正在校验下载文件');
      if (digest !== manifest.sha256) throw new Error('下载文件校验失败，未执行或安装，请重试。');
      change('extracting', '正在解压，原有 Blender 不受影响');
      await extract(archive, staging, signal); signal.throwIfAborted();
      change('checking', '正在渲染测试画面');
      const candidate = path.join(staging, manifest.folder, 'blender.exe');
      await test(candidate, path.join(directory, 'check'), signal); signal.throwIfAborted();
      // Only replace our managed directory after validation, never a system install.
      const managed = path.join(directory, 'blender');
      await fs.rm(managed, { recursive: true, force: true });
      await fs.rename(staging, managed); binary = portable;
      change('ready', '渲染环境已就绪，可以返回镜感生成预演', { ready: true });
    } finally { await fs.rm(archive, { force: true }).catch(() => {}); await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  };
  return {
    status: () => ({ ...state }), blender: () => binary, detect,
    prepare(localArchive) {
      if (active) return Promise.reject(new Error('正在准备，请勿重复操作'));
      if (state.ready) return Promise.resolve();
      change('preparing', '正在检查空间和准备环境', { ready: false });
      active = install(localArchive).catch(error => { binary = undefined; change('error', controller?.signal.aborted ? '准备已取消，可以重新尝试' : String(error.message || error).slice(0, 400), { ready: false }); throw error; }).finally(() => { controller = null; active = null; });
      return active;
    },
    cancel() { controller?.abort(new Error('准备已取消')); },
  };
}
