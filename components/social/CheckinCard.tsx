'use client'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { CheckinModal } from './CheckinModal'
import { PolarChart } from '@/components/charts/PolarChart'
import { CHART_SIZE } from '@/components/charts/sizes'
import { LikeButton } from './LikeButton'
import { detectFL, getFL } from '@/lib/flavours'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { getLevel } from '@/lib/badges'
import { timeAgo } from '@/lib/timeAgo'
import { WineIdentity } from '@/components/wine/WineIdentity'

function openWheelLightbox(ref: React.RefObject<HTMLDivElement | null>, label: string) {
  const svg = ref.current?.querySelector('svg')
  if (!svg) return
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light'
  const bg = isDark ? '#0E0E0C' : '#F6F0E6'
  const clone = svg.cloneNode(true) as SVGElement
  clone.setAttribute('style', `background:${bg};border-radius:16px;padding:24px;`)
  const data = new XMLSerializer().serializeToString(clone)
  const blob = new Blob([data], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  openLightbox(url, label + ' — flavour profile')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

interface Props {
  checkin: {
    id: number; wineName: string; producer?: string|null; vintage?: string|null
    grape?: string|null; type?: string|null; score?: number|null; notes?: string|null; imageUrl?: string|null
    venueName?: string|null; city?: string|null; country?: string|null
    flavors?: Record<string,number>|null; likeCount?: number
    createdAt?: string|Date|null; tags?: {id:number;name:string}[]
  }
  author?: {id:number;name:string;xp?:number}|null
  liked?: boolean; showAuthor?: boolean; onDelete?: ()=>void; isOwn?: boolean
}

export function CheckinCard({ checkin, author, liked=false, showAuthor=true, onDelete, isOwn }: Props) {
  const fl = checkin.flavors && Object.keys(checkin.flavors).length
    ? detectFL(checkin.flavors as Record<string,number>)
    : getFL(checkin.type || 'white')

  const hasFlavors = checkin.flavors && Object.values(checkin.flavors).some(v => v > 0)
  const wheelRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  // Map check-in's wineName field onto the {name, ...} shape WineIdentity expects.
  const wineForId = { name: checkin.wineName, vintage: checkin.vintage, producer: checkin.producer, grape: checkin.grape }
  const locationParts = [checkin.venueName, checkin.city, checkin.country].filter(Boolean)
  const level = author?.xp != null ? getLevel(author.xp) : null
  const hasMedia = checkin.imageUrl || hasFlavors

  return (
    <div className="panel" style={{ marginBottom: 12, padding: '16px 16px 14px' }}>

      {/* ── Author row ─────────────────────────── */}
      {showAuthor && author && (
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
          <Link href={`/u/${author.id}`} style={{ textDecoration:'none', display:'flex', alignItems:'center', gap:10 }}>
            <div style={{
              width:40, height:40, borderRadius:'50%', flexShrink:0,
              background:'rgba(200,150,60,0.18)', display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:17, fontWeight:800, color:'var(--accent)',
            }}>
              {author.name[0].toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--fg)', lineHeight:1.2 }}>{author.name}</div>
              {level && <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:1 }}>{level.icon} {level.name}</div>}
            </div>
          </Link>
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
            {checkin.createdAt && (
              <span style={{ fontSize:11, color:'var(--fg-dim)', fontFamily:'var(--mono)' }}>{timeAgo(checkin.createdAt)}</span>
            )}
            {isOwn && (
              <button onClick={() => setEditing(true)}
                style={{ fontSize:11, color:'var(--accent)', background:'none', border:'none', cursor:'pointer', fontFamily:'var(--mono)' }}>
                edit
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Main body: photo left + info+wheel right ─ */}
      {hasMedia ? (
        <div style={{ display:'flex', gap:12, alignItems:'stretch' }}>

          {/* Left: bottle photo */}
          {checkin.imageUrl ? (
            <div
              onClick={() => openLightbox(checkin.imageUrl!, checkin.wineName)}
              style={{
                flex:'0 0 42%', borderRadius:12, overflow:'hidden',
                background:'var(--bg3)', cursor:'zoom-in',
                display:'flex', alignItems:'center', justifyContent:'center',
                minHeight:200,
              }}
            >
              <img
                src={checkin.imageUrl} alt={checkin.wineName}
                style={{ width:'100%', maxHeight:360, objectFit:'contain', display:'block' }}
              />
            </div>
          ) : hasFlavors ? (
            /* No photo — emoji placeholder so wheel has a left partner */
            <div style={{
              flex:'0 0 42%', borderRadius:12, background:'var(--bg3)',
              display:'flex', alignItems:'center', justifyContent:'center', minHeight:200,
            }}>
              <span style={{ fontSize:56, opacity:0.25 }}>{ICO[checkin.type||'']||'🍷'}</span>
            </div>
          ) : null}

          {/* Right: name + score + location + divider + wheel */}
          <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column' }}>

            {/* Wine name + score */}
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8, marginBottom:4 }}>
              <div style={{ minWidth:0 }}>
                <WineIdentity wine={wineForId} size="hero" />
              </div>
              {checkin.score != null && checkin.score > 0 && (
                <div style={{ flexShrink:0, lineHeight:1 }}>
                  <span style={{ fontSize:28, fontWeight:800, color:'var(--accent)' }}>{checkin.score}</span>
                  <span style={{ fontSize:12, color:'var(--fg-dim)' }}>/5</span>
                </div>
              )}
            </div>

            {/* Location */}
            {locationParts.length > 0 && (
              <div style={{ fontSize:11, color:'var(--fg-dim)', marginBottom:6, display:'flex', alignItems:'center', gap:3 }}>
                <span>📍</span>{locationParts.join(', ')}
              </div>
            )}

            {/* Tagged */}
            {checkin.tags && checkin.tags.length > 0 && (
              <div style={{ fontSize:10, color:'var(--fg-dim)', marginBottom:6 }}>
                👥 with {checkin.tags.map((t,i) => (
                  <span key={t.id}>{i>0&&', '}<a href={`/u/${t.id}`} style={{ color:'var(--accent)', textDecoration:'none' }}>{t.name}</a></span>
                ))}
              </div>
            )}

            {/* Divider */}
            {hasFlavors && <div style={{ height:1, background:'var(--border)', margin:'6px 0 8px' }} />}

            {/* Polar wheel — click to expand */}
            {hasFlavors && (
              <div
                ref={wheelRef}
                onClick={() => openWheelLightbox(wheelRef, checkin.wineName)}
                style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', cursor:'zoom-in' }}
                title="Click to expand"
              >
                <PolarChart flavors={checkin.flavors as Record<string,number>} fl={fl} size={CHART_SIZE.THUMB} />
              </div>
            )}
          </div>
        </div>
      ) : (
        /* No media at all — just text layout */
        <div>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, marginBottom:4 }}>
            <div style={{ flex:1, minWidth:0 }}>
              <WineIdentity wine={wineForId} size="card" />
            </div>
            {checkin.score != null && checkin.score > 0 && (
              <div style={{ flexShrink:0 }}>
                <span style={{ fontSize:28, fontWeight:800, color:'var(--accent)' }}>{checkin.score}</span>
                <span style={{ fontSize:12, color:'var(--fg-dim)' }}>/5</span>
              </div>
            )}
          </div>
          {locationParts.length > 0 && (
            <div style={{ fontSize:11, color:'var(--fg-dim)', display:'flex', alignItems:'center', gap:3 }}>
              <span>📍</span>{locationParts.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {checkin.notes && (
        <p style={{
          fontSize:12, color:'var(--fg-dim)', fontStyle:'italic',
          lineHeight:1.6, marginTop:12,
          borderTop:'1px solid var(--border)', paddingTop:10,
        }}>
          &ldquo;{checkin.notes}&rdquo;
        </p>
      )}

      {/* Like */}
      <div style={{ marginTop:12 }}>
        <LikeButton checkinId={checkin.id} initialLiked={liked} initialCount={checkin.likeCount??0} />
      </div>

      {editing && (
        <CheckinModal
          editCheckin={checkin as Parameters<typeof CheckinModal>[0]['editCheckin']}
          onClose={() => setEditing(false)}
          onPosted={() => { setEditing(false); window.location.reload() }}
          onDelete={onDelete ? () => { setEditing(false); onDelete() } : undefined}
        />
      )}
    </div>
  )
}
