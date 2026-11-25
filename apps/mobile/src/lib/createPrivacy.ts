import type { CreatePrivacyValues } from './momentVisibilityCopy';

// Create Moment's privacy choices (Moment Defaults D4, plan § 3), carried
// between the create screen and its Privacy page (a sibling route): one entry
// PER CREATE SCREEN (its key travels to the page as `key`), seeded from your
// defaults once they load, changed by the page, read by the create's POST
// (all six values sent: ruled 2026-11-25). Cleared when the create screen
// unmounts. Pure module state (the root units import it).
const store = new Map<string, CreatePrivacyValues>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function newCreatePrivacyKey(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
export function subscribeCreatePrivacy(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getCreatePrivacy = (key: string | null | undefined): CreatePrivacyValues | null => (key ? store.get(key) ?? null : null);
// Seeds only an empty entry: a page change made before the defaults' re-read
// is never overwritten by it.
export function seedCreatePrivacy(key: string, v: CreatePrivacyValues): void {
  if (store.has(key)) return;
  store.set(key, v);
  notify();
}
export function setCreatePrivacy<F extends keyof CreatePrivacyValues>(key: string, field: F, value: CreatePrivacyValues[F]): void {
  const cur = store.get(key);
  if (!cur || cur[field] === value) return;
  store.set(key, { ...cur, [field]: value });
  notify();
}
export function clearCreatePrivacy(key: string): void {
  if (store.delete(key)) notify();
}
