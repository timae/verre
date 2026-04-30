import type { WineMeta } from '@/lib/session'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }
const TCOL: Record<string, string> = { red:'#B84040', white:'#C8A84B', spark:'#7AAFC8', rose:'#C86880', nonalc:'#6AAA82' }

interface Props { wine: WineMeta; score?: number; index?: number; onClick?: () => void }

export function WineCard({ wine, score, index, onClick }: Props) {
  const sub = [wine.producer, wine.vintage, wine.grape].filter(Boolean).join(' · ')
  const accentColor = TCOL[wine.type] || TCOL.red

  return (
    <button onClick={onClick} className="wine-card" style={{width:'100%',textAlign:'left'}}>
      {/* type accent bar */}
      <div style={{position:'absolute',left:0,top:0,bottom:0,width:2,background:accentColor,opacity:0.6}} />
      {index != null && (
        <div style={{width:24,flexShrink:0,textAlign:'right',fontFamily:'var(--mono)',fontSize:18,fontWeight:700,color:'var(--fg-faint)',lineHeight:1}}>{index + 1}</div>
      )}
      {wine.imageUrl ? (
        <img src={wine.imageUrl} alt={wine.name} style={{width:38,height:38,borderRadius:8,objectFit:'cover',flexShrink:0}} />
      ) : (
        <div style={{width:38,height:38,borderRadius:8,background:'var(--bg3)',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18}}>
          {ICO[wine.type] || '🍷'}
        </div>
      )}
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:13,color:'var(--fg)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{wine.name}</div>
        {sub && <div style={{fontSize:10,color:'var(--fg-dim)',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sub}</div>}
      </div>
      {score != null && score > 0 && (
        <div style={{flexShrink:0,textAlign:'right'}}>
          <span style={{fontSize:22,fontWeight:800,color:'var(--accent)',lineHeight:1}}>{score}</span>
          <span style={{fontSize:10,color:'var(--fg-dim)'}}>/5</span>
        </div>
      )}
    </button>
  )
}
