// Render a text blob with http(s) URLs split out as clickable links.
// Used by description / notes / metadata surfaces (wine info, session
// metadata, etc.). Scheme is restricted to http(s) by construction —
// `javascript:` / `data:` cannot match the leading-`https?://` regex,
// so even a hostile body string can't sneak a non-link scheme through.
// React JSX text + href interpolation handles attribute-value escaping;
// no innerHTML.
//
// Returns a ReactNode[] suitable for embedding as children. Caller
// chooses the link color via CSS / inline style — the function emits
// `var(--accent)` to match the rest of the app, override at the
// wrapping element if needed.
import type { ReactNode } from 'react'

const LINK_RE = /(https?:\/\/[^\s]+)/g

export function renderWithLinks(text: string): ReactNode[] {
  const parts = text.split(LINK_RE)
  return parts.map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{part}</a>
      : part
  )
}
