type EmbedTheme = 'light' | 'dark';

const EMBED_THEME_STORAGE_PREFIX = 'troublemaker.embedTheme.';

function isEmbedRoute(): boolean {
  return window.location.pathname.includes('/embed/agents/');
}

function currentAgentId(): string {
  const match = window.location.pathname.match(/\/agents\/([0-9a-f-]{36})(?:\/|$)/i);
  return match?.[1] ?? 'current';
}

function storageKey(): string {
  return `${EMBED_THEME_STORAGE_PREFIX}${currentAgentId()}`;
}

function normalizeTheme(value: unknown): EmbedTheme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

function themeFromHash(): EmbedTheme | null {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return normalizeTheme(params.get('theme'));
}

function themeFromStorage(): EmbedTheme | null {
  try {
    return normalizeTheme(sessionStorage.getItem(storageKey()));
  } catch {
    return null;
  }
}

function trustedThemeOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.origin === 'https://tinyfat.com' || url.origin === 'https://www.tinyfat.com') return true;
    if (url.protocol === 'https:' && url.hostname.endsWith('.fat-agents.pages.dev')) return true;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    return false;
  } catch {
    return false;
  }
}

function applyTheme(theme: EmbedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.embedTheme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    sessionStorage.setItem(storageKey(), theme);
  } catch {
    // Session storage may be disabled inside strict embeds.
  }
}

export function setupEmbedThemeSync(): void {
  if (!isEmbedRoute()) return;

  applyTheme(themeFromHash() || themeFromStorage() || 'light');

  window.addEventListener('message', (event) => {
    if (!trustedThemeOrigin(event.origin)) return;
    if (!event.data || event.data.type !== 'tinyfat:theme') return;
    const theme = normalizeTheme(event.data.theme);
    if (!theme) return;
    applyTheme(theme);
  });
}
