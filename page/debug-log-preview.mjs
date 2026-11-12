const protocols = new Set(['chat', 'responses', 'anthropic', 'gemini']);
const kinds = new Set(['available_agents', 'agent_instruction', 'current_date', 'topic_title', 'tool_session_date']);
const actions = new Set(['replace', 'delete', 'remove']);
const stages = new Set(['agent_context', 'prompt_metadata', 'session_dates']);
const errorCodes = new Set(['filter-settings-unavailable', 'filter-transform-error', 'filter-error']);
const limitReasons = new Set(['scan', 'files', 'bytes', 'lines', 'line-size', 'records', 'response']);

export function initializeDebugLogPreview({ token, isChinese = () => false, fetcher = fetch, documentRef = document }) {
  const refreshButton = documentRef.getElementById('debugLogRefresh');
  const showAll = documentRef.getElementById('debugLogAll');
  const status = documentRef.getElementById('debugLogStatus');
  const list = documentRef.getElementById('debugLogList');
  if (!refreshButton || !showAll || !status || !list) return () => {};
  let revision = 0;
  let active;
  let records = [];
  let limited = false;
  let limitedBy = [];

  const text = (zh, en) => isChinese() ? zh : en;
  const element = (tag, className, value) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const safeRecord = (record) => record && typeof record === 'object'
    && typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))
    && protocols.has(record.protocol) && ['request', 'error'].includes(record.kind)
    && (record.outcome === null || ['changed', 'unchanged'].includes(record.outcome))
    && (record.code === null || errorCodes.has(record.code))
    && Number.isSafeInteger(record.omittedEdits) && record.omittedEdits >= 0
    && Array.isArray(record.edits) && record.edits.every((edit) => edit && kinds.has(edit.kind)
      && actions.has(edit.action) && (edit.before === null || typeof edit.before === 'string')
      && typeof edit.after === 'string' && (edit.path === null || typeof edit.path === 'string')
      && (edit.stage === null || stages.has(edit.stage))
      && (edit.range === null || (Number.isSafeInteger(edit.range?.start) && Number.isSafeInteger(edit.range?.end)
        && edit.range.start >= 0 && edit.range.end >= edit.range.start))
      && ['redacted', 'beforeTruncated', 'afterTruncated', 'beforeOmitted'].every((key) => typeof edit[key] === 'boolean'));

  function limitedNotice() {
    if (!limited) return '';
    const labels = {
      scan: text('目录扫描', 'directory scan'),
      files: text('日志文件数', 'file count'),
      bytes: text('读取字节数', 'read bytes'),
      lines: text('读取行数', 'line count'),
      'line-size': text('单行大小', 'line size'),
      records: text('返回记录数', 'record count'),
      response: text('响应大小', 'response size'),
    };
    const reasons = limitedBy.map((reason) => labels[reason]).filter(Boolean);
    return reasons.length
      ? text(`读取范围受限（${reasons.join('、')}）；结果可能不是全局最新记录。`, `Read scope limited (${reasons.join(', ')}); results may not include the globally newest logs.`)
      : text('读取范围受限；结果可能不是全局最新记录。', 'Read scope limited; results may not include the globally newest logs.');
  }

  function render() {
    list.replaceChildren();
    const visible = showAll.checked ? records : records.filter((record) => record.kind === 'request' && (record.outcome === 'changed' || record.edits.length > 0));
    if (!records.length) {
      status.textContent = limited
        ? `${text('当前读取范围内没有已保存记录。', 'No saved records in the scanned range.')} ${limitedNotice()}`
        : text('尚无已保存的调试记录。开启调试后会记录后续过滤变更。', 'No saved debug records yet. Enable Debug log to record future filter changes.');
      status.dataset.state = 'empty';
      return;
    }
    if (!visible.length) {
      status.textContent = `${text('读取到的记录没有过滤变更。可切换“显示全部”查看未命中和异常记录。', 'No filter changes in the loaded records. Show all to include unchanged and error records.')}${limited ? ` ${limitedNotice()}` : ''}`;
      status.dataset.state = 'empty';
      return;
    }
    status.textContent = `${text(`显示 ${visible.length} 条记录 · 只读取已落盘日志，写入可能稍有延迟。`, `Showing ${visible.length} records · Only saved logs are shown; new entries may take a moment to appear.`)}${limited ? ` ${limitedNotice()}` : ''}`;
    status.dataset.state = 'ok';
    for (const record of visible) list.append(renderRecord(record));
  }

  function renderRecord(record) {
    const details = element('details', 'debug-log-record');
    const summary = element('summary', 'debug-log-summary');
    const time = element('time', 'debug-log-time', new Intl.DateTimeFormat(isChinese() ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.timestamp)));
    time.dateTime = record.timestamp;
    const changeTypes = [...new Set(record.edits.map((edit) => edit.kind))].map((kind) => ({
      available_agents: text('助手列表', 'Agent list'),
      agent_instruction: text('助手说明', 'Agent instruction'),
      current_date: text('当前日期', 'Current date'),
      topic_title: text('话题标题', 'Topic title'),
      tool_session_date: text('会话日期', 'Session date'),
    })[kind] || kind);
    const resultLabel = record.kind === 'error'
      ? `${text('异常', 'Error')}${record.code ? ` · ${record.code}` : ''}`
      : `${record.outcome === 'changed' ? text('已修改', 'Changed') : text('无变更', 'No change')}${changeTypes.length ? ` · ${changeTypes.join(', ')}` : ''}`;
    summary.append(time, element('span', 'debug-log-protocol', record.protocol), element('span', 'debug-log-result', resultLabel));
    details.append(summary);
    const edits = element('div', 'debug-log-edits');
    if (!record.edits.length && record.kind === 'error') edits.append(element('p', 'note', text('此异常记录没有可显示的变更片段。', 'This error record has no change snippets.')));
    for (const edit of record.edits) {
      const item = element('article', 'debug-log-edit');
      const heading = element('h4', 'debug-log-path', edit.path || edit.stage || edit.kind);
      item.append(heading);
      const beforeAfter = element('div', 'debug-log-before-after');
      const before = element('section', 'debug-log-side');
      before.append(element('h5', '', text('处理前（已脱敏）', 'Before (redacted)')));
      const beforeText = edit.before === null ? text('原片段未保存', 'Original snippet not stored') : edit.before || text('空文本', 'Empty text');
      before.append(element('pre', '', beforeText));
      if (edit.beforeOmitted || edit.beforeTruncated) before.append(element('small', 'note', edit.beforeOmitted ? text('原片段已省略。', 'Original snippet omitted.') : text('原片段已截断。', 'Original snippet truncated.')));
      const after = element('section', 'debug-log-side');
      after.append(element('h5', '', text('处理后（已脱敏）', 'After (redacted)')));
      after.append(element('pre', '', edit.after || (['delete', 'remove'].includes(edit.action) ? text('已移除', 'Removed') : text('空文本', 'Empty text'))));
      if (edit.afterTruncated) after.append(element('small', 'note', text('结果片段已截断。', 'Result snippet truncated.')));
      if (edit.redacted) item.append(element('small', 'note', text('内容包含脱敏处理。', 'Content was redacted.')));
      beforeAfter.append(before, after);
      item.append(beforeAfter);
      edits.append(item);
    }
    if (record.omittedEdits > 0) edits.append(element('p', 'note', text(`另有 ${record.omittedEdits} 条变更未保存。`, `${record.omittedEdits} additional changes were omitted.`)));
    details.append(edits);
    return details;
  }

  async function refresh() {
    if (active) return active;
    const current = ++revision;
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    status.textContent = text('正在读取已保存日志…', 'Loading saved logs…');
    status.dataset.state = 'loading';
    active = (async () => {
      try {
        const response = await fetcher('./api/debug/logs', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (response.status === 401) throw new Error('unauthorized');
        if (!response.ok) throw new Error('unavailable');
        const payload = await response.json();
        if (current !== revision) return;
        if (!payload || !Array.isArray(payload.records) || !payload.records.every(safeRecord)
          || typeof payload.limited !== 'boolean' || !Array.isArray(payload.limitReasons)
          || !payload.limitReasons.every((reason) => limitReasons.has(reason))) throw new Error('invalid-response');
        records = payload.records;
        limited = payload.limited;
        limitedBy = payload.limitReasons;
        render();
      } catch (error) {
        if (current !== revision) return;
        status.textContent = error?.message === 'unauthorized'
          ? text('认证已失效，请重新打开插件界面。', 'Authentication expired. Reopen the plugin page.')
          : records.length
            ? text('日志读取失败；下方保留上次读取的记录，请重试。', 'Could not refresh logs; the previous results remain below. Try again.')
            : text('日志读取失败；请重试。', 'Could not load logs. Try again.');
        status.dataset.state = 'error';
      } finally {
        if (current === revision) {
          refreshButton.disabled = false;
          refreshButton.removeAttribute('aria-busy');
          active = null;
        }
      }
    })();
    return active;
  }

  refreshButton.addEventListener('click', () => { void refresh(); });
  showAll.addEventListener('change', render);
  void refresh();
  return () => { revision += 1; };
}
