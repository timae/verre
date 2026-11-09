import { useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';

// Native poll hardening per proposal 02 §4: RN has no visibilitychange, so
// AppState drives focusManager — only 'active' counts as focused ('inactive'
// fires for the app-switcher / control-center / OAuth sheet and is NOT a
// background flip), debounced so a shade pulldown doesn't refetch-storm.
const FOCUS_DEBOUNCE_MS = 300;

let focusTimer: ReturnType<typeof setTimeout> | null = null;
function wireFocusManager() {
  return AppState.addEventListener('change', (state) => {
    // 'inactive' is the app-switcher / control-center / OAuth-sheet limbo —
    // neither focused nor backgrounded; don't flip on it.
    if (state === 'inactive') return;
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      focusManager.setFocused(state === 'active');
    }, FOCUS_DEBOUNCE_MS);
  });
}

function wireOnlineManager() {
  return NetInfo.addEventListener((state) => {
    onlineManager.setOnline(state.isConnected !== false);
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 3000,
    },
  },
});

// 🔒 Identity boundary. Nearly every key in this singleton is VIEWER-dependent
// (feeds, profiles, moments) without carrying the viewer, so RootNavigator
// (app/_layout.tsx) drops the whole cache when the signed-in user changes.
// The epoch counts those drops: a write that STARTED under an older epoch
// belongs to the previous viewer and must not land (a mutation's late
// rollback would otherwise recreate the previous viewer's data in the cleared
// cache — Codex, 2026-11-09). Any setQueryData that can run after an await
// checks it; setQueriesData can't recreate a removed entry, so it needn't.
let viewerEpoch = 0;
export function viewerCacheEpoch(): number {
  return viewerEpoch;
}
export function clearViewerCache(): void {
  viewerEpoch++;
  void queryClient.cancelQueries();
  queryClient.clear();
}

export function QueryProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const focusSub = wireFocusManager();
    const onlineSub = wireOnlineManager();
    return () => {
      focusSub.remove();
      onlineSub();
      if (focusTimer) clearTimeout(focusTimer);
    };
  }, []);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** True while the device looks offline — drives the "Reconnecting…" affordance. */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  return online;
}
