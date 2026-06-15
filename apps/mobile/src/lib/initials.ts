// Avatar initials from a display name. Code-point-aware (`[...word]`, not
// `word[i]`): a disambiguated name can carry an emoji suffix (e.g. "Simon 🍇"),
// and indexing UTF-16 units would split the surrogate pair into a broken "�"
// glyph. Array spread yields whole code points, so an emoji renders as itself.
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const cp = (w: string) => [...w];
  if (words.length === 1) return cp(words[0]).slice(0, 2).join('').toUpperCase();
  return (cp(words[0])[0] + cp(words[1])[0]).toUpperCase();
}
