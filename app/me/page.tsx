import { auth } from '@/auth'
import Link from 'next/link'

export default async function MeDashboard() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Welcome back, {session.user.name}</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { href: '/me/history', icon: '◷', label: 'Tasting history' },
          { href: '/me/saved', icon: '★', label: 'Saved wines' },
          { href: '/me/profile', icon: '◉', label: 'Flavour profile' },
          { href: '/', icon: '+', label: 'New tasting' },
        ].map(({ href, icon, label }) => (
          <Link key={href} href={href}
            className="bg-bg2 border border-border rounded-xl p-4 flex flex-col gap-2 hover:border-accent transition-colors">
            <span className="text-2xl">{icon}</span>
            <span className="text-sm font-medium text-fg">{label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
