import { createPageBridge } from './page-bridge.mjs';
import { createStatsPoller, setServiceToken } from './stats-ui.mjs';

const pageRoot = document.documentElement;
const fields = Object.fromEntries(['status', 'total', 'processed', 'matched', 'unmatched', 'started', 'lastMatched', 'updated', 'stale', 'refresh'].map((key) => [key, document.getElementById(key)]));
const bootstrap = window.__SESSION_DATE_FILTER__;
const validBootstrap = bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
  && typeof bootstrap.token === 'string' && /^[a-f0-9]{64}$/i.test(bootstrap.token)
  && ['light', 'dark'].includes(bootstrap.theme)
  && typeof bootstrap.lang === 'string' && bootstrap.lang.length > 0 && bootstrap.lang.length <= 24;
let copy = validBootstrap && bootstrap.lang.toLowerCase().startsWith('zh');
let poller;
const text = (zh, en) => copy ? zh : en;
function setBusy(busy) {
  fields.refresh.disabled = busy;
  fields.refresh.setAttribute('aria-busy', busy ? 'true' : 'false');
}
if (!validBootstrap) {
  fields.status.textContent = '统计服务不可用。 / Statistics service unavailable.';
  fields.status.dataset.state = 'unavailable';
  setBusy(false);
  fields.refresh.disabled = true;
} else {
  setServiceToken(bootstrap.token);
  pageRoot.dataset.theme = bootstrap.theme;
  pageRoot.lang = copy ? 'zh-CN' : 'en';
  function formatTime(value, field) {
    if (!value) { field.title = ''; return text('暂无', 'Not yet'); }
    const date = new Date(value);
    field.title = date.toISOString();
    return new Intl.DateTimeFormat(copy ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  function show(result) {
    const snapshot = result.snapshot;
    fields.status.textContent = result.kind === 'ok' ? text('统计正常', 'Statistics available') : result.kind === 'degraded' ? text('存储降级', 'Storage degraded') : result.kind === 'stale' ? text('服务不可用 · 显示旧数据', 'Service unavailable · showing stale data') : result.kind === 'unavailable' ? text('统计服务不可用', 'Statistics service unavailable') : result.kind === 'paused' ? text('页面不可见 · 已暂停刷新', 'Page hidden · refresh paused') : text('正在刷新…', 'Refreshing…');
    fields.status.dataset.state = result.kind;
    fields.stale.textContent = result.kind === 'stale' ? text('数据为上次成功读取；统计服务当前不可用。', 'Values are from the last successful read; the service is unavailable.') : '';
    if (!snapshot) return;
    const stats = snapshot.stats;
    fields.total.textContent = String(stats.removedLines);
    fields.processed.textContent = String(stats.processedRequests);
    fields.matched.textContent = String(stats.matchedRequests);
    fields.unmatched.textContent = String(stats.unmatchedRequests);
    fields.started.textContent = formatTime(stats.startedAt, fields.started);
    fields.lastMatched.textContent = formatTime(stats.lastMatchedAt, fields.lastMatched);
    fields.updated.textContent = formatTime(stats.updatedAt, fields.updated);
    if (snapshot.status === 'degraded' && result.kind !== 'stale') {
      fields.status.textContent = text('存储降级 · 计数可能延迟', 'Storage degraded · counts may be delayed');
      fields.stale.textContent = text('SQLite 暂不可用或尚未提交；当前主机内待提交计数可能可见，其他主机需提交后显示。', 'SQLite is unavailable or not committed; local pending counters may appear, while other hosts appear after commit.');
    }
  }
  const bridge = createPageBridge({ onTheme: (theme) => {
    copy = String(theme.lang || bootstrap.lang).toLowerCase().startsWith('zh');
    pageRoot.dataset.theme = theme.dark ? 'dark' : 'light';
    pageRoot.lang = copy ? 'zh-CN' : 'en';
  }, onVisibility: (visible) => poller?.setVisible(visible && document.visibilityState === 'visible') });
  poller = createStatsPoller({ url: './api/stats', getVisible: () => document.visibilityState === 'visible' && bridge.visible, onState: (kind) => setBusy(kind === 'loading' || kind === 'refreshing') });
  fields.refresh.addEventListener('click', () => { void poller.refresh().then((result) => { show(result); setBusy(false); }); });
  document.addEventListener('visibilitychange', () => poller.setVisible(document.visibilityState === 'visible' && bridge.visible));
  void bridge.ready.then(() => {
    poller.setVisible(bridge.visible && document.visibilityState === 'visible');
    poller.start(5000, show);
  }).catch(() => {
    fields.status.textContent = '宿主页面连接不可用。 / Host page connection unavailable.';
    fields.status.dataset.state = 'unavailable';
    setBusy(false);
  });
  window.addEventListener('pagehide', () => { poller?.stop(); bridge.stop(); }, { once: true });
}
