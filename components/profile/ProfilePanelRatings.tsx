'use client'
import { useRef } from 'react'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { FL } from '@/lib/flavours'
import type { FlavorBlock } from '@/lib/profileFlavor'

interface Props {
  // Lifetime monotonic count from `users.lifetime_ratings`. Drives the
  // tile and the empty-state copy: a user can have lifetime > 0 but
  // active = 0 if they've deleted every session that wasn't bookmarked.
  lifetimeRatings: number
  flavor: FlavorBlock
  // Whose profile this is and whether the viewer is the owner — drives
  // the empty-state messaging ("you haven't rated" vs "Tim hasn't rated").
  profileUserName: string
  isOwn: boolean
}

export function ProfilePanelRatings({ lifetimeRatings, flavor, profileUserName, isOwn }: Props) {
  const wheelRef = useRef<HTMLDivElement>(null)

  // Empty-state branches:
  // 1. No active rows AND no lifetime — never rated anything. Same copy
  //    for own and other.
  // 2. Active = 0 but lifetime > 0 — rated something, then everything
  //    rated got deleted (session deletions of non-bookmarked wines).
  //    Honest copy: "all rated wines have been deleted." Same for other,
  //    just phrased neutrally.
  // Empty-state detection: owner gets the exact `activeRatings === 0`
  // signal. Non-owners don't receive `activeRatings` (privacy redaction
  // — see FlavorBlock comment), so we infer "no data to plot" from the
  // wheel keys themselves: every key being null means no rating ever
  // contributed any flavor signal. Combined with `lifetimeRatings === 0`
  // we can still distinguish "never rated" from "all rated wines were
  // deleted" without exposing the exact active count.
  const noWheelData = isOwn
    ? flavor.activeRatings === 0
    : Object.values(flavor.keys).every(v => v == null)
  if (noWheelData) {
    const message = lifetimeRatings === 0
      ? 'No flavours tasted yet'
      : 'All rated wines have been deleted'
    return (
      <div style={{ padding: '32px 8px', textAlign: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--fg-dim)' }}>{message}</p>
        {lifetimeRatings === 0 && isOwn && (
          <p style={{ fontSize: 11, color: 'var(--fg-faint)', marginTop: 6 }}>
            Rate a wine in a session to start your flavour profile.
          </p>
        )}
      </div>
    )
  }

  // Active data exists. Some flavor keys come back null when the user
  // never tasted that dimension; treat as 0 for the wheel.
  const flavors = FL.reduce((o, f) => {
    const v = flavor.keys[f.k]
    return { ...o, [f.k]: v == null ? 0 : v }
  }, {} as Record<string, number>)
  const sorted = [...FL].sort((a, b) => (flavors[b.k] || 0) - (flavors[a.k] || 0))
  const topFlavors = sorted.slice(0, 3).filter(f => (flavors[f.k] || 0) > 0)

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        {/* "rated" shows lifetimeRatings (monotonic) for non-owners so
            the active/lifetime delta isn't visible alongside the public
            big-tile lifetimeRatings up top — that delta would reveal how
            many sessions the user has had deleted. Owners see the live
            count and a caption explaining the relationship. */}
        <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 14 }}>
          {[
            { label: 'rated', value: isOwn ? flavor.activeRatings : lifetimeRatings },
            { label: 'avg score', value: flavor.avgScore == null ? '—' : flavor.avgScore },
            { label: '5-star', value: flavor.fiveStar },
          ].map(({ label, value }) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>{String(value)}</div>
              <div style={{ fontSize: 9, color: 'var(--fg-dim)', marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
            </div>
          ))}
        </div>
        {isOwn && flavor.activeRatings !== undefined && lifetimeRatings > flavor.activeRatings && (
          <div style={{ fontSize: 10, color: 'var(--fg-faint)', textAlign: 'center', marginBottom: 4 }}>
            Wheel based on {flavor.activeRatings} of {lifetimeRatings} lifetime ratings.
          </div>
        )}
      </div>

      <div className="panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div className="panel-hdr" style={{ alignSelf: 'flex-start', width: '100%' }}>flavour profile</div>
        <div
          ref={wheelRef}
          onClick={() => openWheelLightbox(wheelRef, `${profileUserName}'s flavour profile`)}
          style={{ cursor: 'zoom-in' }}
          title="Click to expand"
        >
          <PolarChart flavors={flavors} fl={FL} size={CHART_SIZE.DETAIL} />
        </div>
        {topFlavors.length > 0 && (
          <div style={{ marginTop: 10, width: '100%' }}>
            <div className="panel-hdr">top flavours</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {topFlavors.map(f => (
                <span
                  key={f.k}
                  style={{
                    borderColor: f.c + '44', background: f.c + '18', color: f.c,
                    fontSize: 11, fontWeight: 700, padding: '4px 10px',
                    borderRadius: 999, border: '1px solid',
                  }}
                >
                  {f.l} {(flavors[f.k] || 0).toFixed(1)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
