'use client'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { motion, useMotionValue, animate, type PanInfo } from 'framer-motion'
import { ProfileCheckins } from '@/components/social/ProfileCheckins'
import { ProfilePanelBadges } from './ProfilePanelBadges'
import { ProfilePanelPeople } from './ProfilePanelPeople'
import { ProfilePanelRatings } from './ProfilePanelRatings'
import type { FlavorBlock } from '@/lib/profileFlavor'

type Tab = 'tastes' | 'ratings' | 'badges' | 'people'
const TABS: { key: Tab; label: string }[] = [
  { key: 'tastes',  label: 'Tastes' },
  { key: 'ratings', label: 'Ratings' },
  { key: 'badges',  label: 'Badges' },
  { key: 'people',  label: 'People' },
]
const TAB_KEYS = new Set<Tab>(TABS.map(t => t.key))

type CheckinSeed = Parameters<typeof ProfileCheckins>[0]['initialCheckins']
type SessionPostSeed = NonNullable<Parameters<typeof ProfileCheckins>[0]['initialSessionPosts']>

interface Stats {
  ratings: number
  checkins: number
  badges: number
  followers: number
}

interface Props {
  profileUserId: number
  profileUserName: string
  profileUserXp: number
  profileUserImageUrl?: string | null
  myId: number | null
  viewerFollowsProfile: boolean
  initialCheckins: CheckinSeed
  initialSessionPosts?: SessionPostSeed
  initialTab?: Tab
  stats: Stats
  flavor: FlavorBlock
}

const SWIPE_THRESHOLD = 60
const SWIPE_VELOCITY = 400

export function ProfileTabs({
  profileUserId, profileUserName, profileUserXp, profileUserImageUrl, myId, viewerFollowsProfile, initialCheckins, initialSessionPosts, initialTab, stats, flavor,
}: Props) {
  // URL-param tab selection: ?tab=ratings deep-links straight to that
  // panel. Read at mount; updates flow back to the URL via router.replace
  // on every tab change so deep-link state survives reload + back-button
  // navigation. Falls back to the prop, then to the first tab.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const paramTab = searchParams.get('tab')
  const seedTab: Tab = (paramTab && TAB_KEYS.has(paramTab as Tab))
    ? paramTab as Tab
    : (initialTab ?? TABS[0].key)
  const [tab, setTab] = useState<Tab>(seedTab)
  // Track which tabs have ever been active so adjacent panels can lazy-mount
  // without losing state when the user swipes away and back.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([seedTab]))
  useEffect(() => { setVisited(prev => prev.has(tab) ? prev : new Set(prev).add(tab)) }, [tab])
  // Mirror the active tab into the URL. `replace` (not `push`) keeps the
  // back button on the previous PAGE, not on each tab toggle. Skip the
  // initial render — the URL already has the value we read.
  const firstRunRef = useRef(true)
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return }
    const params = new URLSearchParams(searchParams.toString())
    if (tab === TABS[0].key) params.delete('tab')
    else params.set('tab', tab)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [tab, pathname, router, searchParams])
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const x = useMotionValue(0)

  // Track the container width so the drag offset maps cleanly to one
  // tab-width per page. Capture the element at effect-setup time —
  // ResizeObserver can fire `update` after the ref has been cleared
  // during route changes, which would dereference null.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Keep x in sync with the active tab whenever tab or width changes.
  // Skip until ResizeObserver gives us a real width — otherwise the first
  // render snaps `x` to 0 and then jumps once width arrives.
  useEffect(() => {
    if (!width) return
    const idx = TABS.findIndex(t => t.key === tab)
    const controls = animate(x, -idx * width, { type: 'spring', stiffness: 320, damping: 36 })
    return () => controls.stop()
  }, [tab, width, x])

  function onDragEnd(_: PointerEvent, info: PanInfo) {
    const idx = TABS.findIndex(t => t.key === tab)
    const dragged = info.offset.x
    const velocity = info.velocity.x
    let next = idx
    if ((dragged < -SWIPE_THRESHOLD || velocity < -SWIPE_VELOCITY) && idx < TABS.length - 1) next = idx + 1
    else if ((dragged > SWIPE_THRESHOLD || velocity > SWIPE_VELOCITY) && idx > 0) next = idx - 1
    setTab(TABS[next].key)
  }

  const tiles: { label: string; value: number; tab: Tab }[] = [
    { label: 'tastes',    value: stats.checkins,  tab: 'tastes' },
    { label: 'ratings',   value: stats.ratings,   tab: 'ratings' },
    { label: 'badges',    value: stats.badges,    tab: 'badges' },
    { label: 'followers', value: stats.followers, tab: 'people' },
  ]

  return (
    <div>
      {/* Stats grid — every tile is clickable and switches the tab below. */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8, marginBottom:16 }}>
        {tiles.map(t => {
          const active = tab === t.tab
          return (
            <button
              key={t.label}
              type="button"
              onClick={() => setTab(t.tab)}
              style={{
                textAlign:'center', padding:'8px 4px',
                background: active ? 'rgba(200,150,60,0.12)' : 'var(--bg3)',
                border:`1px solid ${active ? 'rgba(200,150,60,0.4)' : 'transparent'}`,
                borderRadius:8,
                cursor: 'pointer',
                color: 'inherit',
              }}
            >
              <div style={{ fontSize:18, fontWeight:800, color:'var(--accent)', lineHeight:1 }}>{t.value}</div>
              <div style={{ fontSize:9, color:'var(--fg-dim)', marginTop:2, letterSpacing:'0.06em', textTransform:'uppercase' }}>{t.label}</div>
            </button>
          )
        })}
      </div>

      {/* Swipeable panels — overflow:hidden clips the off-screen panes.
          Drag is disabled until ResizeObserver gives us a real width — keeps
          the panes from stacking horizontally before the constraint is known. */}
      <div ref={containerRef} style={{ overflow:'hidden', touchAction:'pan-y' }}>
        <motion.div
          style={{ display:'flex', x, width: width * TABS.length }}
          drag={width ? 'x' : false}
          dragConstraints={{ left: -(TABS.length - 1) * width, right: 0 }}
          dragElastic={0.12}
          onDragEnd={onDragEnd}
        >
          <PaneShell active={tab === 'tastes'} width={width}>
            {visited.has('tastes') && (
              <ProfileCheckins
                profileUserId={profileUserId}
                profileUserName={profileUserName}
                profileUserXp={profileUserXp}
                profileUserImageUrl={profileUserImageUrl}
                myId={myId}
                viewerFollowsProfile={viewerFollowsProfile}
                initialCheckins={initialCheckins}
                initialSessionPosts={initialSessionPosts}
              />
            )}
          </PaneShell>
          <PaneShell active={tab === 'ratings'} width={width}>
            {visited.has('ratings') && (
              <ProfilePanelRatings
                lifetimeRatings={stats.ratings}
                flavor={flavor}
                profileUserName={profileUserName}
                isOwn={myId === profileUserId}
              />
            )}
          </PaneShell>
          <PaneShell active={tab === 'badges'} width={width}>
            {visited.has('badges') && <ProfilePanelBadges profileUserId={profileUserId} />}
          </PaneShell>
          <PaneShell active={tab === 'people'} width={width}>
            {visited.has('people') && <ProfilePanelPeople profileUserId={profileUserId} myId={myId} />}
          </PaneShell>
        </motion.div>
      </div>
    </div>
  )
}

// `inert` removes inactive panels from focus + AT trees while keeping
// them in the DOM so the swipe gesture works. React 19 takes inert as
// a real boolean attribute — no string-coercion needed.
function PaneShell({ active, width, children }: { active: boolean; width: number; children: React.ReactNode }) {
  return (
    <div
      inert={!active}
      aria-hidden={!active}
      style={{ width: width || '100%', flexShrink:0 }}
    >
      {children}
    </div>
  )
}
