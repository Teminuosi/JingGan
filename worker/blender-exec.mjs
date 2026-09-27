// 跑 Blender 的进程包装。worker 与验证脚本共用同一份——
// 否则"验证脚本跑通了"证明不了 worker 里那段也通。
//
// 这台机器上 Blender 渲完之后**不会干净地退出**：实测两次，
// 一次退出时崩（Windows 0xC0000142），一次干脆挂住不退——
// 两次都是全部帧渲完、result.json 也写好了之后才出的问题。
// （小场景倒是能正常退出，所以不能靠"跑一次没事"就当它好了。）
//
// 所以不能傻等进程结束。做法是盯着脚本最后写的 result.json：
// 它一出现就说明活干完了，再给几秒钟让进程自己走，还不走就杀掉。
// 判定成败交给上层看 result.json，这里只负责别把调用方一直吊在这儿。

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 产出 result.json 后，留给进程自己退出的宽限时间。 */
export const GRACE_MS = 12000;
/** 盯 result.json 的轮询间隔。 */
export const POLL_MS = 2000;
/** 兜底上限：连 result.json 都没出现，说明是真卡死或真出错。 */
export const HARD_TIMEOUT_MS = 30 * 60 * 1000;

/** Windows 上 kill() 未必能带走子进程，用 taskkill /T 连整棵树一起收。 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* 进程可能已经自己没了，往下走常规 kill */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
}

export function makeBlenderExec({
  onWarn = (m) => console.warn(m),
  signal,
  // 时间参数可注入：测试才有办法在几秒内把「渲完却不退出」这条路逼出来，
  // 而不是靠去渲一个够大的场景碰运气。
  graceMs = GRACE_MS,
  pollMs = POLL_MS,
  hardTimeoutMs = HARD_TIMEOUT_MS,
} = {}) {
  return (cmd, args, cwd) => new Promise((resolve) => {
    if (signal?.aborted) { resolve({ code: 1, stdout: '', stderr: '渲染已取消' }); return; }
    const donePath = path.join(cwd, 'result.json');
    const startedAt = Date.now();
    let settled = false;
    let watcher = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (watcher) clearInterval(watcher);
      signal?.removeEventListener('abort', abort);
      resolve(payload);
    };

    const child = execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        finish({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    const abort = () => {
      killTree(child);
      finish({ code: 1, stdout: '', stderr: '渲染已取消' });
    };
    signal?.addEventListener('abort', abort, { once: true });

    let graceDeadline = 0;
    watcher = setInterval(() => {
      if (settled) return;

      if (!graceDeadline) {
        if (fs.existsSync(donePath)) {
          graceDeadline = Date.now() + graceMs;
        } else if (Date.now() - startedAt > hardTimeoutMs) {
          onWarn('Blender 超时且没有产出 result.json，判定为渲染失败');
          killTree(child);
          finish({
            code: 1,
            stdout: '',
            stderr: `Blender 超过 ${Math.round(hardTimeoutMs / 60000)} 分钟仍未产出 result.json`,
          });
        }
        return;
      }

      if (Date.now() < graceDeadline) return;
      onWarn('Blender 已产出 result.json 但迟迟不退出，主动结束它');
      killTree(child);
      finish({ code: 0, stdout: 'BLENDER_DONE (result.json 已就绪，进程被主动结束)', stderr: '' });
    }, pollMs);
  });
}

/**
 * 按生产配置拼一个 SubprocessBlenderRunner。
 *
 * 抽出来是因为这套参数已经漏过两次，而且两次都是渲染全部跑完之后才炸：
 *  - workDir 不在 objectRoot 底下 → 参考视频永远找不到，管线还照样全绿；
 *  - 漏传 encodeFrames → 帧全渲完才报 `encodeFrames is not a function`。
 *
 * worker 和验证脚本共用这一个工厂，验证脚本跑通才真的等于 worker 跑通。
 * 少传一项这里就报错，而不是等渲完十分钟再说。
 */
export function createBlenderRunner(SubprocessBlenderRunner, {
  blenderPath, objectRoot, ffmpeg, fs, path, onWarn = (m) => console.warn(m),
}) {
  for (const [name, v] of Object.entries({ blenderPath, objectRoot, ffmpeg, fs, path })) {
    if (!v) throw new Error(`createBlenderRunner 缺少 ${name}`);
  }
  if (typeof ffmpeg.encodeFrames !== 'function') {
    throw new Error('ffmpeg 没有 encodeFrames：Blender 渲的是 PNG 序列，编码这一步少不了');
  }

  return new SubprocessBlenderRunner({
    blenderPath,
    // 必须落在 objectRoot 底下：产物 key 是 blender/<shotId>/xxx，
    // 出片时 ffmpeg.cut 和 previsVideoFor 都按 objectRoot + key 找文件。
    workDir: path.join(objectRoot, 'blender'),
    exec: makeBlenderExec({ onWarn }),
    onWarn,
    writeFile: async (p, content) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    },
    readOutput: async (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({
        name: e.name,
        // 只把 result.json 的内容读进来。目录里还躺着上千张 PNG，
        // 全读一遍就是几百 MB 进内存——而调用方只需要文件名和那份清单。
        bytes: e.name === 'result.json' ? fs.readFileSync(path.join(dir, e.name)) : Buffer.alloc(0),
      })),
    // Blender 5.x 渲的是 PNG 序列（原生导视频那条路没了），编码交给 ffmpeg。
    encodeFrames: (framesDir, fps, out) => ffmpeg.encodeFrames(framesDir, fps, out),
  });
}
