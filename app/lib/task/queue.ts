// 数据库即队列。
//
// 为什么不用 Redis/MQ：当前规模远没到那个量级，而一张带租约的表就能满足规格
// 第二十章的全部要求——可重试、可恢复、可暂停、可取消、可查询进度、崩溃回收。
// 少一个中间件就少一处能挂的地方，这两天已经被中转挂怕了。
//
// 核心是租约（lease）：认领任务时写 locked_by + lease_until。
// worker 崩了不会有人来清理，但租约会到期，回收器把它放回 pending。
// 不依赖 worker 自己做任何善后，这是崩溃恢复能成立的前提。

import {
  assertTransition, backoffMs, isRetryable,
  type FailureClass, type TaskStatus, type TaskType,
} from './states';

export interface TaskRow {
  id: string;
  project_id: string;
  shot_id: string;
  parent_task_id: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  attempt: number;
  max_attempts: number;
  input_json: string;
  output_json: string;
  error_text: string;
  failure_class: string;
  idempotency_key: string;
  locked_by: string;
  lease_until: number;
  heartbeat_at: number;
  run_after: number;
  trace_id: string;
  created_at: number;
  updated_at: number;
}

export interface EnqueueInput {
  type: TaskType;
  /** 同一个业务动作的稳定标识。重复入队会返回既有任务，而不是再建一个。 */
  idempotencyKey: string;
  projectId?: string;
  shotId?: string;
  parentTaskId?: string;
  input?: unknown;
  priority?: number;
  maxAttempts?: number;
  runAfter?: number;
  traceId?: string;
  /**
   * 必须先成功的上游任务 id。
   * 「拼接要等 12 个镜头全部出片」这类依赖 parent_task_id 表达不了，得靠边表。
   */
  dependsOn?: string[];
}

const now = () => Date.now();
const uid = () => crypto.randomUUID();

/** 默认租约时长。视频生成实测要 6 分钟以上，所以给得比较宽。 */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export class TaskQueue {
  constructor(private readonly db: D1Database) {}

  /**
   * 入队。幂等：同一个 idempotencyKey 只会有一个任务。
   * 这是规格第二十章「避免用户刷新页面导致重复任务」的落点——
   * 不靠前端禁用按钮，靠数据库唯一约束。
   */
  async enqueue(input: EnqueueInput): Promise<TaskRow> {
    const existing = await this.byIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const t = now();
    const row: TaskRow = {
      id: uid(),
      project_id: input.projectId ?? '',
      shot_id: input.shotId ?? '',
      parent_task_id: input.parentTaskId ?? '',
      type: input.type,
      status: 'pending',
      priority: input.priority ?? 100,
      attempt: 0,
      max_attempts: input.maxAttempts ?? 3,
      input_json: JSON.stringify(input.input ?? {}),
      output_json: '{}',
      error_text: '',
      failure_class: '',
      idempotency_key: input.idempotencyKey,
      locked_by: '',
      lease_until: 0,
      heartbeat_at: 0,
      run_after: input.runAfter ?? t,
      trace_id: input.traceId ?? uid(),
      created_at: t,
      updated_at: t,
    };
    try {
      await this.db.prepare(
        `INSERT INTO tasks (id,project_id,shot_id,parent_task_id,type,status,priority,attempt,max_attempts,
           input_json,output_json,error_text,failure_class,idempotency_key,locked_by,lease_until,heartbeat_at,
           run_after,trace_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        row.id, row.project_id, row.shot_id, row.parent_task_id, row.type, row.status, row.priority,
        row.attempt, row.max_attempts, row.input_json, row.output_json, row.error_text, row.failure_class,
        row.idempotency_key, row.locked_by, row.lease_until, row.heartbeat_at, row.run_after,
        row.trace_id, row.created_at, row.updated_at,
      ).run();
    } catch (cause) {
      // 并发下两个请求可能同时通过上面的 existing 检查，唯一索引会挡住第二个。
      // 这不是错误，是幂等生效了：把已经存在的那条读回来。
      const raced = await this.byIdempotencyKey(input.idempotencyKey);
      if (raced) return raced;
      throw cause;
    }
    if (input.dependsOn?.length) await this.addDependencies(row.id, input.dependsOn);
    await this.event(row.id, '', 'pending', input.dependsOn?.length ? `enqueued，等待 ${input.dependsOn.length} 个上游任务` : 'enqueued');
    return row;
  }

  async byIdempotencyKey(key: string): Promise<TaskRow | null> {
    return await this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
      .bind(key).first<TaskRow>();
  }

  async byId(id: string): Promise<TaskRow | null> {
    return await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
  }

  /**
   * 认领一个任务。用条件 UPDATE 保证同一条不会被两个 worker 同时拿走：
   * WHERE status='pending' 是乐观锁——谁先改成 leased 谁拿到，另一个 meta.changes 为 0。
   */
  async claim(workerId: string, types?: TaskType[], leaseMs = DEFAULT_LEASE_MS): Promise<TaskRow | null> {
    const t = now();
    const typeFilter = types?.length ? ` AND t.type IN (${types.map(() => '?').join(',')})` : '';
    for (let i = 0; i < 5; i += 1) {
      // 依赖未满足的任务留在队列里，不取出来。取出来再判断会白占一个并发位，
      // 还得处理「取了又放回去」的状态回退——那正是状态机最容易被绕过的地方。
      const candidate = await this.db.prepare(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'pending' AND t.run_after <= ?${typeFilter}
           AND NOT EXISTS (
             SELECT 1 FROM task_deps d JOIN tasks u ON u.id = d.depends_on
             WHERE d.task_id = t.id AND u.status <> 'succeeded'
           )
         ORDER BY t.priority ASC, t.created_at ASC LIMIT 1`,
      ).bind(t, ...(types ?? [])).first<TaskRow>();
      if (!candidate) return null;

      const res = await this.db.prepare(
        `UPDATE tasks SET status='leased', locked_by=?, lease_until=?, heartbeat_at=?, updated_at=?
         WHERE id=? AND status='pending'`,
      ).bind(workerId, t + leaseMs, t, t, candidate.id).run();
      if (res.meta.changes === 1) {
        await this.event(candidate.id, 'pending', 'leased', `claimed by ${workerId}`);
        return { ...candidate, status: 'leased', locked_by: workerId, lease_until: t + leaseMs };
      }
      // 被别人抢走了，看下一条
    }
    return null;
  }

  /** worker 真正开跑。attempt 在这里 +1，而不是在认领时——认领了没跑不算一次尝试。 */
  async start(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId);
    assertTransition(task.status, 'running', taskId);
    const t = now();
    await this.db.prepare(
      `UPDATE tasks SET status='running', attempt=attempt+1, heartbeat_at=?, updated_at=? WHERE id=?`,
    ).bind(t, t, taskId).run();
    await this.event(taskId, task.status, 'running', `attempt ${task.attempt + 1}`);
  }

  /** 心跳：长任务每隔一段时间续租，否则会被回收器当成崩溃。 */
  async heartbeat(taskId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
    const t = now();
    const res = await this.db.prepare(
      `UPDATE tasks SET heartbeat_at=?, lease_until=?, updated_at=? WHERE id=? AND locked_by=? AND status IN ('leased','running')`,
    ).bind(t, t + leaseMs, t, taskId, workerId).run();
    return res.meta.changes === 1;
  }

  async succeed(taskId: string, output: unknown): Promise<void> {
    const task = await this.requireTask(taskId);
    assertTransition(task.status, 'succeeded', taskId);
    const t = now();
    await this.db.prepare(
      `UPDATE tasks SET status='succeeded', output_json=?, locked_by='', lease_until=0, error_text='', updated_at=? WHERE id=?`,
    ).bind(JSON.stringify(output ?? {}), t, taskId).run();
    await this.event(taskId, task.status, 'succeeded', '');
  }

  /**
   * 失败。这里决定的是「还重不重试」，规则只有三条：
   * 分类不可重试 → 直接 dead；尝试次数用尽 → dead；否则退避后回 pending。
   */
  async fail(taskId: string, error: string, cls: FailureClass = 'unknown'): Promise<TaskStatus> {
    const task = await this.requireTask(taskId);
    const t = now();
    const exhausted = task.attempt >= task.max_attempts;
    const to: TaskStatus = !isRetryable(cls) || exhausted ? 'dead' : 'pending';

    assertTransition(task.status, 'failed', taskId);
    await this.db.prepare(
      `UPDATE tasks SET status='failed', error_text=?, failure_class=?, locked_by='', lease_until=0, updated_at=? WHERE id=?`,
    ).bind(error.slice(0, 2000), cls, t, taskId).run();
    await this.event(taskId, task.status, 'failed', error.slice(0, 500), { failure_class: cls });

    assertTransition('failed', to, taskId);
    const runAfter = to === 'pending' ? t + backoffMs(task.attempt) : t;
    await this.db.prepare(`UPDATE tasks SET status=?, run_after=?, updated_at=? WHERE id=?`)
      .bind(to, runAfter, t, taskId).run();
    await this.event(taskId, 'failed', to,
      to === 'dead'
        ? (exhausted ? `重试 ${task.attempt}/${task.max_attempts} 次用尽` : `${cls} 不可重试`)
        : `第 ${task.attempt + 1} 次重试将在 ${Math.round(backoffMs(task.attempt) / 1000)} 秒后`);
    return to;
  }

  async cancel(taskId: string, reason = ''): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.status === 'canceled') return;
    assertTransition(task.status, 'canceled', taskId);
    const t = now();
    await this.db.prepare(
      `UPDATE tasks SET status='canceled', locked_by='', lease_until=0, updated_at=? WHERE id=?`,
    ).bind(t, taskId).run();
    await this.event(taskId, task.status, 'canceled', reason);
  }

  /**
   * 回收租约过期的任务。由 orchestrator 定时调用。
   * 这是 worker crash recovery 的全部实现——不需要 worker 配合。
   */
  async reclaimExpired(limit = 50): Promise<number> {
    const t = now();
    const rows = await this.db.prepare(
      `SELECT id, status, attempt, max_attempts FROM tasks
       WHERE status IN ('leased','running') AND lease_until > 0 AND lease_until < ? LIMIT ?`,
    ).bind(t, limit).all<Pick<TaskRow, 'id' | 'status' | 'attempt' | 'max_attempts'>>();

    let n = 0;
    for (const row of rows.results ?? []) {
      const exhausted = row.attempt >= row.max_attempts;
      // leased/running → pending 是合法的；→ dead 必须先过 failed，状态机不允许跳
      if (exhausted) {
        await this.db.prepare(`UPDATE tasks SET status='failed', failure_class='timeout', error_text='租约过期，worker 可能已崩溃', locked_by='', updated_at=? WHERE id=?`)
          .bind(t, row.id).run();
        await this.event(row.id, row.status, 'failed', '租约过期');
        await this.db.prepare(`UPDATE tasks SET status='dead', updated_at=? WHERE id=?`).bind(t, row.id).run();
        await this.event(row.id, 'failed', 'dead', '租约过期且重试用尽');
      } else {
        await this.db.prepare(
          `UPDATE tasks SET status='pending', locked_by='', lease_until=0, run_after=?, updated_at=? WHERE id=?`,
        ).bind(t + backoffMs(row.attempt), t, row.id).run();
        await this.event(row.id, row.status, 'pending', '租约过期，放回队列');
      }
      n += 1;
    }
    return n;
  }

  /** 登记依赖边。幂等：主键是 (task_id, depends_on)，重复登记无害。 */
  async addDependencies(taskId: string, dependsOn: string[]): Promise<void> {
    const t = now();
    for (const upstream of dependsOn) {
      if (!upstream || upstream === taskId) continue;   // 自依赖会让任务永远取不出来
      await this.db.prepare(
        'INSERT OR IGNORE INTO task_deps (task_id, depends_on, created_at) VALUES (?,?,?)',
      ).bind(taskId, upstream, t).run();
    }
  }

  /** 还没成功的上游任务。前端「卡在哪」直接问它。 */
  async blockedBy(taskId: string): Promise<TaskRow[]> {
    const res = await this.db.prepare(
      `SELECT u.* FROM task_deps d JOIN tasks u ON u.id = d.depends_on
       WHERE d.task_id = ? AND u.status <> 'succeeded'`,
    ).bind(taskId).all<TaskRow>();
    return res.results ?? [];
  }

  /**
   * 上游进了死信 / 被取消，下游就永远等不到了。
   * 不处理的话这些任务会一直挂在 pending，用户看到的是「卡住不动」而不是「失败了」。
   */
  async cancelOrphans(projectId: string): Promise<number> {
    let total = 0;
    // 必须一轮一轮扫到不再变化为止：依赖是链式的。
    // 预演死了 → 出片取消 → 质检也该取消 → 拼接也该取消。
    // 只扫一遍的话，质检和拼接会永远挂在 pending，
    // 界面上显示成「排队中」——看着像还在跑，其实早死了。这比直接报错更误导人。
    for (let round = 0; round < 20; round += 1) {
      const res = await this.db.prepare(
        `SELECT DISTINCT d.task_id AS id FROM task_deps d
         JOIN tasks u ON u.id = d.depends_on
         JOIN tasks t ON t.id = d.task_id
         WHERE t.project_id = ? AND t.status = 'pending' AND u.status IN ('dead','canceled')`,
      ).bind(projectId).all<{ id: string }>();
      const rows = res.results ?? [];
      if (!rows.length) break;
      for (const row of rows) {
        await this.cancel(row.id, '上游任务已失败或取消，本任务不可能再执行');
        total += 1;
      }
    }
    return total;
  }

  /**
   * 这一镜还有没有没跑完的任务。
   * 重试督导靠它避免「上一次重试还在排队，就又排了一次」——
   * 那会让同一镜同时有好几条重试链在跑，钱翻倍花，最后还不知道该用哪一份。
   */
  async hasActiveWork(projectId: string, shotId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS c FROM tasks
       WHERE project_id = ? AND shot_id = ? AND status IN ('pending','leased','running','failed')`,
    ).bind(projectId, shotId).first<{ c: number }>();
    return (row?.c ?? 0) > 0;
  }

  async listByProject(projectId: string): Promise<TaskRow[]> {
    const res = await this.db.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC',
    ).bind(projectId).all<TaskRow>();
    return res.results ?? [];
  }

  private async requireTask(id: string): Promise<TaskRow> {
    const task = await this.byId(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    return task;
  }

  /** 每一次状态变化都留痕，这是后台能查出「到底卡在哪」的唯一依据。 */
  private async event(taskId: string, from: string, to: string, note: string, data?: unknown): Promise<void> {
    await this.db.prepare(
      `INSERT INTO task_events (id,task_id,from_status,to_status,note,data_json,created_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(uid(), taskId, from, to, note.slice(0, 500), JSON.stringify(data ?? {}), now()).run();
  }
}
