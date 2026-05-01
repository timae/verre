// Reserved names — case-insensitive after lowercasing.
// Blocks impersonation of system actors and the deletion placeholder.
const RESERVED = new Set([
  'admin', 'verre', 'support', 'host', 'system',
  '[deleted]', 'deleted', 'moderator', 'mod', 'help', 'api',
  'staff', 'official', 'team', 'root', 'null', 'undefined',
])

// Letters / digits / space / apostrophe / underscore / period / hyphen.
// Excludes Redis key separators (`:`, `*`) and control characters.
const ALLOWED = /^[\p{L}\p{N} '_.\-]+$/u

export function validateDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const trimmed = raw.trim().normalize('NFKC')
  if (trimmed.length === 0) throw new Error('name is required')
  if (trimmed.length > 64) throw new Error('name must be at most 64 characters')
  if (!ALLOWED.test(trimmed)) throw new Error('name contains invalid characters')
  if (RESERVED.has(trimmed.toLowerCase())) throw new Error('name is reserved')
  return trimmed
}
