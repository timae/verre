'use client'
import { useQuery } from '@tanstack/react-query'
import { RARITY_ORDER, type Rarity } from '@/lib/badges'
import { BadgeCard } from '@/components/me/BadgeCard'

type Badge = {
  id: string; name: string; description: string; icon: string
  category: string; rarity: Rarity; xp_reward: number
  earned: boolean; earned_at: string | null
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

export function ProfilePanelBadges({ profileUserId }: { profileUserId: number }) {
  const { data, isLoading } = useQuery<{ badges: Badge[] }>({
    queryKey: ['profile-badges', profileUserId],
    queryFn: () => fetch(`/api/users/${profileUserId}/badges`).then(r => r.json()),
  })

  if (isLoading) return <p style={{color:'var(--fg-dim)',fontSize:13}}>Loading…</p>
  if (!data) return null

  const earnedCount = data.badges.filter(b => b.earned).length
  const totalCount = data.badges.length
  const categories = Object.keys(CATEGORY_LABELS)
  const byCat = categories.reduce((acc, cat) => {
    acc[cat] = data.badges
      .filter(b => b.category === cat)
      .sort((a, b) => {
        if (a.earned !== b.earned) return a.earned ? -1 : 1
        return RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
      })
    return acc
  }, {} as Record<string, Badge[]>)

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 14, fontFamily: 'var(--mono)' }}>
        {earnedCount}/{totalCount} earned
      </div>
      {categories.map(cat => {
        const badges = byCat[cat] || []
        if (!badges.length) return null
        const earnedInCat = badges.filter(b => b.earned).length
        return (
          <div key={cat} style={{ marginBottom: 24 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 10 }}>
              <h3 style={{ fontSize:11, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--fg-dim)', fontWeight:700 }}>{CATEGORY_LABELS[cat]}</h3>
              <span style={{ fontSize:10, color:'var(--fg-faint)', fontFamily:'var(--mono)' }}>{earnedInCat}/{badges.length}</span>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:8 }}>
              {badges.map(b => <BadgeCard key={b.id} badge={b} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
