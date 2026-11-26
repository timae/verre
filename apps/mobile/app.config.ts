import { execSync } from 'node:child_process';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// app.json stays the config; this only adds `extra.commit`, the git commit the
// JavaScript is built from, for the About screen's build line ("which code am
// I testing?"): the short hash, "+" when the APP's code (this folder and
// @verre/core) has uncommitted changes. Read whenever the config is evaluated:
// at every native build, and when Metro starts (restart Metro to refresh it).
// null outside a checkout. `--no-optional-locks`: never takes the index lock
// (the config is evaluated beside other git commands).
function commit(): string | null {
  try {
    const git = (args: string) => execSync(`git --no-optional-locks ${args}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    return git('rev-parse --short HEAD') + (git('status --porcelain -- . ../../packages/core') ? '+' : '');
  } catch {
    return null;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => ({ ...config, extra: { ...config.extra, commit: commit() } }) as ExpoConfig;
