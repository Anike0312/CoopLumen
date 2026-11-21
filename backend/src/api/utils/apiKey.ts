import { createHash, randomBytes } from 'crypto';
import { db } from '../../db';

const PREFIX = 'cl_live_';
export const hashApiKey = (value: string): string => createHash('sha256').update(value).digest('hex');

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 16), hash: hashApiKey(key) };
}

export async function authenticateApiKey(value: string): Promise<string | null> {
  if (!value.startsWith(PREFIX) || value.length > 100) return null;
  const [record] = await db.query<{ id: string; owner_address: string }>(
    `SELECT id, owner_address FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > NOW())`, [hashApiKey(value)]
  );
  if (!record) return null;
  void db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [record.id]);
  return record.owner_address;
}
