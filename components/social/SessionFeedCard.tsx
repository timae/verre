'use client'
// Aggregate session card. Renders a `kind='session'` feed_item: header
// (author byline + session name + host) and a per-wine list of the
// wines the author rated in that session.
//
// Replaces the phase-2 `'session_stub'` placeholder. Likes + tags
// attach to the card as a whole, NOT per wine — Instagram's "like the
// post, not each photo" model.
//
// Tombstoned-session collapse: when `session.deleted` is true, the
// per-wine list is hidden and a single "[deleted session]" label
// renders. The post itself still exists (data is preserved); only
// the session-level identity is scrubbed.
//
// Blind redaction is APPLIED SERVER-SIDE — `wine._blind = true`
// arrives pre-blanked. The renderer just shows the mystery slot
// instead of the wine identity.

import { useRef, useState } from 'react'
import Link from 'next/link'
import { Avatar } from '@/components/profile/Avatar'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { StarRating } from '@/components/ui/StarRating'
import { AromaReadChips } from '@/components/ui/AromaReadChips'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { LikeButton } from './LikeButton'
import { perRatingAxes, resolveAxesColoured } from '@/lib/flavours'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { openWheelLightbox } from '@/components/charts/wheelLightbox'
import { getLevel } from '@/lib/badges'
import { timeAgo } from '@/lib/timeAgo'
import { ICO } from '@/lib/wineTypeColors'
import type { SessionFeedPayload, SessionFeedWine } from '@/lib/feedTypes'

interface Props {
  session: SessionFeedPayload
  author: { id: number; name: string; xp?: number; imageUrl?: string|null }
  createdAt?: string|Date|null
  showAuthor?: boolean
}

export function SessionFeedCard({ session, author, createdAt, showAuthor = true }: Props) {
  const level = author.xp != null ? getLevel(author.xp) : null

  return (
    <div className="panel" style={{ marginBottom: 12, padding: '16px 16px 14px' }}>

      {/* Author row — same shape as CheckinCard's byline */}
      {showAuthor && (
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
          <Link href={`/u/${author.id}`} style={{ textDecoration:'none', display:'flex', alignItems:'center', gap:10 }}>
            <Avatar name={author.name} imageUrl={author.imageUrl} size={40} />
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--fg)', lineHeight:1.2 }}>{author.name}</div>
              {level && <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:1 }}>{level.icon} {level.name}</div>}
            </div>
          </Link>
          {createdAt && (
            <span style={{ marginLeft:'auto', fontSize:11, color:'var(--fg-dim)', fontFamily:'var(--mono)' }}>{timeAgo(createdAt)}</span>
          )}
        </div>
      )}

      {/* Session header: name + host. Tombstoned variant collapses to label. */}
      <SessionHeader session={session} />

      {/* Per-wine list. Tombstoned sessions still show their wines (the
          post is a record of what the user tasted); only the session's
          name + host get the "[deleted]" treatment in the header. */}
      {session.wines.length > 0 && (
        <div style={{ marginTop:14, display:'flex', flexDirection:'column', gap:14 }}>
          {session.wines.map((w, i) => (
            <WineRow key={w.id} wine={w} index={i} />
          ))}
        </div>
      )}

      {/* Like — card-level. Always rendered (the post exists even when
          the session is tombstoned). */}
      <div style={{ marginTop:12 }}>
        <LikeButton feedItemId={session.id} initialLiked={session.liked} initialCount={session.likeCount} />
      </div>
    </div>
  )
}

function SessionHeader({ session }: { session: SessionFeedPayload }) {
  if (session.deleted) {
    return (
      <div style={{ fontSize:13, color:'var(--fg-dim)', fontStyle:'italic' }}>
        [deleted session]
      </div>
    )
  }
  const name = session.sessionName || 'Untitled session'
  const host = session.hostName
  return (
    <div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--fg)', lineHeight:1.3 }}>
        {name}
      </div>
      {host && (
        <div style={{ fontSize:11, color:'var(--fg-dim)', marginTop:2 }}>
          hosted by {host}
        </div>
      )}
    </div>
  )
}

// Per-wine row inside a session card. Compact version of CheckinCard's
// body — shares the photo-left + identity+wheel-right layout but tighter.
// Blind-redacted wines render as a mystery slot; their score and chips
// are still shown (the user's own data, never redacted).
function WineRow({ wine, index }: { wine: SessionFeedWine; index: number }) {
  const wheelRef = useRef<HTMLDivElement>(null)
  // S3 reclaim on session-delete or rating-delete can leave wine.imageUrl
  // pointing at a dead key. Fall back to the type-icon placeholder when the
  // browser fails to load the image.
  const [imgFailed, setImgFailed] = useState(false)
  const showImage = !!wine.imageUrl && !imgFailed
  const hasFlavors = wine.flavors && Object.values(wine.flavors).some(v => v > 0)
  // Read surface (§6d): per-present-key array (registry order). Only used when
  // hasFlavors is true.
  const fl = perRatingAxes(wine.flavors, resolveAxesColoured('wine', wine.type || 'white'))

  if (wine._blind) {
    // Mystery slot — wine identity hidden; user's score / chips / notes still
    // visible (their own data). Matches the live session view: 🙈 icon +
    // "Wine N" copy (no #, per lib/wineRedaction.ts:39 which is the
    // canonical label generator for the live route).
    const blindLabel = `Wine ${index + 1}`
    return (
      <div style={{ display:'flex', gap:12, padding:'10px 0', borderTop:'1px solid var(--border)' }}>
        <div style={{
          flex:'0 0 30%', minHeight:80, borderRadius:10, background:'var(--bg3)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <span style={{ fontSize:36, opacity:0.35 }}>🙈</span>
        </div>
        <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:4 }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--fg-dim)', fontStyle:'italic' }}>
              {blindLabel}
            </div>
            {wine.score ? <div style={{ flexShrink:0 }}><StarRating value={wine.score} size="compact" /></div> : null}
          </div>
          {hasFlavors && (
            <div ref={wheelRef} onClick={() => openWheelLightbox(wheelRef, blindLabel)}
              style={{ marginTop:4, display:'flex', alignItems:'center', justifyContent:'flex-start', cursor:'zoom-in' }}>
              <PolarChart flavors={wine.flavors} fl={fl} size={CHART_SIZE.DETAIL} />
            </div>
          )}
          {/* Aromas render on a blind wine exactly like score/flavors — the
              taster's own perception, never identity (aroma-layer.md §7). */}
          <AromaReadChips aromas={wine.aromas} style={{ marginTop:4 }} />
          {wine.notes && (
            <p style={{ fontSize:11, color:'var(--fg-dim)', fontStyle:'italic', lineHeight:1.5, marginTop:4 }}>
              &ldquo;{wine.notes}&rdquo;
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', gap:12, padding:'10px 0', borderTop:'1px solid var(--border)' }}>
      {/* Photo / icon placeholder. Falls back to the icon when the image
          URL 404s (e.g. wine bytes reclaimed on session delete). */}
      <div style={{
        flex:'0 0 30%', minHeight:80, borderRadius:10, background:'var(--bg3)', overflow:'hidden',
        display:'flex', alignItems:'center', justifyContent:'center',
        cursor: showImage ? 'zoom-in' : 'default',
      }}
        onClick={showImage ? () => openLightbox(wine.imageUrl!, wine.name) : undefined}
      >
        {showImage ? (
          <img src={wine.imageUrl!} alt={wine.name} onError={() => setImgFailed(true)}
            style={{ width:'100%', maxHeight:160, objectFit:'contain', display:'block' }} />
        ) : (
          <span style={{ fontSize:36, opacity:0.25 }}>{ICO[wine.type||'']||'🍷'}</span>
        )}
      </div>

      {/* Identity + score + wheel + notes */}
      <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:4 }}>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
          <div style={{ minWidth:0, flex:1 }}>
            <WineIdentity wine={{ name: wine.name, vintage: wine.vintage, producer: wine.producer, grape: wine.grape }} size="card" />
          </div>
          {wine.score ? <div style={{ flexShrink:0 }}><StarRating value={wine.score} size="detail" /></div> : null}
        </div>
        {hasFlavors && (
          <div ref={wheelRef} onClick={() => openWheelLightbox(wheelRef, wine.name)}
            style={{ marginTop:4, display:'flex', alignItems:'center', justifyContent:'flex-start', cursor:'zoom-in' }}>
            <PolarChart flavors={wine.flavors} fl={fl} size={CHART_SIZE.DETAIL} />
          </div>
        )}
        <AromaReadChips aromas={wine.aromas} style={{ marginTop:4 }} />
        {wine.notes && (
          <p style={{ fontSize:11, color:'var(--fg-dim)', fontStyle:'italic', lineHeight:1.5, marginTop:4 }}>
            &ldquo;{wine.notes}&rdquo;
          </p>
        )}
      </div>
    </div>
  )
}
