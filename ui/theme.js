(() => {
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  function applyTheme(choice) {
    if (!['light', 'dark', 'system'].includes(choice)) choice = 'system';
    const mode = choice === 'system' ? (media?.matches ? 'light' : 'dark') : choice;
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem('tc_theme', choice); } catch {}
    window.electronAPI?.setTheme?.(mode);
  }
  window.tcApplyTheme = applyTheme;
  let choice = 'system';
  try { choice = localStorage.getItem('tc_theme') || 'system'; } catch {}
  applyTheme(choice);
  media?.addEventListener('change', () => { try { if ((localStorage.getItem('tc_theme') || 'system') === 'system') applyTheme('system'); } catch {} });
})();
