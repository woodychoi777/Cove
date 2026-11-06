export function setupTheme(select) {
  const apply = value => {
    const theme = ['light', 'dark'].includes(value) ? value : 'system';
    document.documentElement.dataset.theme = theme;
    select.value = theme;
    return theme;
  };
  let saved;
  try { saved = localStorage.getItem('soriseojae.theme'); } catch {}
  apply(saved);
  select.addEventListener('change', () => {
    const theme = apply(select.value);
    try { localStorage.setItem('soriseojae.theme', theme); } catch {}
  });
}
