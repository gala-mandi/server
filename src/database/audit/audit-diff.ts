/** Shown instead of a secret value in `audit_logs`. */
export const REDACTED = '[REDACTED]';

// Passwords, tokens, secrets and one-time codes never reach the audit log.
// Matched per word (camelCase / snake_case), so `footprint` is not an "otp".
const SENSITIVE_WORDS = new Set([
  'password',
  'passcode',
  'token',
  'secret',
  'otp',
]);

export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    // Plurals too: `tokens`, `secrets`.
    words.some(
      (word) =>
        SENSITIVE_WORDS.has(word) ||
        SENSITIVE_WORDS.has(word.replace(/s$/, '')),
    ) || words[words.length - 1] === 'hash'
  );
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON-safe copy with sensitive keys replaced by `[REDACTED]`, at any depth. */
export function maskSensitive(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : maskSensitive(item);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return typeof value === 'string' ? value : null;
}

// Bookkeeping columns that change on every write; not worth a log entry.
const IGNORED = new Set(['updatedAt']);

export interface Changes {
  before: Record<string, Json>;
  after: Record<string, Json>;
}

/** Only the fields that changed, old and new values side by side (masked). */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Changes | null {
  // Compare the real values (so a changed secret is still logged), then
  // store the masked ones.
  const masked = {
    before: maskSensitive(before) as Record<string, Json>,
    after: maskSensitive(after) as Record<string, Json>,
  };
  const changes: Changes = { before: {}, after: {} };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    const oldRaw = JSON.stringify(plain(before[key]));
    const newRaw = JSON.stringify(plain(after[key]));
    if (oldRaw === newRaw) continue;
    changes.before[key] = masked.before[key] ?? null;
    changes.after[key] = masked.after[key] ?? null;
  }
  return Object.keys(changes.after).length ? changes : null;
}

/** JSON-safe value without masking, only for comparing. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}
