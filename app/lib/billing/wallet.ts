// 钱包与账务。
//
// 规格第廿一章的硬要求：不许 `balance -= xxx`，所有资金变动必须有流水；
// 必须避免重复扣费、任务失败仍扣全款、重试无限扣钱。
//
// 三条设计决定：
//  1. 金额一律整数「分」。浮点做账迟早对不平。
//  2. 每一笔变动都带 idempotencyKey，唯一索引兜底。重放多少次只记一笔。
//  3. 余额分「可用 / 冻结」两段：任务开始前冻结预估额，结束后按真实消耗结算，差额解冻。
//     这样用户不会在任务跑一半时把余额花掉，也不会因为任务失败白扣钱。

export type TxKind = 'topup' | 'freeze' | 'unfreeze' | 'charge' | 'refund' | 'adjust';

export interface WalletRow {
  user_id: string;
  balance_cents: number;
  frozen_cents: number;
  topup_cents: number;
  currency: string;
  updated_at: number;
}

export class InsufficientBalance extends Error {
  constructor(readonly needCents: number, readonly haveCents: number) {
    super(`余额不足：需要 ${(needCents / 100).toFixed(2)}，可用 ${(haveCents / 100).toFixed(2)}`);
    this.name = 'InsufficientBalance';
  }
}

const now = () => Date.now();
const uid = () => crypto.randomUUID();

export class Wallet {
  constructor(private readonly db: D1Database) {}

  async ensure(userId: string): Promise<WalletRow> {
    const existing = await this.db.prepare('SELECT * FROM wallets WHERE user_id = ?')
      .bind(userId).first<WalletRow>();
    if (existing) return existing;
    const t = now();
    await this.db.prepare(
      'INSERT INTO wallets (user_id,balance_cents,frozen_cents,topup_cents,currency,updated_at) VALUES (?,0,0,0,?,?)',
    ).bind(userId, 'CNY', t).run();
    return { user_id: userId, balance_cents: 0, frozen_cents: 0, topup_cents: 0, currency: 'CNY', updated_at: t };
  }

  async get(userId: string): Promise<WalletRow> {
    return await this.ensure(userId);
  }

  /** 充值。 */
  async topup(userId: string, cents: number, idempotencyKey: string, memo = ''): Promise<WalletRow> {
    if (cents <= 0) throw new Error('充值金额必须为正');
    return await this.apply(userId, 'topup', cents, idempotencyKey, { balance: +cents, topup: +cents }, memo);
  }

  /**
   * 冻结预估金额。任务开始前调用。
   * 可用余额减少、冻结增加，总额不变——钱还是用户的，只是不能再花。
   */
  async freeze(userId: string, cents: number, idempotencyKey: string, ref?: { type: string; id: string }): Promise<WalletRow> {
    if (cents < 0) throw new Error('冻结金额不能为负');
    const w = await this.ensure(userId);
    if (w.balance_cents < cents) throw new InsufficientBalance(cents, w.balance_cents);
    return await this.apply(userId, 'freeze', cents, idempotencyKey, { balance: -cents, frozen: +cents }, '', ref);
  }

  /** 解冻。任务取消或结算后把没用掉的部分放回可用余额。 */
  async unfreeze(userId: string, cents: number, idempotencyKey: string, ref?: { type: string; id: string }): Promise<WalletRow> {
    if (cents <= 0) return await this.get(userId);
    const w = await this.ensure(userId);
    const actual = Math.min(cents, w.frozen_cents);   // 不允许解冻出不存在的钱
    return await this.apply(userId, 'unfreeze', actual, idempotencyKey, { balance: +actual, frozen: -actual }, '', ref);
  }

  /**
   * 从冻结额里实际扣款。任务成功后按真实消耗调用。
   * 只动冻结部分，不碰可用余额——这样即使并发也不会扣到用户刚充进来的钱。
   */
  async chargeFrozen(userId: string, cents: number, idempotencyKey: string, ref?: { type: string; id: string }): Promise<WalletRow> {
    if (cents <= 0) return await this.get(userId);
    const w = await this.ensure(userId);
    if (w.frozen_cents < cents) {
      // 真实消耗超过预估。差额从可用余额补，补不上就把可用余额扣光并记在案——
      // 绝不允许把 frozen 扣成负数，那会让对账永远算不清。
      const fromFrozen = w.frozen_cents;
      const shortfall = cents - fromFrozen;
      const fromBalance = Math.min(shortfall, w.balance_cents);
      return await this.apply(userId, 'charge', cents, idempotencyKey,
        { balance: -fromBalance, frozen: -fromFrozen }, `超出预估 ${shortfall} 分，其中 ${fromBalance} 分从可用余额补扣`, ref);
    }
    return await this.apply(userId, 'charge', cents, idempotencyKey, { frozen: -cents }, '', ref);
  }

  /** 退款。任务失败且已扣过款时用。 */
  async refund(userId: string, cents: number, idempotencyKey: string, ref?: { type: string; id: string }, memo = ''): Promise<WalletRow> {
    if (cents <= 0) return await this.get(userId);
    return await this.apply(userId, 'refund', cents, idempotencyKey, { balance: +cents }, memo, ref);
  }

  /**
   * 流水按时间倒序。
   *
   * 必须带 rowid 兜底：created_at 是毫秒，同一毫秒内完全可能落多笔
   * （冻结→扣款→解冻常常就在同一毫秒里），只按 created_at 排序会得到不确定的顺序，
   * 账本就还原不出真实次序了。rowid 是插入顺序，单调递增。
   */
  async transactions(userId: string, limit = 100) {
    const res = await this.db.prepare(
      'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).bind(userId, limit).all();
    return res.results ?? [];
  }

  /** 最后一笔流水。对账用：余额必须等于它的 balance_after。 */
  async lastTransaction(userId: string) {
    return await this.db.prepare(
      'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).bind(userId).first<{ balance_after: number; frozen_after: number; kind: string }>();
  }

  /**
   * 所有变动的唯一出口。
   * 先查幂等键：已经记过就原样返回当前余额，不再动账——这是防重复扣费的核心。
   */
  private async apply(
    userId: string,
    kind: TxKind,
    amountCents: number,
    idempotencyKey: string,
    delta: { balance?: number; frozen?: number; topup?: number },
    memo = '',
    ref?: { type: string; id: string },
  ): Promise<WalletRow> {
    if (!idempotencyKey) throw new Error('资金变动必须带 idempotencyKey');
    const seen = await this.db.prepare('SELECT id FROM wallet_transactions WHERE idempotency_key = ?')
      .bind(idempotencyKey).first<{ id: string }>();
    if (seen) return await this.get(userId);

    const w = await this.ensure(userId);
    const nextBalance = w.balance_cents + (delta.balance ?? 0);
    const nextFrozen = w.frozen_cents + (delta.frozen ?? 0);
    if (nextBalance < 0 || nextFrozen < 0) {
      throw new Error(`账务异常：余额或冻结会变成负数（balance ${nextBalance}, frozen ${nextFrozen}）`);
    }
    const t = now();

    // D1 的 batch 是原子的：余额与流水要么一起成功，要么一起失败。
    // 流水的唯一索引是最后一道防线——并发重放会在这里被挡下。
    try {
      await this.db.batch([
        this.db.prepare(
          'UPDATE wallets SET balance_cents=?, frozen_cents=?, topup_cents=?, updated_at=? WHERE user_id=?',
        ).bind(nextBalance, nextFrozen, w.topup_cents + (delta.topup ?? 0), t, userId),
        this.db.prepare(
          `INSERT INTO wallet_transactions
             (id,user_id,kind,amount_cents,balance_after,frozen_after,ref_type,ref_id,idempotency_key,memo,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(uid(), userId, kind, amountCents, nextBalance, nextFrozen,
          ref?.type ?? '', ref?.id ?? '', idempotencyKey, memo, t),
      ]);
    } catch {
      // 并发下另一个请求先插入了同一个幂等键：那边已经记过账，这边什么都不做。
      const raced = await this.db.prepare('SELECT id FROM wallet_transactions WHERE idempotency_key = ?')
        .bind(idempotencyKey).first<{ id: string }>();
      if (raced) return await this.get(userId);
      throw new Error('账务写入失败');
    }
    return { ...w, balance_cents: nextBalance, frozen_cents: nextFrozen, topup_cents: w.topup_cents + (delta.topup ?? 0), updated_at: t };
  }
}
