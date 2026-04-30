import { SessionShell } from '@/components/session/SessionShell'

export default function SessionLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ code: string }>
}) {
  return <SessionShell params={params}>{children}</SessionShell>
}
