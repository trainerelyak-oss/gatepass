export function currentTheme() {
  return document.documentElement.dataset.theme || 'dark';
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('gp-theme', theme);
  } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#080d11' : '#13202b');
}
