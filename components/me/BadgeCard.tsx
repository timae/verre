import { RARITY_COLOR, type Rarity } from '@/lib/badges'

export type BadgeCardData = {
  id: string; name: string; description: string; icon: string
  rarity: Rarity; xp_reward: number
  earned: boolean; earned_at: string | Date | null
  // Optional — only meaningful for the viewer's own badges page.
  seen?: boolean
}

export function BadgeCard({ badge }: { badge: BadgeCardData }) {
  const rarityColor = RARITY_COLOR[badge.rarity]
  const isNew = badge.earned && badge.seen === false
  return (
    <div style={{
      position:'relative',
      padding:'12px 10px',
      borderRadius:14,
      border:`1px solid ${badge.earned ? rarityColor + '55' : 'var(--border)'}`,
      background: badge.earned ? rarityColor + '0F' : 'rgba(255,255,255,0.015)',
      opacity: badge.earned ? 1 : 0.45,
    }}>
      {isNew && (
        <div style={{position:'absolute',top:8,right:8,width:7,height:7,borderRadius:'50%',background:'var(--accent)',boxShadow:'0 0 0 2px rgba(200,150,60,0.3)'}} />
      )}
      <div style={{fontSize:28,lineHeight:1,marginBottom:6}}>{badge.icon}</div>
      <div style={{fontSize:11,fontWeight:700,lineHeight:1.2,marginBottom:3,color: badge.earned ? 'var(--fg)' : 'var(--fg-dim)'}}>{badge.name}</div>
      <div style={{fontSize:9,color:'var(--fg-faint)',lineHeight:1.4}}>{badge.description}</div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:8}}>
        <span style={{fontSize:8,letterSpacing:'0.1em',textTransform:'uppercase',color:rarityColor,fontWeight:700}}>{badge.rarity}</span>
        <span style={{fontSize:9,color:'var(--accent)',fontFamily:'var(--mono)'}}>+{badge.xp_reward} xp</span>
      </div>
      {badge.earned && badge.earned_at && (
        <div style={{fontSize:8,color:'var(--fg-faint)',marginTop:4}}>
          {new Date(badge.earned_at).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}
        </div>
      )}
    </div>
  )
}
