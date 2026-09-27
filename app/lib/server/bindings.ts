import { env } from 'cloudflare:workers';

export function requireDatabase(): D1Database {
  if (!env.DB) throw new Error('storage_unavailable');
  return env.DB;
}

export function requireImages(): R2Bucket {
  if (!env.GENERATED_IMAGES) throw new Error('storage_unavailable');
  return env.GENERATED_IMAGES;
}
