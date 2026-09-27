import path from 'node:path';

// Finder-launched apps do not necessarily inherit the user's shell PATH.
// Add only explicit, conventional locations; never execute a shell profile.
export function macAgentCandidates(id, home) {
  if (!['codex', 'claude'].includes(id)) return [];
  return [path.posix.join(home, '.local/bin', id),
    path.posix.join(home, '.npm-global/bin', id),
    `/opt/homebrew/bin/${id}`, `/usr/local/bin/${id}`];
}

export function agentEnvironment(env, platform, home) {
  if (platform !== 'darwin') return {...env, NO_COLOR:'1'};
  const dirs=[path.posix.join(home,'.local/bin'),path.posix.join(home,'.npm-global/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
  return {...env, NO_COLOR:'1', PATH:[...new Set([...(env.PATH||'').split(':').filter(Boolean),...dirs])].join(':')};
}

export function cardShortcut(platform) {
  return platform === 'darwin' ? 'Command+Shift+T' : 'Ctrl+Shift+T';
}
