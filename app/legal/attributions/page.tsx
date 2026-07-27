import type { Metadata } from 'next'
import { getAttributions } from '@/lib/attributions'

export const metadata: Metadata = {
  title: 'Attributions — Verre',
  description: 'Sources and licences for the wine catalog data used in Verre.',
}

// Corpus-level attributions for the wine catalog.
//
// 🔒 This page exists to satisfy LICENCE OBLIGATIONS (CC BY, OGL-BC, MIT), not
// as a credits courtesy. Three rendering rules are load-bearing:
//
//  1. BOTH links MUST be real, followable links, each labelled for what it is.
//     `licence.url` is the compliance-relevant one — CC BY requires "provide a
//     link to the license" and OGL-BC requires one "where possible"; holding
//     the URL in config without rendering it does not satisfy either.
//     `sourceUrl` is where the dataset lives. They are separate fields because
//     conflating them left LWIN linking a dataset page instead of its licence.
//  2. `licence.text` renders VERBATIM in a <pre> — preserved whitespace, no
//     scrub, no trim, no re-wrapping. MIT requires its full notice reproduced.
//  3. An entry with `verified: false` MUST show its caveat VISIBLY. Hiding it
//     reproduces the exact failure the flag exists to prevent.
//
// Reads the config server-side; it does NOT fetch /api/legal/attributions
// (that route exists for the native app, which cannot read server env).

export default function AttributionsPage() {
  const entries = getAttributions()
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 20px 96px' }}>
      {/* Marker state can't be expressed inline — [open] is a parent-state
          selector. Also strips the UA's default triangle (::marker / the
          WebKit pseudo-element) so ours is the only one. */}
      <style>{`
        .attr-summary { list-style: none; }
        .attr-summary::-webkit-details-marker { display: none; }
        .attr-marker { transition: transform 120ms ease; display: inline-block; }
        details[open] .attr-marker { transform: rotate(90deg); }
      `}</style>
      <h1 style={{ fontSize: 28, color: 'var(--fg)', marginBottom: 8 }}>Attributions</h1>

      {/* Gratitude, kept DELIBERATELY SEPARATE from the obligation text below.
          Thanking a source is ours to offer; it must never read as if the
          source requires it — CC0 waives attribution outright, and blurring the
          two would misstate a licence on a page whose whole job is to state
          licences accurately. */}
      <p style={{ color: 'var(--fg-warm)', lineHeight: 1.7, marginBottom: 16 }}>
        These projects made their data public so others could build on it. Verre started
        with a real catalog because of them. Thank you.
      </p>
      <p style={{ color: 'var(--fg-dim)', lineHeight: 1.6, marginBottom: 40 }}>
        Verre&rsquo;s wine catalog is built from these sources. Each is used under the
        licence shown, and these acknowledgements are required by those licences.
      </p>

      {/* 🔒 COLLAPSED, NOT UNMOUNTED. <details> keeps its contents in the DOM
          (and in the page source) while closed — a required attribution
          statement that does not exist until someone clicks is a materially
          weaker compliance position than one that is merely folded. Never swap
          this for a JS toggle that conditionally renders the body. It also
          gives keyboard + screen-reader disclosure semantics for free. */}
      {entries.map((e) => (
        <details
          key={e.id}
          style={{ background: 'var(--bg2)', borderRadius: 12, padding: 20, marginBottom: 20 }}
        >
          <summary className="attr-summary" style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="attr-marker" aria-hidden="true" style={{ color: 'var(--fg-dim)', fontSize: 11, lineHeight: 1.6 }}>▶</span>
            <h2 style={{ fontSize: 18, color: 'var(--fg)', flex: 1, display: 'inline' }}>{e.source}</h2>
            <span style={{ color: 'var(--fg-dim)', fontSize: 14 }}>
              {e.licence.spdx}
              {e.dataPeriod ? ` · ${e.dataPeriod}` : ''}
            </span>
          </summary>

          <div style={{ marginTop: 12 }} />

          {/* Rule 3 — an unverified entry says so, visibly. */}
          {!e.verified && (
            <p
              style={{
                background: 'var(--bg4)',
                color: 'var(--danger)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 14,
                lineHeight: 1.5,
                marginBottom: 12,
              }}
            >
              <strong>Unverified wording.</strong> {e.notes}
            </p>
          )}

          {/* The attribution statement we are obliged to display. Empty for
              CC0, which waives attribution — so nothing is claimed. */}
          {e.attribution && (
            <p style={{ color: 'var(--fg-warm)', lineHeight: 1.6, marginBottom: 12 }}>
              {e.attribution}
            </p>
          )}

          {/* Rule 1 — both links rendered, and LABELLED for what they are.
              The licence link is the compliance-relevant one (CC BY and OGL-BC
              both require a link to the LICENCE); the source link is where the
              dataset lives. Conflating them is what this split fixed. */}
          <p style={{ marginBottom: e.licence.text ? 12 : 0, fontSize: 14, lineHeight: 1.8 }}>
            <a
              href={e.licence.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              {e.licence.spdx} licence
            </a>
            <span style={{ color: 'var(--fg-dim)' }}> · </span>
            <a
              href={e.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              Source
            </a>
          </p>

          {/* Rule 2 — verbatim, whitespace preserved. */}
          {e.licence.text && (
            <pre
              style={{
                background: 'var(--bg)',
                color: 'var(--fg-warm-soft)',
                borderRadius: 8,
                padding: 16,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowX: 'auto',
                margin: 0,
              }}
            >
              {e.licence.text}
            </pre>
          )}
        </details>
      ))}
    </main>
  )
}
