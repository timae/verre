import { LoginForm } from '@/components/auth/LoginForm'
import { getLoginNotice, type LoginNotice } from '@/lib/revocationNotice'

const NOTICE_COPY: Record<LoginNotice, string> = {
  password_change: 'Your password was changed, so you were signed out on this device. Please log in again with your new password.',
  session_expired: 'Your session expired. Please sign in again.',
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  const { redirect: redirectTo } = await searchParams
  const loginNotice = await getLoginNotice()
  const notice = loginNotice ? NOTICE_COPY[loginNotice] : undefined
  return (
    <div className="app-bg" style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{width:'100%',maxWidth:360}}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{fontFamily:'var(--mono)',fontSize:22,fontWeight:800,letterSpacing:'0.04em',textTransform:'uppercase',color:'var(--accent)'}}>Verre</div>
          <div style={{fontSize:10,color:'var(--fg-dim)',letterSpacing:'0.14em',textTransform:'uppercase',marginTop:4}}>Wine Tasting OS</div>
        </div>
        <div className="lobby-card lobby-form" style={{padding:22}}>
          <div style={{fontSize:9,letterSpacing:'0.14em',textTransform:'uppercase',color:'var(--fg-dim)',marginBottom:16}}>{'// Sign in to your account'}</div>
          <LoginForm redirectTo={redirectTo} notice={notice} />
        </div>
      </div>
    </div>
  )
}
