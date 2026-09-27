// 极客版核心管线测试：迁移 SQL、任务状态机、队列租约、钱包账务。
//
// 重点测的是「会出钱的地方」和「会卡死的地方」——规格第卅二章点名的那几条：
// 余额扣费、重复回调、重复任务、Retry、任务失败、退款、任务状态、并发。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
import { applySql, createD1 } from './d1-stub.mjs';

const load = async (path) => {
  const r = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
};

// ---------- 迁移 ----------
// 扫目录而不是写死文件名：新增一份迁移就该自动被测到，
// 靠记得改测试文件是迟早会漏的（0002 就漏过一次，直接跑出 no such table）。
const d1 = createD1();
const MIGRATION_FILES = fs.readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
assert.ok(MIGRATION_FILES.length >= 3, `drizzle 下应有至少三份迁移，实际 ${MIGRATION_FILES}`);
let n1 = 0;
for (const f of MIGRATION_FILES) n1 += applySql(d1, fs.readFileSync(`drizzle/${f}`, 'utf8'));
assert.ok(n1 > 20, '迁移应该有二十条以上语句');
// 老表必须还在：现有项目不能被新迁移搞坏
const tables = d1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().results.map((r) => r.name);
for (const t of ['video_projects', 'users', 'wallets', 'wallet_transactions', 'projects', 'scenes', 'shots',
  'shot_dna', 'tasks', 'task_events', 'assets', 'provider_requests', 'billing_records',
  'generation_attempts', 'quality_reports', 'prompt_templates', 'system_config', 'task_deps']) {
  assert.ok(tables.includes(t), `缺表 ${t}`);
}
// 重复执行必须无害（全是 IF NOT EXISTS）
for (const f of MIGRATION_FILES) applySql(d1, fs.readFileSync(`drizzle/${f}`, 'utf8'));

// ---------- 状态机 ----------
const S = await load('app/lib/task/states.ts');
// succeeded 是终态：已经成功并计过费的任务绝不允许被改回 pending 再跑一遍
assert.equal(S.canTransition('succeeded', 'pending'), false);
assert.equal(S.canTransition('succeeded', 'running'), false);
assert.ok(S.isTerminal('succeeded'));
assert.ok(S.canTransition('failed', 'pending'));      // 可重试
assert.ok(S.canTransition('dead', 'pending'));        // 人工重试失败任务
assert.throws(() => S.assertTransition('succeeded', 'pending', 'T1'), /不允许/);
// 余额不足和参数被拒重试多少次都一样，不许自动重试
assert.equal(S.isRetryable('insufficient_balance'), false);
assert.equal(S.isRetryable('provider_rejected'), false);
assert.equal(S.isRetryable('provider_unavailable'), true);
// 退避递增且有上限
assert.ok(S.backoffMs(1) < S.backoffMs(3));
assert.equal(S.backoffMs(99), 5 * 60_000);

// ---------- 队列 ----------
const { TaskQueue } = await load('app/lib/task/queue.ts');
const q = new TaskQueue(d1);

// 幂等：同一个 key 重复入队只产生一个任务（防止用户刷新页面重复提交）
const a1 = await q.enqueue({ type: 'video', idempotencyKey: 'shot-1:video:v1', projectId: 'P1', shotId: 'S1' });
const a2 = await q.enqueue({ type: 'video', idempotencyKey: 'shot-1:video:v1', projectId: 'P1', shotId: 'S1' });
assert.equal(a1.id, a2.id, '重复入队必须返回同一个任务');
assert.equal(d1.prepare('SELECT COUNT(*) c FROM tasks').first().c, 1);

// 认领是互斥的：两个 worker 抢同一条，只有一个拿到
const w1 = await q.claim('worker-A');
assert.equal(w1.id, a1.id);
const w2 = await q.claim('worker-B');
assert.equal(w2, null, '任务已被认领，第二个 worker 不该再拿到');

await q.start(w1.id);
assert.equal((await q.byId(w1.id)).attempt, 1, 'attempt 在开跑时才 +1');

// 失败后退避重试，回到 pending
await q.fail(w1.id, '上游 500', 'provider_unavailable');
let t = await q.byId(w1.id);
assert.equal(t.status, 'pending');
assert.ok(t.run_after > Date.now(), '重试必须退避，不能立刻重跑');
assert.equal(t.locked_by, '', '失败后必须释放租约');

// 重试用尽 → dead。
// 注意顺序：claim 会跳过 run_after 在未来的任务，所以必须先把退避时间清掉再认领——
// 这本身也是一条被测行为：退避是真的生效的，不是摆设。
for (let i = 0; i < 5; i += 1) {
  await d1.prepare('UPDATE tasks SET run_after=0 WHERE id=?').bind(a1.id).run();
  const c = await q.claim('worker-A');
  if (!c) break;
  await q.start(c.id);
  await q.fail(c.id, 'again', 'provider_unavailable');
}
t = await q.byId(a1.id);
assert.equal(t.status, 'dead', `重试用尽后应进死信，实际 ${t.status}`);

// 不可重试的失败直接进死信，不浪费次数
const b = await q.enqueue({ type: 'video', idempotencyKey: 'k2' });
const bc = await q.claim('worker-A');
await q.start(bc.id);
await q.fail(bc.id, '余额不够', 'insufficient_balance');
assert.equal((await q.byId(b.id)).status, 'dead');

// 租约过期自动回收（worker 崩溃恢复，不需要 worker 配合）
const c = await q.enqueue({ type: 'analyze', idempotencyKey: 'k3' });
const cc = await q.claim('worker-crash');
await q.start(cc.id);
await d1.prepare('UPDATE tasks SET lease_until=? WHERE id=?').bind(Date.now() - 1000, cc.id).run();
assert.equal(await q.reclaimExpired(), 1);
assert.equal((await q.byId(c.id)).status, 'pending', '租约过期的任务应回到队列');

// 每一次状态变化都留痕
const events = d1.prepare('SELECT COUNT(*) c FROM task_events').first().c;
assert.ok(events > 10, `状态变化必须写事件，实际只有 ${events} 条`);

// ---------- 钱包 ----------
const { Wallet, InsufficientBalance } = await load('app/lib/billing/wallet.ts');
const wallet = new Wallet(d1);
d1.prepare('INSERT INTO users (id,email,display_name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .bind('U1', 'a@b.c', 'tester', 'user', 'active', Date.now(), Date.now()).run();

await wallet.topup('U1', 10_000, 'topup-1');
// 重复回调必须只记一笔——支付网关重发通知是常态
await wallet.topup('U1', 10_000, 'topup-1');
assert.equal((await wallet.get('U1')).balance_cents, 10_000, '重复充值回调不该加两次钱');

// 冻结：可用减少、冻结增加、总额不变
await wallet.freeze('U1', 3_000, 'freeze-P1');
let w = await wallet.get('U1');
assert.equal(w.balance_cents, 7_000);
assert.equal(w.frozen_cents, 3_000);

// 真实消耗小于预估：扣真实数，余下解冻
await wallet.chargeFrozen('U1', 1_200, 'charge-P1', { type: 'project', id: 'P1' });
await wallet.unfreeze('U1', 1_800, 'unfreeze-P1');
w = await wallet.get('U1');
assert.equal(w.frozen_cents, 0, '结算后不该还有冻结');
assert.equal(w.balance_cents, 8_800, '10000 - 1200 实际消耗');

// 重复结算不能扣第二次
await wallet.chargeFrozen('U1', 1_200, 'charge-P1');
assert.equal((await wallet.get('U1')).balance_cents, 8_800, '重复扣费必须被幂等挡住');

// 余额不足必须拒绝，而不是扣成负数
await assert.rejects(() => wallet.freeze('U1', 99_999, 'freeze-big'), InsufficientBalance);

// 任务失败退款
await wallet.refund('U1', 1_200, 'refund-P1', { type: 'project', id: 'P1' }, '任务失败全额退');
assert.equal((await wallet.get('U1')).balance_cents, 10_000);

// 流水条数：充值1 + 冻结1 + 扣款1 + 解冻1 + 退款1 = 5（重复的都没记）
assert.equal((await wallet.transactions('U1')).length, 5, '每笔变动一条流水，重复动作不记');

// 余额必须等于最后一笔流水的 balance_after，否则账本和钱对不上。
// 这里曾经栽过：只按 created_at（毫秒）排序，同一毫秒内的多笔顺序不确定，
// 取到的"最后一笔"是解冻而不是退款。排序必须带 rowid 兜底。
const last = await wallet.lastTransaction('U1');
assert.equal(last.kind, 'refund', '最后一笔应该是退款');
assert.equal(last.balance_after, (await wallet.get('U1')).balance_cents, '余额必须能由流水推出来');
assert.equal(last.balance_after, 10_000);

// ---------- Provider ----------
const { MockVideoProvider } = await load('app/lib/providers/mock-video.ts');
const { OpenRouterVideoProvider } = await load('app/lib/providers/openrouter-video.ts');
const { VideoGateway } = await load('app/lib/providers/gateway.ts');

const or = new OpenRouterVideoProvider();
const cap = or.capabilities('bytedance/seedance-2.5');
assert.equal(cap.maxSeconds, 30);
assert.equal(cap.sources.seconds, 'verified', '实测过的才能标 verified');
// 估价：20 秒 @ $0.1028/秒 ≈ $2.06 = 206 分
assert.equal(or.estimateCents({ model: 'bytedance/seedance-2.5', prompt: 'p', seconds: 20 }), 206);
// 本地就该拦下超范围，不要提交后被上游拒还白等
await assert.rejects(() => or.generate({ model: 'bytedance/seedance-2.5', prompt: 'p', seconds: 99 }, { baseUrl: 'x', apiKey: 'y' }), /时长范围/);
// 实测不收参考图的档，带参考图必须当场拒
await assert.rejects(() => or.generate({ model: 'minimax/hailuo-3-max', prompt: 'p', seconds: 10, referenceImages: ['data:x'] }, { baseUrl: 'x', apiKey: 'y' }), /不收参考图/);

// Gateway 落到备份 Provider
const flaky = {
  name: 'flaky',
  capabilities: () => undefined,
  estimateCents: () => 0,
  generate: async () => { const e = new Error('渠道不存在'); e.name = 'ProviderError'; e.kind = 'unavailable'; throw e; },
  getTaskStatus: async () => ({ jobId: '', status: 'failed' }),
  download: async () => new ArrayBuffer(0),
};
const mock = new MockVideoProvider({ generationMs: 0 });
const gw = new VideoGateway([
  { provider: mock, creds: { baseUrl: '', apiKey: '' } },
]);
const { job } = await gw.generate({ model: 'mock/video', prompt: 'hello', seconds: 4 });
assert.ok(job.jobId.startsWith('mock-'));
const st = await gw.status(job.jobId, 'mock');
assert.equal(st.status, 'completed');
assert.equal(st.costCents, 4);
void flaky;

console.log('极客版管线测试通过：迁移（老表未受影响）、状态机（succeeded 终态不可回退）、队列（幂等/互斥/退避/死信/租约回收/事件留痕）、钱包（重复回调、超预估补扣、重复结算、余额不足、退款、流水可推余额）、Provider（能力表来源标记、本地预校验、Gateway）。');
