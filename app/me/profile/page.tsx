import { ProfileClient } from '@/components/me/ProfileClient'
import { DashboardSettings } from '@/components/me/DashboardSettings'
import { AccountSettings } from '@/components/me/AccountSettings'

export default function ProfilePage() {
  return (
    <div>
      <h1 style={{fontSize:24,fontWeight:700,color:'#F0E3C6',marginBottom:20}}>Profile & Settings</h1>
      <ProfileClient />
      <div className="panel" style={{marginTop:16}}>
        <div className="panel-hdr">account</div>
        <AccountSettings />
      </div>
      <div className="panel" style={{marginTop:16}}>
        <DashboardSettings />
      </div>
    </div>
  )
}
