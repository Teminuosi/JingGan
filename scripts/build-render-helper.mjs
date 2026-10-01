import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { testBlender } from '../worker/previs/runtime.mjs';

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 打包。');
const full = process.argv.includes('--offline');
const online = process.argv.includes('--online');
if (full && online) throw new Error('Choose online or offline package');
const name = `mirror-render-helper-windows-x64${full ? '-offline' : online ? '-online' : ''}`;
const output = path.join(root, '.release', `${name}-${Date.now()}`);
await fs.mkdir(path.join(output, 'runtime'), { recursive: true });
const ffmpeg = online ? null : process.env.FFMPEG_PATH || (await exec('where.exe', ['ffmpeg.exe'])).stdout.trim().split(/\r?\n/)[0];
const ffprobe = online ? null : process.env.FFPROBE_PATH || (await exec('where.exe', ['ffprobe.exe'])).stdout.trim().split(/\r?\n/)[0];
for (const [file, target] of [[process.execPath, 'node.exe'], ...(!online ? [[ffmpeg, 'ffmpeg.exe'], [ffprobe, 'ffprobe.exe']] : [])]) {
  await exec(file, [target === 'node.exe' ? '--version' : '-version'], { windowsHide: true, timeout: 15000 });
  await fs.copyFile(file, path.join(output, 'runtime', target));
}
await build({ entryPoints: [path.join(root, 'scripts/render-helper-entry.mjs')], outfile: path.join(output, 'helper.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
await fs.copyFile(path.join(root, 'worker/previs/render.py'), path.join(output, 'render.py'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
await fs.mkdir(path.join(output, 'licenses'));
for (const [url, name] of [[`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, 'Node-LICENSE.txt']]) {
  await exec('curl.exe', ['--fail', '--silent', '--show-error', '--proto', '=https', '--retry', '2', '--max-time', '60', '--output', path.join(output, 'licenses', name), url], { windowsHide: true, timeout: 180000 });
}
await fs.copyFile(path.join(root, 'docs/runtime-distribution.md'), path.join(output, 'licenses/runtime-distribution.md'));
if (!online) {
const ffmpegInfo = (await exec(ffmpeg, ['-version'])).stdout;
if (ffmpegInfo.includes('--enable-nonfree')) throw new Error('拒绝打包含 --enable-nonfree 的 FFmpeg。');
const ffmpegNotices = process.env.FFMPEG_NOTICES_DIR || path.resolve(path.dirname(ffmpeg), '..');
const providerReadme = await fs.readFile(path.join(ffmpegNotices, 'README.txt'), 'utf8');
const ffmpegVersion = /^ffmpeg version (\S+)/m.exec(ffmpegInfo)?.[1];
if (!ffmpegVersion || !providerReadme.includes(`Version: ${ffmpegVersion}`) || !providerReadme.includes('License: GPL v3')) throw new Error('需提供与实际 FFmpeg 版本一致的 Gyan GPLv3 README 与 LICENSE；可设置 FFMPEG_NOTICES_DIR。');
await fs.copyFile(path.join(ffmpegNotices, 'README.txt'), path.join(output, 'licenses/FFmpeg-provider-README.txt'));
await fs.copyFile(path.join(ffmpegNotices, 'LICENSE'), path.join(output, 'licenses/FFmpeg-GPLv3.txt'));
await fs.copyFile(path.join(root, 'docs/runtime-distribution.md'), path.join(output, 'licenses/runtime-distribution.md'));
await fs.writeFile(path.join(output, 'licenses/runtime-builds.txt'), `Node ${process.versions.node}\nhttps://nodejs.org/\n${ffmpegInfo}\nFFmpeg build provider: https://www.gyan.dev/ffmpeg/builds/\nFFmpeg source: https://github.com/FFmpeg/FFmpeg\nBefore public distribution, verify corresponding source and build-dependency license obligations for these exact binaries.\n`);
}
if (full) {
  const blender = process.env.BLENDER_PATH;
  if (!blender) throw new Error('离线包需显式设置已验证的 BLENDER_PATH（4.5 系列）。');
  await testBlender(blender, path.join(output, '.check'));
  await fs.cp(path.dirname(blender), path.join(output, 'blender'), { recursive: true });
  await fs.rm(path.join(output, '.check'), { recursive: true, force: true });
}
await fs.writeFile(path.join(output, '启动镜感助手.bat'), (await fs.readFile(path.join(root, 'scripts/render-helper-launch.cmd'), 'utf8')).replace(/\r?\n/g, '\r\n'));
await fs.writeFile(path.join(output, '使用说明.txt'), '\ufeff镜感渲染助手（Windows x64）\r\n解压到可写文件夹，双击“启动镜感助手.bat”。\r\n首次点击“一键准备 Blender”，等待下载、校验和测试完成。\r\n云端镜感网址需在助手设置页面明确批准；浏览器可能要求允许本地网络访问。\r\n返回镜感点击“检查助手”，即可生成预演。无须安装 Node、FFmpeg 或设置环境变量。\r\n作品与下载环境保存在 %LOCALAPPDATA%\\MirrorRenderHelper。\r\n本包为本地验收构建；公开分发前须核对内附运行库的对应源码和许可证说明。\r\n');
const hashes = {};
for (const file of ['helper.mjs', 'runtime/node.exe', ...(!online ? ['runtime/ffmpeg.exe', 'runtime/ffprobe.exe'] : [])]) hashes[file] = createHash('sha256').update(await fs.readFile(path.join(output, file))).digest('hex');
if (online) await fs.writeFile(path.join(output, '使用说明.txt'), '\ufeff镜感渲染助手（Windows x64）\r\n解压到可写文件夹，双击“启动镜感助手.bat”。首次启动自动下载并校验 FFmpeg（约 99MB），请保持窗口开启。\r\n助手设置中点击“一键准备 Blender”（约 400MB），授权镜感网址，返回网页点击“检查助手”。\r\n需联网，磁盘至少 3GB。无需手动安装 Node、FFmpeg。\r\n本包仅含镜感助手和 Node；FFmpeg、Blender 从原提供方下载到本机，不在包内分发。下载失败可再次启动，不会提交模型生成。\r\n数据目录：%LOCALAPPDATA%\\MirrorRenderHelper。\r\n');
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: online ? '1.0.3' : '1.0.0', platform: 'windows-x64', online, offline: full, createdAt: new Date().toISOString(), files: hashes }, null, 2));
await fs.mkdir(path.join(root, 'public/downloads'), { recursive: true });
const archive = path.join(root, 'public/downloads', `${name}.zip`);
const ps = path.join(output, 'archive.ps1');
await fs.writeFile(ps, 'param([string]$Source,[string]$Archive)\n$ErrorActionPreference="Stop"\nCompress-Archive -LiteralPath $Source -DestinationPath $Archive -Force\n');
await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', ps, output, archive], { windowsHide: true, timeout: 10 * 60 * 1000 });
await fs.rm(ps, { force: true });
console.log(JSON.stringify({ directory: output, archive, bytes: (await fs.stat(archive)).size }));
