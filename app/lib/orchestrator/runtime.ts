// Worker 运行时。
//
// 规格第二、二十章：worker 要能长跑、能心跳、能崩溃恢复、能优雅退出。
// 这里只管「怎么跑一个任务」的通用部分——认领、心跳、成功、失败分类、退出，
// 具体干什么由注册进来的 handler 决定。
//
// 刻意不依赖 Node API：它跑在 Node 侧，但 runOnce 是纯逻辑，测试里直接用 D1 stub 驱动。
//
// 心跳是这层最容易被忽略却最要紧的东西：视频生成实测要 6 分钟以上，
// 没有心跳的话租约一到期，回收器会把一个正在跑的任务放回队列，
// 于是同一个镜头被生成两次——钱花两遍，成片还可能拿错那一份。

import type { TaskQueue, TaskRow } from '../task/queue';
import { type FailureClass, type TaskType } from '../task/states';

export interface HandlerContext {
  task: TaskRow;
  /** 长任务在等待期间必须定期调用它续租。 */
  heartbeat: () => Promise<void>;
  /** 收到停止信号后为 true，handler 应尽快收尾。 */
  shouldStop: () => boolean;
  log: (message: string) => void;
}

export interface TaskHandler {
  type: TaskType;
  /** 返回值写进 tasks.output_json，供下游任务读取。 */
  run(ctx: HandlerContext): Promise<unknown>;
}

/** handler 抛这个错就能指定失败分类；抛普通 Error 一律按 internal 处理。 */
export class TaskFailure extends Error {
  constructor(message: string, readonly failureClass: FailureClass = 'internal') {
    super(message);
    this.name = 'TaskFailure';
  }
}

/**
 * 同 isProviderError：不用 instanceof。
 * handler 往往来自别的模块甚至别的包，跨 bundle 时同一个类是两个构造函数，
 * instanceof 会判成 false，于是 handler 精心标注的失败分类被丢掉、
 * 一个「参数不合法」被当成 internal 反复重试——每次重试都是钱。
 */
export function isTaskFailure(err: unknown): err is TaskFailure {
  return Boolean(err) && typeof err === 'object'
    && (err as Error).name === 'TaskFailure'
    && typeof (err as TaskFailure).failureClass === 'string';
}

/** 循环里除了跑任务还要做的巡检。督导就挂在这儿。 */
export interface ReconcileStep {
  name: string;
  run(): Promise<void>;
}

export interface RuntimeOptions {
  workerId: string;
  /** 只处理这些类型。分进程部署时用：Blender worker 只认 blender。 */
  types?: TaskType[];
  /** 心跳间隔。必须明显小于租约时长，否则续租赶不上过期。 */
  heartbeatMs?: number;
  leaseMs?: number;
  /** 队列空时轮询间隔。 */
  idleMs?: number;
  onLog?: (line: string) => void;
}

export interface RunResult {
  status: 'idle' | 'succeeded' | 'failed';
  task?: TaskRow;
  error?: string;
  failureClass?: FailureClass;
}

export class WorkerRuntime {
  private readonly handlers = new Map<TaskType, TaskHandler>();
  private stopping = false;

  constructor(private readonly queue: TaskQueue, private readonly opts: RuntimeOptions) {}

  private readonly reconcilers: ReconcileStep[] = [];

  register(handler: TaskHandler): this {
    this.handlers.set(handler.type, handler);
    return this;
  }

  /**
   * 挂一个巡检步骤。每轮循环跑一次，和租约回收同级。
   * 巡检抛错不许拖垮循环——它是辅助，不是主线。
   */
  reconcile(step: ReconcileStep): this {
    this.reconcilers.push(step);
    return this;
  }

  /** 只认领自己有 handler 的类型，避免把别的 worker 的活抢走再原样失败。 */
  private claimableTypes(): TaskType[] {
    const registered = [...this.handlers.keys()];
    return this.opts.types?.length ? registered.filter((t) => this.opts.types!.includes(t)) : registered;
  }

  stop(): void { this.stopping = true; }

  /**
   * 跑一个任务。没有可跑的就返回 idle。
   *
   * 心跳用定时器在后台跑，而不是要求 handler 自己记得调用——
   * 「忘了心跳」这种错误的代价是重复扣费，不能靠自觉。
   */
  async runOnce(): Promise<RunResult> {
    const types = this.claimableTypes();
    if (!types.length) return { status: 'idle' };

    const task = await this.queue.claim(this.opts.workerId, types, this.opts.leaseMs);
    if (!task) return { status: 'idle' };

    const handler = this.handlers.get(task.type);
    if (!handler) {
      // 认领了却没 handler：理论上不会发生（claimableTypes 已过滤），
      // 真发生了也不能把任务扣在手里，立刻放回队列。
      await this.queue.fail(task.id, `worker ${this.opts.workerId} 没有 ${task.type} 的处理器`, 'internal');
      return { status: 'failed', task, error: 'no handler' };
    }

    await this.queue.start(task.id);
    const beat = async () => { await this.queue.heartbeat(task.id, this.opts.workerId, this.opts.leaseMs); };
    const timer = setInterval(() => { void beat(); }, this.opts.heartbeatMs ?? 30_000);

    try {
      const output = await handler.run({
        task,
        heartbeat: beat,
        shouldStop: () => this.stopping,
        log: (m) => this.opts.onLog?.(`[${task.type} ${task.id.slice(0, 8)}] ${m}`),
      });
      await this.queue.succeed(task.id, output);
      return { status: 'succeeded', task };
    } catch (cause) {
      const cls: FailureClass = isTaskFailure(cause) ? cause.failureClass : 'internal';
      const message = cause instanceof Error ? cause.message : String(cause);
      await this.queue.fail(task.id, message, cls);
      // 上游失败会让下游永远等不到，顺手把孤儿收掉，否则用户看到的是「卡住」而不是「失败」
      if (task.project_id) await this.queue.cancelOrphans(task.project_id);
      return { status: 'failed', task, error: message, failureClass: cls };
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * 长跑循环。收到 stop 后跑完手上这个就退出，不中断正在进行的生成——
   * 中断一个已经提交给上游的视频任务，钱照扣，片子拿不到。
   */
  async loop(sleep: (ms: number) => Promise<void>): Promise<void> {
    while (!this.stopping) {
      // 回收租约过期的任务。放在循环里而不是单独起个进程：
      // 只要还有 worker 活着，回收就一定在跑。
      await this.queue.reclaimExpired();
      for (const step of this.reconcilers) {
        try {
          await step.run();
        } catch (err) {
          // 巡检失败不能让 worker 停下来。重试督导挂了最坏是没人自动重试，
          // 但正在跑的任务还得跑完——它们已经花了钱。
          this.opts.onLog?.(`[巡检 ${step.name}] 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const result = await this.runOnce();
      if (this.stopping) break;
      if (result.status === 'idle') await sleep(this.opts.idleMs ?? 2_000);
    }
  }
}
