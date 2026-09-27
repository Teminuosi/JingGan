import { MIGRATIONS } from '../../../db/migrations';
import { requireDatabase } from './bindings';
export async function recordAccountVisit(userId: string, source: string) {
  const db = requireDatabase();
  await db.batch(MIGRATIONS.map(sql => db.prepare(sql)));
  await db.prepare('INSERT OR IGNORE INTO account_visits (user_id, first_source, first_used_at) VALUES (?, ?, ?)').bind(userId, source, Date.now()).run();
}
