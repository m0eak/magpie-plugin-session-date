import { createPageBridge } from './page-bridge.mjs';
import { createStatsPoller, setServiceToken } from './stats-ui.mjs';

const pageRoot = document.documentElement;
let poller;
const bridge = createPageBridge({ onTheme: (theme) => {
  pageRoot.dataset.theme = theme.dark ? 'dark' : 'light';
  pageRoot.lang = String(theme.lang || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}, onVisibility: (visible) => {
  if (poller) poller.setVisible(visible && document.visibilityState === 'visible');
  if (visible && document.visibilityState === 'visible' && poller) void poller.refresh().then(show);
} });
const params = new URL(location.href).searchParams;
setServiceToken(params.get('token') || '');
const copy = (params.get('lang') || 'en').toLowerCase().startsWith('zh');
pageRoot.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
pageRoot.lang = copy ? 'zh-CN' : 'en';
const text = (zh, en) => copy ? zh : en;
const fields = Object.fromEntries(['status', 'total', 'processed', 'matched', 'unmatched', 'started', 'lastMatched', 'updated', 'stale', 'refresh'].map((key) => [key, document.getElementById(key)]));
function formatTime(value) { return value ? new Intl.DateTimeFormat(copy ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value)) : text('暂无', 'Not yet'); }
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
  fields.started.textContent = formatTime(stats.startedAt);
  fields.lastMatched.textContent = formatTime(stats.lastMatchedAt);
  fields.updated.textContent = formatTime(stats.updatedAt);
  if (snapshot.status === 'degraded') {
    fields.status.textContent = text('存储降级 · 计数可能延迟', 'Storage degraded · counts may be delayed');
    fields.stale.textContent = text('SQLite 暂不可用或尚未提交；当前主机内待提交计数可能可见，其他主机需提交后显示。', 'SQLite is unavailable or not committed; local pending counters may appear, while other hosts appear after commit.');
  }
}
poller = createStatsPoller({ url: './api/stats', getVisible: () => document.visibilityState === 'visible' && bridge.visible });
fields.refresh.addEventListener('click', () => void poller.refresh().then(show));
document.addEventListener('visibilitychange', () => {
  poller.setVisible(document.visibilityState === 'visible' && bridge.visible);
  if (document.visibilityState === 'visible' && bridge.visible) void poller.refresh().then(show);
});
void bridge.ready.then(() => {
  poller.setVisible(bridge.visible && document.visibilityState === 'visible');
  if (bridge.visible && document.visibilityState === 'visible') void poller.refresh().then(show);
  poller.start(5000, show);
}).catch(() => {
  fields.status.textContent = text('宿主页面连接不可用。', 'Host page connection unavailable.');
  fields.status.dataset.state = 'unavailable';
});
window.addEventListener('pagehide', () => { poller?.stop(); bridge.stop(); }, { once: true });
