'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { countryName } from '@/lib/countries'
import { renderWithLinks } from '@/lib/renderWithLinks'
import { TYPE_LABEL, tcolAlpha } from '@/lib/wineTypeColors'
import { WineGlass, PinIcon, FlaskIcon, LinkIcon, ArrowRightIcon } from '@/components/ui/icons'

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
export function WineInfoPane({ wine, onProvenanceClick, provenanceMode = 'plain', provenancePreview, broughtByRef, isSelf = false }: Props) {
  const { name, producer, vintage, grape, type, imageUrl,
          description, region, country, vinification, purchaseUrl,
          addedByDisplayName } = wine
  const countryDisplay = country ? (countryName(country) || country) : ''
  const hasOrigin = !!(region || countryDisplay)
  const liquidColor = tcolAlpha(type, 0.7)
  const initial = (addedByDisplayName?.trim()[0] || '').toUpperCase()

  return (
    <div style={{display:'flex',flexDirection:'column',gap:20}}>

      {/* Image — rendered only when set. Empty wines skip it entirely
          (the hero's wine-glass decoration carries the visual presence). */}
      {imageUrl && (
        <div
          onClick={() => openLightbox(imageUrl, name)}
          style={{
            // Portrait 3:4 frame — wine bottles are taller than wide.
            // max-width capped so the computed height (= width × 4/3)
            // doesn't dominate the modal on wide viewports.
            width:'100%',maxWidth:260,aspectRatio:'3 / 4',
            borderRadius:14,overflow:'hidden',
            border:'1px solid var(--border)',
            cursor:'zoom-in',
            margin:'0 auto',
            background:'var(--bg3)',
          }}
        >
          <img src={imageUrl} alt={name}
            style={{width:'100%',height:'100%',objectFit:'cover',display:'block'}} />
        </div>
      )}

      {/* Hero — wine identity. Title in Fraunces, producer in sans,
          vintage chip + colored swatch + grape + type label. Glass on
          the right, filled with the wine-type liquid color. */}
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

        <div style={{flexShrink:0,marginTop:-4,opacity:0.9}} aria-hidden="true">
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
              {/* Avatar always shows the initial — including for
                  anon-style (mutual block / blocked-viewing-blocker).
                  The blocked side must be indistinguishable from a
                  regular anon participant; since anon users render
                  with an initial-letter avatar, dropping the avatar
                  here would itself signal "this is a blocked user,"
                  exactly the inference we're meant to prevent.
                  docs/block.md's "no avatar" line is from before anon
                  users had avatars and needs the matching update on
                  the participants-list side too. */}
              <div style={{
                width:32,height:32,borderRadius:'50%',
                background:'rgba(200,150,60,0.18)',
                border:'2px solid var(--bg2)',
                color:'var(--accent)',
                display:'inline-flex',alignItems:'center',justifyContent:'center',
                fontSize:13,fontWeight:700,flexShrink:0,
              }}>{initial}</div>
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
              // Floating preview — `position: absolute` so it sits on
              // top of the description / fact-row content below
              // instead of pushing them down. The 6px top offset
              // visually anchors it to the callout. z-index keeps it
              // above the rest of the pane content; the modal's own
              // backdrop sits above this via its own z-layer.
              <div style={{
                position:'absolute',
                top:'calc(100% + 6px)',
                left:0,right:0,
                zIndex:10,
                background:'var(--bg2)',
                border:'1px solid var(--border)',
                borderRadius:12,
                boxShadow:'0 12px 32px -8px rgba(0,0,0,0.6)',
                overflow:'hidden',
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
