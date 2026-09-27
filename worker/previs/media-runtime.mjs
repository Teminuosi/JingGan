import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const MEDIA_PACKAGE = Object.freeze({
  version: '2025-07-31-git-119d127d05',
  folder: 'ffmpeg-2025-07-31-git-119d127d05-essentials_build',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/2025-07-31-git-119d127d05/ffmpeg-2025-07-31-git-119d127d05-essentials_build.zip',
  sha256: 'd67dc21511ce391b35ed11eaf7de4b9b152cce5514d05167d28b821c12bd6b29',
});
const downloadArchive = async (url, file) => {
  console.log('Preparing media tools: downloading verified FFmpeg (about 99 MB). Please keep this window open.');
  await exec('curl.exe', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '30', '--max-time', '1800', '--retry', '2', '--output', file, url], { windowsHide: true, timeout: 32 * 60 * 1000 });
};
const extractArchive = async (archive, target) => {
  await exec('tar.exe', ['-xf', archive, '-C', target], { windowsHide: true, timeout: 10 * 60 * 1000 });
};
const testBinary = async binary => {
  const { stdout } = await exec(binary, ['-version'], { windowsHide: true, timeout: 15000 });
  if (!stdout.includes(MEDIA_PACKAGE.version)) throw new Error('Unexpected FFmpeg version');
};
export async function ensureMediaRuntime({ directory, manifest = MEDIA_PACKAGE, download = downloadArchive, extract = extractArchive, test = testBinary }) {
  directory = path.resolve(directory);
  const url = new URL(manifest.url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/GyanD/codexffmpeg/releases/download/') || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[A-Za-z0-9._-]+$/.test(manifest.folder)) throw new Error('Invalid media download manifest');
  const target = path.join(directory, manifest.folder);
  if (!path.resolve(target).startsWith(directory + path.sep)) throw new Error('Media target outside managed directory');
  const binaries = { ffmpeg: path.join(target, 'bin', 'ffmpeg.exe'), ffprobe: path.join(target, 'bin', 'ffprobe.exe') };
  try {
    if ((await fs.readFile(path.join(target, '.verified'), 'utf8')) === manifest.sha256) {
      await test(binaries.ffmpeg); await test(binaries.ffprobe); return binaries;
    }
  } catch { /* First launch or interrupted setup. */ }
  await fs.mkdir(directory, { recursive: true });
  const staging = await fs.mkdtemp(path.join(directory, 'prepare-'));
  const archive = path.join(staging, 'media.zip');
  try {
    await download(manifest.url, archive);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== manifest.sha256) throw new Error('FFmpeg checksum mismatch; nothing installed');
    await extract(archive, staging);
    const unpacked = path.join(staging, manifest.folder);
    await test(path.join(unpacked, 'bin', 'ffmpeg.exe')); await test(path.join(unpacked, 'bin', 'ffprobe.exe'));
    await fs.writeFile(path.join(unpacked, '.verified'), manifest.sha256);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(unpacked, target);
    console.log('Media tools ready.');
    return binaries;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
