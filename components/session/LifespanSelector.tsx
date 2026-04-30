'use client'

const OPTIONS = [
  { value: '48h', label: '48 hours', sublabel: 'default',   pro: false },
  { value: '72h', label: '72 hours', sublabel: '+1 day',    pro: true  },
  { value: '1w',  label: '1 week',   sublabel: '7 days',    pro: true  },
  { value: 'unlimited', label: 'Unlimited', sublabel: '∞', pro: true  },
]

interface Props {
  value: string
  onChange: (v: string) => void
  isPro: boolean
}

export function LifespanSelector({ value, onChange, isPro }: Props) {
  return (
    <div className="field">
      <div className="fl">session lifespan</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {OPTIONS.map(o => {
          const disabled = o.pro && !isPro
          const active = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onChange(o.value)}
              style={{
                flex:1,minWidth:70,padding:'8px 6px',borderRadius:8,
                border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: active ? 'rgba(200,150,60,0.1)' : 'var(--bg3)',
                color: disabled ? 'var(--fg-faint)' : active ? 'var(--accent)' : 'var(--fg-dim)',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                textAlign:'center',
                position:'relative',
              }}
            >
              <div style={{fontSize:11,fontWeight:700,fontFamily:'var(--mono)'}}>{o.label}</div>
              <div style={{fontSize:9,marginTop:2,color: active ? 'var(--accent)' : 'var(--fg-faint)'}}>
                {o.pro && !isPro ? '🔒 pro' : o.sublabel}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
