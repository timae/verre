import { execSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// app.json stays the config; this only adds `extra.commit`, the git commit the
// JavaScript is built from, for the About screen's build line ("which code am
// I testing?"): the short hash, "+" when there were uncommitted changes. Read
// whenever the config is evaluated: at every native build, and when Metro
// starts (a reload keeps the value from the start). null outside a checkout.
function commit(): string | null {
  try {
    const git = (args: string) => execSync(`git ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return git('rev-parse --short HEAD') + (git('status --porcelain') ? '+' : '');
  } catch {
    return null;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => ({ ...config, extra: { ...config.extra, commit: commit() } }) as ExpoConfig;
