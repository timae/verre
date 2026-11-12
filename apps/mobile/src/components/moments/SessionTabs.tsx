// .vtabs — Line-up | Compare, one strip shared by both layouts of the session
// screen. CONTROLLED (Simon's ruling 2026-07-02): Compare is an in-screen tab
// swap — everything above the tabs (bar or cover hero) stays identical and
// there is no route change, no back-to-line-up. A thin wrapper over the shared
// strip (components/ui/TabStrip.tsx, People's tabs too): same props, same
// metrics.

import { TabStrip } from '@/components/ui/TabStrip';

export type SessionTab = 'lineup' | 'compare';

const TABS = [{ key: 'lineup', label: 'Line-up' }, { key: 'compare', label: 'Compare' }] as const;

export function SessionTabs({ active, onSelect }: { active: SessionTab; onSelect: (tab: SessionTab) => void }) {
  return <TabStrip tabs={TABS} active={active} onSelect={onSelect} />;
}
