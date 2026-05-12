'use client'
import { openLightbox } from '@/components/ui/ImageLightbox'
import { WineIdentity } from '@/components/wine/WineIdentity'
import { countryName } from '@/lib/countries'
import { renderWithLinks } from '@/lib/renderWithLinks'

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

interface Props {
  wine: WineDisplay
}

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

// Read-only display of wine identity + metadata. No actions — edit /
// move / delete live in step 6 on this surface, gated by caller role.
// Renders the same anywhere: in-session modal, /me/saved detail page,
// /u/<id> check-in card, feed post.
export function WineInfoPane({ wine }: Props) {
  const { name, producer, vintage, grape, type, imageUrl,
          description, region, country, vinification, purchaseUrl,
          addedByDisplayName } = wine
  const countryDisplay = country ? (countryName(country) || country) : ''
  const hasLocation = !!(region || countryDisplay)

  return (
    <>
      {imageUrl && (
        <img src={imageUrl} alt={name}
          onClick={() => openLightbox(imageUrl, name)}
          style={{width:'100%',maxHeight:180,objectFit:'cover',borderRadius:14,marginBottom:14,cursor:'zoom-in'}} />
      )}

      <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:14}}>
        <div style={{flex:1,minWidth:0}}>
          <WineIdentity wine={{name, vintage, producer, grape}} size="card" />
        </div>
        <span style={{fontSize:24,flexShrink:0,lineHeight:1}}>{ICO[type] || '🍷'}</span>
      </div>

      {description && (
        <div className="panel">
          <div className="panel-hdr">description</div>
          <p style={{fontSize:13,color:'var(--fg)',lineHeight:1.5,whiteSpace:'pre-wrap',margin:0}}>
            {renderWithLinks(description)}
          </p>
        </div>
      )}

      {hasLocation && (
        <div className="panel">
          <div className="panel-hdr">origin</div>
          <p style={{fontSize:13,color:'var(--fg)',margin:0}}>
            {region}{region && countryDisplay ? ' · ' : ''}{countryDisplay}
          </p>
        </div>
      )}

      {vinification && (
        <div className="panel">
          <div className="panel-hdr">vinification</div>
          <p style={{fontSize:13,color:'var(--fg)',lineHeight:1.5,whiteSpace:'pre-wrap',margin:0}}>
            {vinification}
          </p>
        </div>
      )}

      {purchaseUrl && /^https?:\/\//i.test(purchaseUrl) && (
        <div className="panel">
          <div className="panel-hdr">purchase link</div>
          <a href={purchaseUrl} target="_blank" rel="noopener noreferrer"
            style={{fontSize:12,color:'var(--accent)',wordBreak:'break-all'}}>
            {purchaseUrl}
          </a>
        </div>
      )}

      {addedByDisplayName && (
        <p style={{fontSize:11,color:'var(--fg-faint)',marginTop:14,marginBottom:0,textAlign:'center'}}>
          brought by {addedByDisplayName}
        </p>
      )}
    </>
  )
}
