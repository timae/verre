'use client'
import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LEVELS, getLevel, RARITY_ORDER, type Rarity } from '@/lib/badges'
import { authedFetch } from '@/lib/authedFetch'
import { formatNumber } from '@/lib/formatNumber'
import { BadgeCard } from './BadgeCard'

type BadgeWithStatus = {
  id: string; name: string; description: string; icon: string
  category: string; rarity: Rarity; xp_reward: number
  earned: boolean; earned_at: string | null; seen: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  first_steps: '✦ First Steps',
  quantity:    '◉ Volume',
  types:       '🍇 Wine Types',
  scoring:     '⭐ Scoring',
  flavour:     '👅 Flavour Fanatics',
  social:      '🤝 Social',
  craft:       '✍️ Craft',
  loyalty:     '📅 Loyalty',
}

export function BadgesClient() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ badges: BadgeWithStatus[]; xp: number; unseenCount: number }>({
    queryKey: ['me-badges'],
    queryFn: () => authedFetch<{ badges: BadgeWithStatus[]; xp: number; unseenCount: number }>('/api/me/badges'),
  })

  const markSeen = useMutation({
    mutationFn: () => authedFetch<{ ok: boolean }>('/api/me/badges', { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me-badges'] }),
  })

  useEffect(() => {
    if (data?.unseenCount && data.unseenCount > 0) {
      markSeen.mutate()
    }
  }, [data?.unseenCount]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p style={{color:'var(--fg-dim)',fontSize:13}}>Loading…</p>
  if (!data) return null

  const level = getLevel(data.xp)
  const nextXP = level.nextXP
  const progress = nextXP ? ((data.xp - level.minXP) / (nextXP - level.minXP)) * 100 : 100
  const earnedCount = data.badges.filter(b => b.earned).length
  const totalCount = data.badges.length

  const byCategory = CATEGORY_LABELS
  const categories = Object.keys(byCategory)
  const badgesByCategory = categories.reduce((acc, cat) => {
    acc[cat] = data.badges
      .filter(b => b.category === cat)
      .sort((a, b) => {
        if (a.earned !== b.earned) return a.earned ? -1 : 1
        return RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
      })
    return acc
  }, {} as Record<string, BadgeWithStatus[]>)

  return (
    <div>
      {/* Level + XP header */}
      <div className="panel" style={{marginBottom:20}}>
        <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}>
          <div style={{fontSize:44,lineHeight:1}}>{level.icon}</div>
          <div style={{flex:1}}>
            <p style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:4}}>current level</p>
            <h2 style={{fontSize:22,fontWeight:800,color:'var(--accent)',lineHeight:1}}>{level.name}</h2>
            <p style={{fontSize:11,color:'var(--fg-dim)',marginTop:3}}>{formatNumber(data.xp)} XP{nextXP ? ` · ${formatNumber(nextXP - data.xp)} to ${LEVELS[level.index + 1]?.name}` : ' · Max level'}</p>
          </div>
          <div style={{textAlign:'right'}}>
            <p style={{fontSize:22,fontWeight:800,color:'var(--fg)'}}>{earnedCount}</p>
            <p style={{fontSize:9,color:'var(--fg-dim)',textTransform:'uppercase',letterSpacing:'0.1em'}}>of {totalCount}</p>
          </div>
        </div>
        {/* XP bar */}
        <div style={{height:4,background:'var(--bg3)',borderRadius:2,overflow:'hidden'}}>
          <div style={{height:'100%',width:`${Math.min(100,progress)}%`,background:'var(--accent)',borderRadius:2,transition:'width .5s'}} />
        </div>
        {/* Level track */}
        <div style={{display:'flex',justifyContent:'space-between',marginTop:8}}>
          {LEVELS.map((l, i) => (
            <div key={l.name} style={{textAlign:'center',opacity: i <= level.index ? 1 : 0.3}}>
              <div style={{fontSize:14}}>{l.icon}</div>
              <div style={{fontSize:8,color:'var(--fg-dim)',letterSpacing:'0.06em',marginTop:2}}>{l.name.split(' ')[0]}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Badges by category */}
      {categories.map(cat => {
        const badges = badgesByCategory[cat] || []
        if (!badges.length) return null
        const earnedInCat = badges.filter(b => b.earned).length
        return (
          <div key={cat} style={{marginBottom:24}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
              <h3 style={{fontSize:11,letterSpacing:'0.12em',textTransform:'uppercase',color:'var(--fg-dim)',fontWeight:700}}>{byCategory[cat]}</h3>
              <span style={{fontSize:10,color:'var(--fg-faint)',fontFamily:'var(--mono)'}}>{earnedInCat}/{badges.length}</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:8}}>
              {badges.map(b => (
                <BadgeCard key={b.id} badge={b} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

