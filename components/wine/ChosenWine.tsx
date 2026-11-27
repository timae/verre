'use client'

// The chosen wine of a bottle being added or edited (catalogue model change
// step 4): its name and year, its producer, and one action ("change", "change
// wine"). Shared by the picker's own summary, the add / edit sheets and the
// check-in sheet.
export function ChosenWine({ label, name, year, producer, note, action, onAction }: {
  label: string
  name: string
  year?: string | null
  producer?: string | null
  note?: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="field">
      <div className="fl">{label}</div>
      <div style={{display:'flex',alignItems:'center',gap:8,justifyContent:'space-between',padding:'8px 10px',border:'1px solid var(--border)',borderRadius:8}}>
        <div style={{minWidth:0}}>
          <div style={{fontWeight:700,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name}{year ? ` ${year}` : ''}</div>
          <div style={{fontSize:11,color:'var(--fg-dim)'}}>{producer}{note ? ` · ${note}` : ''}</div>
        </div>
        {action && onAction && <button type="button" className="btn-s" onClick={onAction}>{action}</button>}
      </div>
    </div>
  )
}
