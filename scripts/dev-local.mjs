import { spawn } from 'node:child_process';

const processes = [
  spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'dev'], { stdio: 'inherit', windowsHide: true }),
];

const previsRunning = await fetch('http://127.0.0.1:43128/health', { signal: AbortSignal.timeout(1500) })
  .then(response => response.json()).then(value => value.version === 'automatic-previs.v2').catch(() => false);
if (!previsRunning) processes.push(spawn(process.execPath, ['worker/previs/server.mjs'], { stdio: 'inherit', windowsHide: true }));
else console.log('[dev] 已连接正在运行的本地预演服务');

function stop() {
  for (const child of processes) child.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of processes) {
  child.on('error', (error) => { console.error(error.message); stop(); process.exitCode = 1; });
  child.on('exit', (code) => { if (code && code !== 0) { stop(); process.exitCode = code; } });
}
