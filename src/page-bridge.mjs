const THEME_KEYS = new Set(['bg', 'card', 'fg', 'fg-2', 'muted', 'faint', 'line', 'accent', 'accent-soft', 'accent-fg', 'green', 'red', 'amber', 'font', 'code']);

export function createPageBridge({ parentWindow = globalThis.parent, selfWindow = globalThis, timeoutMs = 6000, onTheme = () => {}, onVisibility = () => {} } = {}) {
  let nextId = 0;
  let helloId;
  let settled = false;
  let active = true;
  let currentTheme = null;
  let hostVisible = true;
  let timer;
  const applyTheme = (theme) => {
    if (!theme || typeof theme !== 'object' || typeof theme.dark !== 'boolean') return;
    currentTheme = theme;
    const root = selfWindow.document?.documentElement;
    if (root) {
      root.dataset.theme = theme.dark ? 'dark' : 'light';
      root.style.colorScheme = theme.dark ? 'dark' : 'light';
      if (typeof theme.lang === 'string' && theme.lang) root.lang = theme.lang;
      if (theme.tokens && typeof theme.tokens === 'object') {
        for (const [key, value] of Object.entries(theme.tokens)) {
          if (THEME_KEYS.has(key) && typeof value === 'string') root.style.setProperty(`--opencode-${key}`, value);
        }
      }
    }
    onTheme(theme);
  };
  const receive = (event) => {
    if (!active || event.source !== parentWindow) return;
    const message = event.data;
    if (!message || message.opencode !== 1) return;
    if (message.event === 'theme') {
      if (settled) applyTheme(message.data);
      return;
    }
    if (message.event === 'visibility') {
      if (settled) {
        hostVisible = message.data?.visible !== false;
        onVisibility(hostVisible);
      }
      return;
    }
    if (message.id !== helloId || settled) return;
    settled = true;
    clearTimeout(timer);
    if (message.error) {
      selfWindow.removeEventListener('message', receive);
      rejectReady(new Error('Host page bridge unavailable.'));
      return;
    }
    const result = message.result || {};
    if (typeof result.visible === 'boolean') hostVisible = result.visible;
    applyTheme(result);
    resolveReady({ visible: hostVisible, theme: result });
  };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  if (parentWindow && parentWindow !== selfWindow && typeof selfWindow.addEventListener === 'function') {
    helloId = ++nextId;
    selfWindow.addEventListener('message', receive);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      selfWindow.removeEventListener('message', receive);
      rejectReady(new Error('Host page bridge timed out.'));
    }, timeoutMs);
    parentWindow.postMessage({ opencode: 1, id: helloId, method: 'hello', params: {} }, '*');
  } else {
    settled = true;
    resolveReady({ visible: true, theme: null });
  }
  return {
    ready,
    get visible() { return hostVisible; },
    get theme() { return currentTheme; },
    stop() { active = false; settled = true; clearTimeout(timer); selfWindow.removeEventListener?.('message', receive); },
  };
}
