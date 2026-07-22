// 明/暗主题：跟随 Innos IDE-Mono。默认 light（Mono White）。
// 通过 <html data-theme="dark"> 切换；持久化 key = easybi-theme。
// applyTheme 在入口先调用，避免首屏闪烁。

export type Theme = 'light' | 'dark';
const KEY = 'easybi-theme';

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

export function applyTheme(t: Theme = getTheme()): void {
  const root = document.documentElement;
  if (t === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
