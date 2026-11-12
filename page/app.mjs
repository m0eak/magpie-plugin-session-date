import { createPageBridge } from './page-bridge.mjs';
import { createStatsPoller, readFilterSettings, saveFilterSettings, setServiceToken } from './stats-ui.mjs';

const pageRoot = document.documentElement;
const fields = Object.fromEntries(['status', 'total', 'processed', 'matched', 'unmatched', 'started', 'lastMatched', 'updated', 'stale', 'refresh', 'dateLines', 'dateHits', 'titleLines', 'titleHits', 'agentHits', 'agentBlocks', 'timeBlocks', 'sessionDateEnabled', 'topicTitleEnabled', 'availableAgentsEnabled', 'settingsStatus'].map((key) => [key, document.getElementById(key)]));
const bootstrap = window.__SESSION_DATE_FILTER__;
const validBootstrap = bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap)
  && typeof bootstrap.token === 'string' && /^[a-f0-9]{64}$/i.test(bootstrap.token)
  && ['light', 'dark'].includes(bootstrap.theme)
  && typeof bootstrap.lang === 'string' && bootstrap.lang.length > 0 && bootstrap.lang.length <= 24;
let copy = validBootstrap && bootstrap.lang.toLowerCase().startsWith('zh');
let poller;
function initializeDebugControls(token) {
  const toggle = document.getElementById('debugEnabled');
  const status = document.getElementById('debugStatus');
  const directory = document.getElementById('debugDirectory');
  if (!toggle || !status) return null;
  const validStatus = (value) => value && typeof value === 'object'
    && ['disabled', 'ready', 'degraded', 'config_unavailable'].includes(value.state)
    && (value.directory === null || typeof value.directory === 'string')
    && ['queuedRequests', 'writtenRequests', 'droppedRequests'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && (value.lastWriteAt === null || typeof value.lastWriteAt === 'string')
    && (value.lastErrorCode === null || typeof value.lastErrorCode === 'string');
  let saving = false;
  let revision = 0;
  let activeRefresh = null;
  const refresh = async () => {
    if (saving) return;
    if (activeRefresh) return activeRefresh;
    const requestRevision = ++revision;
    activeRefresh = (async () => {
      try {
        const response = await fetch('./api/debug', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        const value = await response.json();
        if (!value || !validStatus(value.status)) throw new Error('invalid-response');
        if (!response.ok) {
          if (response.status === 503 && value.status.state === 'config_unavailable' && value.settings === null) {
            if (saving || requestRevision !== revision) return;
            toggle.disabled = false;
            status.textContent = `${text('调试配置不可用；过滤功能仍独立运行', 'Debug configuration unavailable; filtering remains independent')} · ${text('丢弃', 'Dropped')} ${value.status.droppedRequests}${value.status.lastErrorCode ? ` · ${text('错误码', 'Code')} ${value.status.lastErrorCode}` : ''}`;
            status.dataset.state = 'config_unavailable';
            if (directory) directory.textContent = value.status.directory ?? '';
            return;
          }
          throw new Error('unavailable');
        }
        if (typeof value.settings?.enabled !== 'boolean') throw new Error('invalid-response');
        if (saving || requestRevision !== revision) return;
        toggle.checked = value.settings.enabled;
        toggle.disabled = false;
        const stateText = value.status.state === 'disabled' ? text('调试日志已关闭', 'Debug logging disabled')
          : value.status.state === 'ready' ? text('调试日志已就绪', 'Debug logging ready')
            : text('调试日志写入异常；过滤功能仍独立运行', 'Debug logging degraded; filtering remains independent');
        status.textContent = `${stateText} · ${text('已写入', 'Written')} ${value.status.writtenRequests} · ${text('丢弃', 'Dropped')} ${value.status.droppedRequests}${value.status.lastErrorCode ? ` · ${text('错误码', 'Code')} ${value.status.lastErrorCode}` : ''}`;
        status.dataset.state = value.status.state;
        if (directory) directory.textContent = value.status.directory ?? '';
      } catch {
        if (saving || requestRevision !== revision) return;
        status.textContent = text('调试状态不可用；过滤功能仍独立运行', 'Debug status unavailable; filtering remains independent');
        status.dataset.state = 'error';
      }
    })();
    try { await activeRefresh; } finally { activeRefresh = null; }
  };
  toggle.addEventListener('change', async () => {
    if (saving) return;
    const target = toggle.checked;
    const previous = !target;
    saving = true;
    revision += 1;
    toggle.disabled = true;
    status.textContent = text('正在保存…', 'Saving…');
    let saved = false;
    try {
      const response = await fetch('./api/debug', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: target }),
      });
      if (!response.ok) throw new Error('save-failed');
      const value = await response.json();
      if (value?.settings?.enabled !== target || !validStatus(value.status)) throw new Error('invalid-response');
      saved = true;
    } catch {
      toggle.checked = previous;
      status.textContent = text('调试设置保存失败；请重试', 'Could not save debug setting; retry');
      status.dataset.state = 'error';
    } finally {
      saving = false;
      toggle.disabled = false;
    }
    if (saved) {
      if (activeRefresh) await activeRefresh;
      await refresh();
    }
  });
  void refresh();
  return refresh;
}
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
  const refreshDebug = initializeDebugControls(bootstrap.token);
  pageRoot.dataset.theme = bootstrap.theme;
  pageRoot.lang = copy ? 'zh-CN' : 'en';
  function formatTime(value, field) {
    if (!value) { field.title = ''; return text('暂无', 'Not yet'); }
    const date = new Date(value);
    field.title = date.toISOString();
    return new Intl.DateTimeFormat(copy ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  function show(result) {
    void refreshDebug?.();
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
    fields.dateLines.textContent = String(stats.dateRemovedLines ?? 0);
    fields.dateHits.textContent = String(stats.dateMatchedRequests ?? 0);
    fields.titleLines.textContent = String(stats.topicTitleRemovedLines ?? 0);
    fields.titleHits.textContent = String(stats.topicTitleMatchedRequests ?? 0);
    fields.agentHits.textContent = String(stats.availableAgentsMatchedRequests ?? 0);
    fields.agentBlocks.textContent = String(stats.availableAgentsReplacedBlocks ?? 0);
    fields.timeBlocks.textContent = String(stats.timeGuidanceInsertedBlocks ?? 0);
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
  const dateToggle = document.getElementById('sessionDateEnabled');
  const titleToggle = document.getElementById('topicTitleEnabled');
  const agentsToggle = document.getElementById('availableAgentsEnabled');
  const settingsStatus = document.getElementById('settingsStatus');
  let settings = null;
  let settingsRevision = 0;
  let settingsReadId = 0;
  let settingsReading = false;
  let settingsSaving = false;
  let settingsRefreshPending = false;
  const updateSettingsControls = () => {
    const disabled = settings === null || settingsReading || settingsSaving;
    dateToggle.disabled = disabled;
    titleToggle.disabled = disabled;
    agentsToggle.disabled = disabled;
  };
  const loadSettings = async () => {
    if (settingsSaving) {
      settingsRefreshPending = true;
      return;
    }
    const readId = ++settingsReadId;
    const revision = settingsRevision;
    settingsReading = true;
    updateSettingsControls();
    try {
      const loaded = await readFilterSettings({ url: './api/settings' });
      if (readId !== settingsReadId || revision !== settingsRevision) return;
      settings = loaded;
      dateToggle.checked = settings.sessionDate;
      titleToggle.checked = settings.topicTitle;
      agentsToggle.checked = settings.availableAgents;
      settingsStatus.textContent = text('设置已加载', 'Settings loaded');
      settingsStatus.dataset.state = 'ok';
    } catch {
      if (readId !== settingsReadId || revision !== settingsRevision) return;
      settingsStatus.textContent = text('设置读取失败，当前状态未知', 'Could not load settings; current state is unknown');
      settingsStatus.dataset.state = 'unavailable';
    } finally {
      if (readId === settingsReadId) {
        settingsReading = false;
        updateSettingsControls();
      }
    }
  };
  const changeSetting = async (key, enabled) => {
    if (!settings) { await loadSettings(); return; }
    if (settingsSaving || settingsReading) return;
    const previous = settings;
    const revision = ++settingsRevision;
    ++settingsReadId;
    settingsReading = false;
    settingsSaving = true;
    updateSettingsControls();
    try {
      const saved = await saveFilterSettings({ [key]: enabled }, { url: './api/settings' });
      if (revision === settingsRevision) {
        settings = saved;
        dateToggle.checked = saved.sessionDate;
        titleToggle.checked = saved.topicTitle;
        agentsToggle.checked = saved.availableAgents;
        settingsStatus.textContent = text('设置已保存', 'Settings saved');
        settingsStatus.dataset.state = 'ok';
      }
    } catch {
      try {
        const confirmed = await readFilterSettings({ url: './api/settings' });
        if (revision === settingsRevision) {
          settings = confirmed;
          dateToggle.checked = confirmed.sessionDate;
          titleToggle.checked = confirmed.topicTitle;
          agentsToggle.checked = confirmed.availableAgents;
          const saveApplied = confirmed[key] === enabled;
          settingsStatus.textContent = saveApplied
            ? text('保存响应未确认；已重新读取并确认设置', 'Save response was lost; settings were reread and confirmed')
            : text('保存未生效；已重新读取当前设置', 'Save did not take effect; current settings were reread');
          settingsStatus.dataset.state = saveApplied ? 'ok' : 'error';
        }
      } catch {
        if (revision === settingsRevision) {
          settings = previous;
          settingsStatus.textContent = text('保存结果未确认，请重新读取设置', 'Save outcome is unconfirmed; reload settings to verify');
          settingsStatus.dataset.state = 'unavailable';
        }
      }
    } finally {
      if (revision === settingsRevision) {
        settingsSaving = false;
        updateSettingsControls();
        if (settingsRefreshPending) {
          settingsRefreshPending = false;
          void loadSettings();
        }
      }
    }
  };
  fields.refresh.addEventListener('click', () => {
    void loadSettings();
    void poller.refresh().then((result) => { show(result); setBusy(false); });
  });
  dateToggle.addEventListener('change', () => { void changeSetting('sessionDate', dateToggle.checked); });
  titleToggle.addEventListener('change', () => { void changeSetting('topicTitle', titleToggle.checked); });
  agentsToggle.addEventListener('change', () => { void changeSetting('availableAgents', agentsToggle.checked); });
  updateSettingsControls();
  void loadSettings();
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
