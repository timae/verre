'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { countryName } from '@/lib/countries'
import { renderWithLinks } from '@/lib/renderWithLinks'
import { TYPE_LABEL, tcolAlpha } from '@/lib/wineTypeColors'
import { WineGlass, PinIcon, FlaskIcon, LinkIcon, ArrowRightIcon } from '@/components/ui/icons'
import { Avatar } from '@/components/profile/Avatar'

// Normalized wine-display shape — what the info pane reads. Session
// WireWine satisfies this directly; future check-in / bookmark / feed
// surfaces can adapt their row shapes to this with a thin mapper.
export type WineDisplay = {
  name: string
  producer?: string
  vintage?: string | null
  grape?: string
  type: string
  imageUrl?: string
  description?: string
  region?: string
  country?: string  // ISO 3166-1 alpha-2
  vinification?: string
  purchaseUrl?: string
  // Session-only provenance. null/absent for check-ins outside a session.
  addedByDisplayName?: string | null
}

// How to render the brought-by callout.
//   'clickable'    — logged-in adder, no block in either direction.
//                    Name renders bold + accent, taps fire onClick.
//                    Also used for the viewer's own wine (self) —
//                    clicking opens their own profile preview, same
//                    as the participants-list self-row.
//   'blocked-by-me'— viewer blocks adder. Still clickable so unblock
//                    is reachable via the inline preview. (No [blocked]
//                    prefix on this surface — see CLAUDE.md.)
//   'anon-style'   — mutual block OR adder blocks viewer. Renders
//                    plain (no bold, no link), indistinguishable from
//                    a normal anon participant.
//   'plain'        — non-clickable but still visible (anon adder,
//                    kicked-non-participant, non-session surface).
export type ProvenanceRenderMode = 'clickable' | 'blocked-by-me' | 'anon-style' | 'plain'

interface Props {
  wine: WineDisplay
  // Click handler for the brought-by name. When omitted, name renders
  // plain regardless of `provenanceMode`. Caller (session modal) owns
  // what happens — inline preview, navigation to /u/<id>, etc.
  onProvenanceClick?: () => void
  provenanceMode?: ProvenanceRenderMode
  // Optional slot rendered below the brought-by callout. Caller uses
  // this to mount <ProfilePreviewInline> when the user clicks the
  // name. Kept as a prop slot rather than internal state so the
  // pane doesn't need to know about session context.
  provenancePreview?: React.ReactNode
  // Ref attached to the brought-by callout wrapper. Caller uses this
  // to scroll the callout into view when the preview opens, so the
  // expanded content isn't off-screen on long info panes.
  broughtByRef?: React.RefObject<HTMLDivElement | null>
  // True when the adder is the viewer themselves. Renders a small
  // "· you" suffix after the name, same convention as the
  // participants-list self-row.
  isSelf?: boolean
  // Adder's avatar URL. Gated upstream by block + profile-visibility
  // tier (server-side, in /api/session/<C>) and additionally clamped to
  // provenanceMode==='clickable' by the caller. When null, the badge
  // falls back to the initial letter — same visual as anon participants,
  // no-avatar users, blocked-pair, and tier-denied cases (the absence
  // can mean any of these, so no single inference works).
  addedByImageUrl?: string | null
}

// Read-only display of wine identity + metadata. v4 editorial layout:
// image → hero (serif title, "by" producer, vintage chip + grape +
// type-color swatch) → brought-by callout → quoted description in
// serif → facts list with hairline dividers. Wine glass to the right
// of the hero, fill follows the wine type.
//
// Renders the same anywhere: in-session modal, /me/saved detail page,
// /u/<id> check-in card, feed post. Provenance ("brought by") only
// shows when the caller passes it — feed/profile callers omit it.
export function WineInfoPane({ wine, onProvenanceClick, provenanceMode = 'plain', provenancePreview, broughtByRef, isSelf = false, addedByImageUrl = null }: Props) {
  const { name, producer, vintage, grape, type, imageUrl,
          description, region, country, vinification, purchaseUrl,
          addedByDisplayName } = wine
  const countryDisplay = country ? (countryName(country) || country) : ''
  const hasOrigin = !!(region || countryDisplay)
  const liquidColor = tcolAlpha(type, 0.7)

  return (
    <div className="wine-layout">

      {/* Media column — left on desktop, top on mobile (only when imageUrl).
          Fixed width on desktop so switching between wines with/without images
          doesn't shift the right column. Glass shown here on desktop when no
          image; glass in hero handles mobile (hidden on desktop via CSS). */}
      <div className={`wine-layout-media${imageUrl ? ' has-image' : ''}`}>
        {imageUrl ? (
          <div
            className="wine-layout-media-img"
            onClick={() => openLightbox(imageUrl, name)}
          >
            <img src={imageUrl} alt={name}
              style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}} />
          </div>
        ) : (
          <div style={{display:'flex',justifyContent:'center',paddingTop:8,opacity:0.85}} aria-hidden="true">
            <WineGlass type={type} fillColor={liquidColor} width={120} height={180} />
          </div>
        )}
      </div>

      {/* Content column — right on desktop, full-width on mobile */}
      <div className="wine-layout-content">

      {/* Hero — wine identity. Title in Fraunces, producer in sans,
          vintage chip + colored swatch + grape + type label. Glass on
          the right (mobile only — hidden on desktop, lives in media col). */}
      <header style={{
        display:'flex',alignItems:'flex-start',gap:18,
        paddingBottom:18,borderBottom:'1px solid var(--border)',
      }}>
        <div style={{flex:1,minWidth:0}}>
          <h1 style={{
            fontFamily:'var(--serif)',
            fontSize:34,lineHeight:1.05,
            margin:0,fontWeight:600,
            color:'var(--fg-warm)',
            letterSpacing:'-0.02em',
            wordBreak:'break-word',
          }}>{name}</h1>

          {producer && (
            <div style={{display:'flex',alignItems:'baseline',gap:8,marginTop:10}}>
              <span style={{
                fontSize:10,color:'var(--fg-faint)',
                letterSpacing:'0.16em',textTransform:'uppercase',fontWeight:600,
              }}>by</span>
              <span style={{
                fontSize:15,color:'var(--fg)',fontWeight:500,
                wordBreak:'break-word',
              }}>{producer}</span>
            </div>
          )}

          <div style={{display:'flex',alignItems:'center',gap:10,marginTop:12,flexWrap:'wrap'}}>
            {vintage && (
              <span style={{
                fontFamily:'var(--mono)',fontSize:11,fontWeight:600,
                letterSpacing:'0.08em',padding:'4px 8px',
                borderRadius:4,color:'var(--accent)',
                border:'1px solid rgba(200,150,60,0.35)',
              }}>{vintage}</span>
            )}
            {(grape || type) && (
              <>
                {vintage && <span style={{color:'var(--fg-faint)'}}>·</span>}
                <span style={{display:'inline-flex',alignItems:'center',gap:8}}>
                  <span style={{
                    width:8,height:8,borderRadius:2,flexShrink:0,
                    background:liquidColor,
                  }} />
                  {grape && (
                    <span style={{
                      fontFamily:'var(--serif)',fontStyle:'italic',
                      fontSize:14,color:'var(--fg)',
                    }}>{grape}</span>
                  )}
                  <span style={{
                    fontSize:9,letterSpacing:'0.18em',
                    color:'var(--fg-faint)',textTransform:'uppercase',fontWeight:600,
                  }}>{TYPE_LABEL[type] || type}</span>
                </span>
              </>
            )}
          </div>
        </div>

        <div className="wine-layout-glass-hero" style={{flexShrink:0,marginTop:-4,opacity:0.9}} aria-hidden="true">
          <WineGlass type={type} fillColor={liquidColor} />
        </div>
      </header>

      {/* Brought-by callout. Block-aware rendering mirrors
          SessionPanel's participants-list matrix. Click only fires
          when both the caller passed a handler AND the mode permits
          (clickable or blocked-by-me — both surface the inline
          preview, which carries the unblock affordance). */}
      {addedByDisplayName && (() => {
        const canClick = !!onProvenanceClick && (provenanceMode === 'clickable' || provenanceMode === 'blocked-by-me')
        // Bold + accent only when actually clickable (i.e. canClick).
        // The mode alone isn't enough — an anon viewer would get
        // provenanceMode='clickable' from the matrix (no blocks
        // matched) but no handler from the caller (anon can't click
        // profile previews), and we'd otherwise render a bold link
        // that does nothing. Tying isHighlighted to canClick keeps
        // the visual emphasis truthful.
        const isHighlighted = canClick && provenanceMode === 'clickable'
        return (
          <div ref={broughtByRef} style={{position:'relative'}}>
            <div
              onClick={canClick ? onProvenanceClick : undefined}
              onKeyDown={canClick ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onProvenanceClick && onProvenanceClick()
                }
              } : undefined}
              role={canClick ? 'button' : undefined}
              tabIndex={canClick ? 0 : undefined}
              style={{
                display:'flex',alignItems:'center',gap:12,
                padding:'10px 14px',
                background:'rgba(255,255,255,0.025)',
                border:'1px solid var(--border)',
                borderRadius:12,
                cursor: canClick ? 'pointer' : 'default',
                transition:'background .15s',
              }}
            >
              {/* Avatar always renders the circle. Real photo shows
                  only when the upstream gate passed (mode==='clickable'
                  + tier allows + no block): see addedByImageUrl prop
                  comment. Otherwise the Avatar primitive falls back to
                  the initial letter, indistinguishable from anon
                  participants, no-avatar users, and any denied case —
                  no single inference about block/tier survives. */}
              <Avatar
                name={addedByDisplayName || ''}
                imageUrl={addedByImageUrl}
                size={32}
              />
              <div style={{display:'flex',flexDirection:'column',gap:2,minWidth:0}}>
                <span style={{
                  fontSize:9,letterSpacing:'0.18em',textTransform:'uppercase',
                  color:'var(--fg-faint)',fontWeight:600,
                }}>Brought by</span>
                <span style={{
                  fontSize:13,
                  fontWeight: isHighlighted ? 700 : 400,
                  color: isHighlighted ? 'var(--accent)' : 'var(--fg)',
                }}>
                  {/* No `[blocked]` prefix on this surface — that
                      marker is reserved for the participants list
                      (SessionPanel). Block state shows up only
                      through the lack of clickability + plain (not
                      bold/accent) name styling. The viewer can still
                      reach unblock via the user's /u/<id> page or
                      Settings → Blocked users. */}
                  {addedByDisplayName}
                  {isSelf && (
                    <span style={{color:'var(--fg-dim)',fontWeight:400,marginLeft:6}}>· you</span>
                  )}
                </span>
              </div>
            </div>
            {provenancePreview && (
              // Floating preview — `position: absolute` so it overlays
              // the description / fact-row content below instead of
              // pushing them down. Overlap is the deliberate choice
              // for this surface: the preview is transient and the
              // user can dismiss it to read the content underneath.
              // The wrapper carries NO chrome (no background, border,
              // or radius) — ProfilePreviewInline brings its own
              // panel styling, and a second layer of chrome here
              // produced a visible "two stacked bubbles" effect.
              <div style={{
                position:'absolute',
                top:'calc(100% + 6px)',
                left:0,right:0,
                zIndex:10,
              }}>
                {provenancePreview}
              </div>
            )}
          </div>
        )
      })()}

      {/* Description — quoted, serif, no panel chrome */}
      {description && (
        <p style={{
          fontFamily:'var(--serif)',
          fontSize:17,lineHeight:1.55,
          color:'var(--fg-warm-soft)',
          margin:0,fontWeight:400,
        }}>
          <span style={{color:'var(--accent)',fontSize:22,verticalAlign:'-0.2em',marginRight:2,fontWeight:600,lineHeight:0}}>“</span>
          {renderWithLinks(description)}
          <span style={{color:'var(--accent)',fontSize:22,verticalAlign:'-0.2em',marginLeft:2,fontWeight:600,lineHeight:0}}>”</span>
        </p>
      )}

      {/* Facts — hairline-divided definition list. Each row is
          optional; only rendered when its data is present. */}
      {(hasOrigin || vinification || purchaseUrl) && (
        <dl style={{display:'flex',flexDirection:'column',margin:0,padding:0}}>
          {hasOrigin && (
            <FactRow icon={<PinIcon size={15} />} label="Origin">
              <span style={{color:'var(--fg-warm)'}}>{region}</span>
              {region && countryDisplay && <span style={{color:'var(--fg-faint)',margin:'0 4px'}}>·</span>}
              <span style={{color:'var(--fg-warm-soft)'}}>{countryDisplay}</span>
            </FactRow>
          )}
          {vinification && (
            <FactRow icon={<FlaskIcon size={15} />} label="Vinification">
              <span style={{color:'var(--fg-warm-soft)'}}>{vinification}</span>
            </FactRow>
          )}
          {purchaseUrl && /^https?:\/\//i.test(purchaseUrl) && (
            <FactRow icon={<LinkIcon size={15} />} label="Purchase">
              <a href={purchaseUrl} target="_blank" rel="noopener noreferrer" style={{
                color:'var(--accent)',textDecoration:'none',
                borderBottom:'1px dashed currentColor',paddingBottom:1,
                fontWeight:500,display:'inline-flex',alignItems:'center',gap:6,
              }}>
                {purchaseUrl.replace(/^https?:\/\//, '')}
                <ArrowRightIcon size={13} stroke={2} />
              </a>
            </FactRow>
          )}
        </dl>
      )}

      </div>
    </div>
  )
}

// Hairline-divided fact row — `[icon label]│ value`. Used for Origin,
// Vinification, Purchase. Likely worth extracting to components/ui/
// once a second surface (saved-wine detail page, feed card) needs it.
function FactRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display:'grid',
      gridTemplateColumns:'130px 1fr',
      gap:18,padding:'14px 0',
      borderTop:'1px solid var(--border)',
      alignItems:'baseline',
    }}>
      <dt style={{
        display:'flex',alignItems:'center',gap:8,
        fontSize:10,letterSpacing:'0.18em',textTransform:'uppercase',
        color:'var(--fg-dim)',fontWeight:600,margin:0,
      }}>
        <span style={{color:'var(--fg-faint)',display:'inline-flex'}}>{icon}</span>
        <span>{label}</span>
      </dt>
      <dd style={{margin:0,fontSize:14,lineHeight:1.55,color:'var(--fg-warm)'}}>{children}</dd>
    </div>
  )
}
