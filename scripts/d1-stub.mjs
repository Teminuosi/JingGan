// 用 Node 自带的 node:sqlite 实现一个 D1Database 兼容层，供测试使用。
//
// 这样测试跑的是真 SQL：迁移写错了 CHECK、索引名重复、字段类型不对，在这里就会炸，
// 而不是等部署到 Cloudflare 才发现。

import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) {
    const next = new Stmt(this.db, this.sql);
    // node:sqlite 不接受 undefined / boolean，统一归一化
    next.args = args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
    return next;
  }
  run() {
    const st = this.db.prepare(this.sql);
    const r = st.run(...this.args);
    return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
  first() {
    const st = this.db.prepare(this.sql);
    const rows = st.all(...this.args);
    return rows.length ? rows[0] : null;
  }
  all() {
    const st = this.db.prepare(this.sql);
    return { results: st.all(...this.args), success: true, meta: {} };
  }
}

/** 返回一个对象，接口与 Cloudflare D1Database 一致（run/first/all/batch）。 */
export function createD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  // 本地开发时 worker 与网站（miniflare）会同时开同一个库文件。
  // 没有这两条就会直接 "database is locked" —— WAL 让读写不互斥，
  // busy_timeout 让偶发的写冲突等一会儿而不是当场抛。
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 只读或已被别人设过，忽略 */ }
  db.exec('PRAGMA busy_timeout = 8000');
  return {
    prepare: (sql) => new Stmt(db, sql),
    // D1 的 batch 是原子的，这里用事务模拟
    batch: (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    exec: (sql) => db.exec(sql),
    _raw: db,
  };
}

/** 把一个 .sql 文件切成语句并执行。与 db/migrations.ts 里的切法保持一致。 */
export function applySql(d1, sql) {
  const statements = sql
    .split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of statements) d1.exec(s);
  return statements.length;
}
