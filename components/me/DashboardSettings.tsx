'use client'
import { useState, useEffect } from 'react'

export type DashboardSection = {
  id: string
  label: string
  enabled: boolean
}

const DEFAULT_SECTIONS: DashboardSection[] = [
  { id: 'new_tasting',    label: 'Start / join tasting',  enabled: true },
  { id: 'recent_sessions', label: 'Recent tastings',       enabled: true },
  { id: 'saved_wines',    label: 'Saved wines preview',   enabled: true },
  { id: 'quick_links',    label: 'Quick links',            enabled: true },
  { id: 'show_badges',    label: 'Show Badges in sidebar', enabled: true },
]

const STORAGE_KEY = 'vr_dashboard_sections'

export function useDashboardSections(): [DashboardSection[], (s: DashboardSection[]) => void] {
  const [sections, setSectionsState] = useState<DashboardSection[]>(DEFAULT_SECTIONS)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as DashboardSection[]
        // Merge with defaults to handle new sections added later
        const merged = DEFAULT_SECTIONS.map(def => {
          const found = parsed.find(p => p.id === def.id)
          return found ? { ...def, enabled: found.enabled } : def
        })
        // Reorder by saved order
        const savedOrder = parsed.map(p => p.id)
        merged.sort((a, b) => {
          const ai = savedOrder.indexOf(a.id)
          const bi = savedOrder.indexOf(b.id)
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
        })
        setSectionsState(merged)
      }
    } catch {}
  }, [])

  function setSections(next: DashboardSection[]) {
    setSectionsState(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  return [sections, setSections]
}

export function DashboardSettings() {
  const [sections, setSections] = useDashboardSections()
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  function toggle(id: string) {
    setSections(sections.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s))
  }

  function onDragStart(id: string) { setDragging(id) }
  function onDragOver(e: React.DragEvent, id: string) { e.preventDefault(); setDragOver(id) }

  function onDrop(targetId: string) {
    if (!dragging || dragging === targetId) { setDragging(null); setDragOver(null); return }
    const from = sections.findIndex(s => s.id === dragging)
    const to = sections.findIndex(s => s.id === targetId)
    const next = [...sections]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setSections(next)
    setDragging(null); setDragOver(null)
  }

  return (
    <div>
      <div className="panel-hdr">dashboard layout</div>
      <p style={{fontSize:11,color:'var(--fg-dim)',marginBottom:12,lineHeight:1.6}}>
        Toggle sections on or off, and drag to reorder them on your dashboard.
      </p>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {sections.map(s => (
          <div
            key={s.id}
            draggable
            onDragStart={() => onDragStart(s.id)}
            onDragOver={e => onDragOver(e, s.id)}
            onDrop={() => onDrop(s.id)}
            onDragEnd={() => { setDragging(null); setDragOver(null) }}
            style={{
              display:'flex',alignItems:'center',gap:10,padding:'10px 12px',
              borderRadius:10,border:`1px solid ${dragOver === s.id ? 'var(--accent)' : 'var(--border)'}`,
              background: dragging === s.id ? 'var(--bg4)' : dragOver === s.id ? 'rgba(200,150,60,0.06)' : 'var(--bg3)',
              cursor:'grab',transition:'border-color .15s,background .15s',opacity: s.enabled ? 1 : 0.5,
            }}
          >
            <span style={{fontSize:12,color:'var(--fg-faint)',cursor:'grab',userSelect:'none'}}>⠿</span>
            <span style={{flex:1,fontSize:12,fontFamily:'var(--mono)',color: s.enabled ? 'var(--fg)' : 'var(--fg-dim)'}}>{s.label}</span>
            {/* Toggle */}
            <div
              onClick={() => toggle(s.id)}
              style={{width:34,height:18,borderRadius:9,background: s.enabled ? 'var(--accent)' : 'var(--bg4)',border:'1px solid var(--border2)',position:'relative',transition:'background .2s',cursor:'pointer',flexShrink:0}}
            >
              <div style={{width:12,height:12,borderRadius:'50%',background:'#fff',position:'absolute',top:2,left: s.enabled ? 18 : 2,transition:'left .2s'}} />
            </div>
          </div>
        ))}
      </div>
      <p style={{fontSize:9,color:'var(--fg-faint)',marginTop:10,letterSpacing:'0.06em'}}>Changes are saved automatically and apply immediately.</p>
    </div>
  )
}
