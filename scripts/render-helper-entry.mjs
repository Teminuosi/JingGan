import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPrevisServer, findBlender } from '../worker/previs/server.mjs';
import { createRenderRuntime } from '../worker/previs/runtime.mjs';

const packageRoot = process.env.MIRROR_HELPER_ROOT || import.meta.dirname;
const dataRoot = path.join(process.env.LOCALAPPDATA || packageRoot, 'MirrorRenderHelper');
process.env.FFMPEG_PATH = path.join(packageRoot, 'runtime', 'ffmpeg.exe');
process.env.FFPROBE_PATH = path.join(packageRoot, 'runtime', 'ffprobe.exe');
await fs.mkdir(dataRoot, { recursive: true });
for (const binary of [process.env.FFMPEG_PATH, process.env.FFPROBE_PATH]) await promisify(execFile)(binary, ['-version'], { windowsHide: true, timeout: 15000 });
const runtime = createRenderRuntime({ directory: path.join(dataRoot, 'runtime'), candidates: [path.join(packageRoot, 'blender', 'blender.exe'), await findBlender()] });
const server = await createPrevisServer({ directory: path.join(dataRoot, 'jobs'), runtime });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '助手已启动，请打开 http://127.0.0.1:43128/setup；如为旧服务，请先退出旧服务。' : error.message); process.exitCode = 1; });
server.listen(Number(process.env.PREVIS_PORT || 43128), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { runtime.cancel(); server.close(); server.closeAllConnections(); });
