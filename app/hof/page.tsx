import { HofClient } from '@/components/hof/HofClient'
import { prisma } from '@/lib/prisma'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const ICO: Record<string, string> = { red: '🍷', white: '🥂', spark: '🍾', rose: '🌸', nonalc: '🌿' }

export default async function HofPage() {
  const perfect = await prisma.hallOfFame.findMany({
    orderBy: { ratedAt: 'desc' },
    take: 20,
    include: { user: { select: { id: true, name: true } } },
  })

  return (
    <div className="app-bg" style={{ minHeight:'100vh', padding:'0 0 48px' }}>
      <header style={{ padding:'0 16px', height:'var(--hdr-h)', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'1px solid rgba(255,255,255,0.04)', background:'rgba(14,14,12,0.82)', backdropFilter:'blur(18px)', position:'sticky', top:0, zIndex:10 }}>
        <Link href="/" style={{ fontFamily:'var(--mono)', fontSize:21, fontWeight:800, letterSpacing:'0.04em', textTransform:'uppercase', color:'var(--accent)', textDecoration:'none' }}>Verre</Link>
        <span style={{ fontSize:10, color:'var(--fg-dim)', letterSpacing:'0.14em', textTransform:'uppercase', fontFamily:'var(--mono)' }}>Hall of Fame</span>
      </header>

      <div style={{ maxWidth:720, margin:'0 auto', padding:'28px 16px 0' }}>
        <div style={{ marginBottom:8 }}>
          <p style={{ fontSize:9, letterSpacing:'0.18em', textTransform:'uppercase', color:'var(--accent2)', marginBottom:6 }}>community rankings</p>
          <h1 style={{ fontSize:28, fontWeight:800, color:'#F0E3C6', lineHeight:1, marginBottom:6 }}>Top Wines</h1>
          <p style={{ fontSize:11, color:'var(--fg-dim)', lineHeight:1.6, maxWidth:'48ch' }}>
            Global averages across all sessions. Qualifies at ≥3 ratings from ≥2 independent sessions.
          </p>
        </div>

        <HofClient />

        {perfect.length > 0 && (
          <div style={{ marginTop:48 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <div style={{ flex:1, height:1, background:'var(--border)' }} />
              <p style={{ fontSize:9, letterSpacing:'0.18em', textTransform:'uppercase', color:'var(--fg-dim)', whiteSpace:'nowrap' }}>perfect 5-star moments</p>
              <div style={{ flex:1, height:1, background:'var(--border)' }} />
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {perfect.map(e => (
                <div key={e.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:12 }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>{ICO[e.style ?? ''] ?? '🍷'}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:700, fontSize:13, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.wineName}</div>
                    {[e.producer, e.vintage].filter(Boolean).join(' · ') && (
                      <div style={{ fontSize:10, color:'var(--fg-dim)', marginTop:1 }}>{[e.producer, e.vintage].filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize:9, color:'var(--fg-faint)', fontFamily:'var(--mono)' }}>{e.user?.name ?? e.raterName}</div>
                    <div style={{ fontSize:9, color:'var(--fg-faint)', marginTop:1 }}>{new Date(e.ratedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</div>
                  </div>
                  <div style={{ fontSize:20, fontWeight:800, color:'var(--accent)', flexShrink:0 }}>★5</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
