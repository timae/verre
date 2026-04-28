import { LoginForm } from '@/components/auth/LoginForm'

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--bg)]">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-extrabold tracking-widest uppercase text-accent">Verre</h1>
          <p className="text-fg-dim text-xs mt-1">Wine Tasting OS</p>
        </div>
        <LoginForm />
      </div>
    </div>
  )
}
