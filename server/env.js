/**
 * Minimal .env loader. Real environment variables always win over the file, so
 * a service definition or shell export overrides a stale .env on disk.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadEnv(root) {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
