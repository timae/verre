'use client'
import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { useSession } from './SessionShell'
import { useSession as useAuthSession } from 'next-auth/react'
import { AccountSettings } from '@/components/me/AccountSettings'
import { clearSessionNames } from '@/lib/clientStorage'
import { formatCode } from '@/lib/sessionCode'

interface Props { onClose: () => void }

function formatTTL(seconds: number, lifespan?: string): string {
  if (lifespan === 'unlimited') return '∞ unlimited'
  if (seconds <= 0) return 'expired'
  const days  = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins  = Math.floor((seconds % 3600) / 60)
  if (days  > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${mins}m left`
  return `${mins}m left`
}

export function UserPanel({ onClose }: Props) {
  const { displayName, code, sessionMeta } = useSession()
  const { data: authSession } = useAuthSession()
  const router = useRouter()
  const user = authSession?.user as { id: string; name: string; email: string; pro?: boolean } | undefined

  const [tab, setTab] = useState<'overview' | 'settings'>('overview')


  const { data: sessions = [] } = useQuery<Array<{ id: number; code: string; name: string | null; wines_rated: number; joined_at: string }>>({
    queryKey: ['me-sessions'],
    queryFn: () => fetch('/api/me/sessions').then(r => r.ok ? r.json() : []),
    enabled: !!user,
  })

  type BadgeItem = { id: string; name: string; icon: string; earned: boolean }
  type BadgesResponse = { badges: BadgeItem[] }
  const { data: earnedBadges = [] } = useQuery<BadgesResponse, Error, BadgeItem[]>({
    queryKey: ['me-badges'],
    queryFn: () => fetch('/api/me/badges').then(r => r.ok ? r.json() : { badges: [] }),
    enabled: !!user,
    select: (d: BadgesResponse) => (d.badges || []).filter(b => b.earned).slice(0, 6),
  })

  const m = sessionMeta as typeof sessionMeta & { lifespan?: string; blind?: boolean; ttlSeconds?: number }
  const ttlLabel = formatTTL(m?.ttlSeconds ?? -1, m?.lifespan)

  return (
    <Modal onClose={onClose} maxWidth={600} minHeight="55vh" maxHeight="90vh">
      <div className="sheet-bar" />
        <div style={{fontFamily:'var(--mono)',fontSize:13,fontWeight:700,letterSpacing:'0.04em',marginBottom:18}}>
          {displayName || 'you'}
        </div>

        {/* Session identity */}
        <div style={{padding:'10px 12px',background:'rgba(143,184,122,0.07)',border:'1px solid rgba(143,184,122,0.18)',borderRadius:10,marginBottom:16,display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:'var(--accent2)',flexShrink:0}} />
          <div style={{flex:1}}>
            <div style={{fontSize:12,color:'var(--fg-dim)'}}>
              Tasting as <strong style={{color:'var(--fg)'}}>{displayName}</strong>
              {' · '}Session <strong style={{color:'var(--accent)',letterSpacing:'0.12em'}}>{formatCode(code)}</strong>
              {sessionMeta?.name && <span style={{color:'var(--fg-dim)'}}>{' · '}{sessionMeta.name}</span>}
            </div>
            <div style={{display:'flex',gap:6,marginTop:6,flexWrap:'wrap'}}>
              <span style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid var(--border)',borderRadius:3,padding:'2px 7px',color:'var(--fg-faint)'}}>{ttlLabel}</span>
              {m?.blind && (
                <span style={{fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',border:'1px solid rgba(200,150,60,0.3)',borderRadius:3,padding:'2px 7px',color:'var(--accent)'}}>🙈 blind</span>
              )}
            </div>
          </div>
        </div>

        {!user ? (
          <div>
            <p style={{fontSize:12,color:'var(--fg-dim)',marginBottom:12,lineHeight:1.6}}>
              You&apos;re tasting anonymously. Create an account to save your history, earn badges, and unlock premium features.
            </p>
            <button className="btn-p" onClick={() => { onClose(); router.push('/register') }} style={{marginBottom:6}}>→ create account</button>
            <button className="btn-g" onClick={() => { onClose(); router.push('/login') }}>→ sign in</button>
          </div>
        ) : (
          <div>
            {/* Tabs */}
            <div style={{display:'flex',gap:1,marginBottom:16,background:'var(--bg3)',borderRadius:8,padding:3}}>
              {(['overview', 'settings'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  style={{flex:1,padding:'6px 0',borderRadius:6,border:'none',
                    background: tab === t ? 'var(--bg2)' : 'transparent',
                    color: tab === t ? 'var(--fg)' : 'var(--fg-dim)',
                    fontSize:11,fontFamily:'var(--mono)',letterSpacing:'0.06em',cursor:'pointer'}}>
                  {t}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <div>
                {sessions.slice(0, 3).length > 0 && (
                  <div style={{marginBottom:16}}>
                    <div className="fl">recent tastings</div>
                    {sessions.slice(0, 3).map(s => (
                      <div key={s.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'6px 0',borderBottom:'1px solid var(--bg3)'}}>
                        <div style={{minWidth:0,flex:1}}>
                          <p style={{fontSize:12,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name || `Session ${formatCode(s.code)}`}</p>
                          <p style={{fontSize:10,color:'var(--fg-dim)'}}>{s.wines_rated} wine{s.wines_rated !== 1 ? 's' : ''} rated</p>
                        </div>
                        <button
                          onClick={() => { onClose(); router.push(`/session/${s.code}?name=${encodeURIComponent(user.name)}`) }}
                          style={{flexShrink:0,marginLeft:8,fontSize:9,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--accent)',border:'1px solid rgba(200,150,60,0.3)',background:'rgba(200,150,60,0.08)',padding:'4px 8px',borderRadius:3,cursor:'pointer'}}>
                          rejoin
                        </button>
                      </div>
                    ))}
                    <Link href="/me/history" style={{fontSize:10,color:'var(--accent)',marginTop:8,display:'block',fontFamily:'var(--mono)'}} onClick={onClose}>view all →</Link>
                  </div>
                )}

                {earnedBadges.length > 0 && (
                  <div style={{marginBottom:16}}>
                    <div className="fl">badges</div>
                    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:6}}>
                      {earnedBadges.map(b => (
                        <span key={b.id} title={b.name} style={{fontSize:22}}>{b.icon}</span>
                      ))}
                    </div>
                    <Link href="/me/badges" style={{fontSize:10,color:'var(--accent)',marginTop:8,display:'block',fontFamily:'var(--mono)'}} onClick={onClose}>view all →</Link>
                  </div>
                )}

                <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:16}}>
                  {[
                    { href: '/me',          l: '◉ dashboard' },
                    { href: '/me/history',  l: '◷ history' },
                    { href: '/me/saved',    l: '★ saved' },
                    { href: '/me/badges',   l: '🏅 badges' },
                  ].map(({ href, l }) => (
                    <Link key={href} href={href} className="btn-s" style={{textDecoration:'none'}} onClick={onClose}>{l}</Link>
                  ))}
                </div>

                <button className="btn-g" onClick={() => { clearSessionNames(); signOut({ callbackUrl: '/' }) }}>sign out</button>
              </div>
            )}

            {tab === 'settings' && <AccountSettings />}
          </div>
        )}

        <button className="btn-p" onClick={onClose} style={{marginTop:12,marginBottom:0}}>→ close</button>
    </Modal>
  )
}
