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
    id: number
    wineName: string
    producer?: string | null
    vintage?: string | null
    type?: string | null
    score?: number | null
    notes?: string | null
    imageUrl?: string | null
    venueName?: string | null
    city?: string | null
    country?: string | null
    flavors?: Record<string, number> | null
    likeCount?: number
    createdAt?: string | Date | null
    tags?: { id: number; name: string }[]
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
  const locationParts = [checkin.venueName, checkin.city, checkin.country].filter(Boolean)
  const level = author?.xp != null ? getLevel(author.xp) : null
  const hasMedia = checkin.imageUrl || hasFlavors

  return (
    <div className="panel" style={{ marginBottom: 12, padding: '16px 16px 14px' }}>

      {/* ── Author row ─────────────────────────────── */}
      {showAuthor && author && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <Link href={`/u/${author.id}`} style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Avatar circle */}
            <div style={{
              width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
              background: 'rgba(200,150,60,0.18)', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 800, color: 'var(--accent)',
            }}>
              {author.name[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', lineHeight: 1.2 }}>{author.name}</div>
              {level && (
                <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 1 }}>
                  {level.icon} {level.name}
                </div>
              )}
            </div>
          </Link>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {checkin.createdAt && (
              <span style={{ fontSize: 11, color: 'var(--fg-dim)', fontFamily: 'var(--mono)' }}>
                {timeAgo(checkin.createdAt)}
              </span>
            )}
            {isOwn && onDelete && (
              <button onClick={onDelete}
                style={{ fontSize: 11, color: 'var(--fg-dim)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)' }}>
                delete
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Wine name + score ──────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--fg)', lineHeight: 1.1, margin: 0 }}>
            {checkin.wineName}
          </h2>
          {sub && (
            <div style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 3 }}>{sub}</div>
          )}
        </div>
        {checkin.score != null && checkin.score > 0 && (
          <div style={{ flexShrink: 0, textAlign: 'right', lineHeight: 1 }}>
            <span style={{ fontSize: 30, fontWeight: 800, color: 'var(--accent)' }}>{checkin.score}</span>
            <span style={{ fontSize: 13, color: 'var(--fg-dim)' }}>/5</span>
          </div>
        )}
      </div>

      {/* Location */}
      {locationParts.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12 }}>📍</span>
          {locationParts.join(', ')}
        </div>
      )}

      {/* Tagged friends */}
      {checkin.tags && checkin.tags.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>👥 with </span>
          {checkin.tags.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ', '}
              <a href={`/u/${t.id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{t.name}</a>
            </span>
          ))}
        </div>
      )}

      {/* ── Divider ────────────────────────────────── */}
      {hasMedia && (
        <div style={{ height: 1, background: 'var(--border)', margin: '10px 0 14px' }} />
      )}

      {/* ── Photo + Wheel ──────────────────────────── */}
      {hasMedia && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 200 }}>

          {/* Bottle photo — full contain, whole bottle visible */}
          {checkin.imageUrl ? (
            <div style={{
              flex: '0 0 44%', borderRadius: 12, overflow: 'hidden',
              background: 'var(--bg3)', cursor: 'zoom-in',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minHeight: 200,
            }}
              onClick={() => openLightbox(checkin.imageUrl!, checkin.wineName)}
            >
              <img
                src={checkin.imageUrl}
                alt={checkin.wineName}
                style={{ width: '100%', maxHeight: 320, objectFit: 'contain', display: 'block', borderRadius: 10 }}
              />
            </div>
          ) : (
            hasFlavors && (
              <div style={{ flex: '0 0 44%', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, background: 'var(--bg3)', borderRadius: 12 }}>
                <span style={{ fontSize: 56 }}>{ICO[checkin.type || ''] || '🍷'}</span>
              </div>
            )
          )}

          {/* Polar chart */}
          {hasFlavors && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <PolarChart
                flavors={checkin.flavors as Record<string, number>}
                fl={fl}
                size={200}
              />
            </div>
          )}

          {/* No flavors but has image — show placeholder where wheel would be */}
          {checkin.imageUrl && !hasFlavors && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 48, opacity: 0.2 }}>{ICO[checkin.type || ''] || '🍷'}</span>
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {checkin.notes && (
        <p style={{
          fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic',
          lineHeight: 1.6, margin: hasMedia ? '12px 0 0' : '8px 0 0',
          borderTop: hasMedia ? '1px solid var(--border)' : 'none',
          paddingTop: hasMedia ? 10 : 0,
        }}>
          &ldquo;{checkin.notes}&rdquo;
        </p>
      )}

      {/* ── Like ───────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        <LikeButton checkinId={checkin.id} initialLiked={liked} initialCount={checkin.likeCount ?? 0} />
      </div>
    </div>
  )
}
