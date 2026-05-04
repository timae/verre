'use client'
import Link from 'next/link'
import { PolarChart } from '@/components/charts/PolarChart'
import { LikeButton } from './LikeButton'
import { detectFL, getFL } from '@/lib/flavours'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { getLevel } from '@/lib/badges'
import { timeAgo } from '@/lib/timeAgo'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

interface Props {
  checkin: {
    id: number; wineName: string; producer?: string | null; vintage?: string | null
    type?: string | null; score?: number | null; notes?: string | null; imageUrl?: string | null
    venueName?: string | null; city?: string | null; country?: string | null
    flavors?: Record<string, number> | null; likeCount?: number; createdAt?: string | Date | null; tags?: { id: number; name: string }[]
  }
  author?: { id: number; name: string; xp?: number } | null
  liked?: boolean
  showAuthor?: boolean
  onDelete?: () => void
  isOwn?: boolean
}

export function CheckinCard({ checkin, author, liked = false, showAuthor = true, onDelete, isOwn }: Props) {
  const fl = checkin.flavors && Object.keys(checkin.flavors).length
    ? detectFL(checkin.flavors as Record<string, number>)
    : getFL(checkin.type || 'white')

  const hasFlavors = checkin.flavors && Object.values(checkin.flavors).some(v => v > 0)
  const sub = [checkin.producer, checkin.vintage].filter(Boolean).join(' · ')
  const locationStr = [checkin.venueName, checkin.city, checkin.country].filter(Boolean).join(', ')
  const level = author?.xp != null ? getLevel(author.xp) : null

  return (
    <div className="panel" style={{ marginBottom: 10 }}>
      {/* Author row */}
      {showAuthor && author && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Link href={`/u/${author.id}`} style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(200,150,60,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }}>
              {author.name[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>{author.name}</div>
              {level && <div style={{ fontSize: 9, color: 'var(--fg-faint)', letterSpacing: '0.06em' }}>{level.icon} {level.name}</div>}
            </div>
          </Link>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {checkin.createdAt && (
              <span style={{ fontSize: 9, color: 'var(--fg-faint)', fontFamily: 'var(--mono)', letterSpacing: '0.04em' }}>
                {timeAgo(checkin.createdAt)}
              </span>
            )}
            {isOwn && onDelete && (
              <button onClick={onDelete} style={{ fontSize: 9, color: 'var(--fg-faint)', background: 'none', border: 'none', cursor: 'pointer' }}>delete</button>
            )}
          </div>
        </div>
      )}

      {/* Photo */}
      {checkin.imageUrl && (
        <img src={checkin.imageUrl} alt={checkin.wineName}
          onClick={() => openLightbox(checkin.imageUrl!, checkin.wineName)}
          style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 10, marginBottom: 10, cursor: 'zoom-in' }} />
      )}

      {/* Wine info */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 22 }}>{ICO[checkin.type || ''] || '🍷'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>{checkin.wineName}</div>
          {sub && <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 2 }}>{sub}</div>}
          {locationStr && <div style={{ fontSize: 10, color: 'var(--fg-faint)', marginTop: 2 }}>📍 {locationStr}</div>}
          {checkin.tags && checkin.tags.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
              👥 with {checkin.tags.map((t, i) => (
                <span key={t.id}>{i > 0 ? ', ' : ''}<a href={`/u/${t.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{t.name}</a></span>
              ))}
            </div>
          )}
        </div>
        {checkin.score != null && checkin.score > 0 && (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--accent)', lineHeight: 1 }}>{checkin.score}</span>
            <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>/5</span>
          </div>
        )}
      </div>

      {/* Polar chart */}
      {hasFlavors && (
        <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 8px' }}>
          <PolarChart flavors={checkin.flavors as Record<string, number>} fl={fl} size={180} />
        </div>
      )}

      {/* Notes */}
      {checkin.notes && (
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic', lineHeight: 1.6, marginBottom: 8 }}>
          &ldquo;{checkin.notes}&rdquo;
        </p>
      )}

      {/* Like */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <LikeButton checkinId={checkin.id} initialLiked={liked} initialCount={checkin.likeCount ?? 0} />
      </div>
    </div>
  )
}
