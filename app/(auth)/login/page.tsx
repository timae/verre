import { LoginForm } from '@/components/auth/LoginForm'

export default function LoginPage() {
  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:16,background:'var(--bg)'}}>
      <div style={{width:'100%',maxWidth:360}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontFamily:'var(--mono)',fontSize:22,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)'}}>Verre</div>
          <div style={{fontSize:10,color:'var(--fg-dim)',letterSpacing:'0.14em',textTransform:'uppercase',marginTop:4}}>Wine Tasting OS</div>
        </div>
        <div className="lobby-card lobby-form" style={{padding:22}}>
          <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>// Sign in to your account</div>
          <LoginForm />
        </div>
      </div>
    </div>
  )
}
