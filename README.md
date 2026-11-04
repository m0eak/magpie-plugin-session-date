# Session Date Filter / 会话日期清理

> **开发中：阶段 2 / 3。** Task 1 纯函数过滤已通过审查；Task 2 request hook、SQLite 聚合存储和 loopback API 已完成本地验收，等待主代理独立审查。尚无真实页面、最终安装包或部署结论；不要安装到生产环境。

此独立插件在 magpie 的公开异步请求 hook 中，对客户端请求中的 LobeHub Memory / Credentials 工具提示词执行窄范围变换：只移除经结构 wrapper 确认的 `<session_context>` 中完整英文 `Session date: Weekday, Month D, YYYY` 行。它不会扫描任意 system prompt、user/assistant/tool 内容、未知字段、图片或非文本块；不做协议转换。插件不保存请求正文、Key、模型、会话、provider、agent 或逐请求明细。

此操作只计提示词变换次数，不代表模型端缓存命中率，也不能保证节省 token 或改善缓存。其他动态提示词、路由和缓存 TTL 仍会影响结果。删除日期可能减弱 Memory 在消息缺少时间戳时的相对时间 fallback。

由于正文中完全伪造与目标工具完全相同的 XML 包装无法可靠地从真实工具模板语义区分，匹配只做严格结构约束，并不承诺绝无误匹配。日期匹配也不是对整个 JSON 序列化字节完全不变；除删除的目标行与其行分隔符外，结构及非文本元数据应保持。

## 模块接口

- `src/matcher.mjs`：`stripSessionDates(text) -> { text, removedLines }`
- `src/protocols.mjs`：`filterRequest(body, protocol) -> { body, removedLines, supported }`
- Task 2（本地实现、测试完成，待独立审查）：`src/request.hooks.mjs` 导出公开异步 `onRequest(body, ctx)`；`src/stats-store.mjs` 实现 Bun 内置 SQLite 聚合存储；`src/service-api.mjs` 提供 loopback 只读 API；`index.mjs` 是宿主 server 入口。

支持协议：chat、responses、anthropic、gemini。Chat 文本块使用 `type: text`，Responses 输入文本块使用 `type: input_text`。只检查 system/developer 或协议顶层系统指令位置；Gemini 只检查对象形状 `systemInstruction.parts[].text`，并对错误元数据类型或混合未知 payload fail-open。未知协议及 malformed 内容 fail-open；不扫描其他对象的任意 `text` 字段。

## 聚合 API 契约（供 Task 3）

`GET /api/stats` 返回稳定 JSON：

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "stats": {
    "processedRequests": 1,
    "matchedRequests": 1,
    "removedLines": 1,
    "unmatchedRequests": 0,
    "startedAt": "2026-11-04T00:00:00.000Z",
    "updatedAt": "2026-11-04T00:00:00.000Z",
    "lastMatchedAt": "2026-11-04T00:00:00.000Z"
  },
  "persistence": "SQLite WAL; this host includes local pending counters; other hosts appear after commit. Normal flush interval is about 30 seconds; persistent lock failures may delay visibility, and unflushed local counters may be lost on process crash."
}
```

`unmatchedRequests` 是 `processedRequests - matchedRequests`。尚未处理任何有效请求时三个时间字段为 `null`。未曾发生命中时 `lastMatchedAt` 为 `null`。`GET /health` 是可选只读健康查询。服务只监听 `127.0.0.1`，只接受 GET 和必要的 OPTIONS 预检，固定路径，不允许 URL 选择文件路径。sandbox `Origin: null` 与同源 loopback only；页面访问必须经宿主代理 token，不可公开映射服务端口。Task 2 不声明空 page；Task 3 提供真实 HTML 后才应声明 `page.service` 并用 `magpie.service`。

SQLite WAL with write-ahead initialization and serialized atomic aggregate updates. Each supported request updates in-memory counters only; a periodic (~30 second) background flush uses a 2 ms SQLite busy wait followed by capped exponential retry scheduling (up to 2 seconds per retry window). A request transform never waits for a database lock. A failed transaction retains pending deltas and reports `degraded`; later cycle/retry can recover. Same-process snapshots include local pending counts; other plugin hosts appear only after commit. The 30-second interval is a normal-operation target, not a guarantee during persistent storage lock/failure. Crash or host shutdown while pending deltas remain may lose this process's uncommitted window; graceful close attempts one bounded flush but cannot guarantee persistence during a continuing lock.



## Iteration status

Task 2 request hook、SQLite aggregate store 与 loopback API 已通过本地完整自动化验收，等待主代理独立审查。插件主机依 `directory` 参数在其配置根写入固定 `session-date-filter/stats.sqlite`，不会写入包目录/`plugins.json`。页面尚未实现，manifest 暂不声明空 page 或 `page.service`。不要安装到生产环境。

纯逻辑及 Task 1 回归：

```sh
npm test
```

Task 2 Bun/SQLite tests:

```sh
bun test test/task2.test.mjs
bun run test:task2:integration
```

实现计划、批准边界、宿主契约证据与当前阶段状态见：
- `docs/superpowers/specs/2026-11-04-session-date-filter-design.md`
- `docs/superpowers/plans/2026-11-04-session-date-filter-plan.md`
- `.superpowers/sdd/session-date-filter/task-2-brief.md`
- `.superpowers/sdd/session-date-filter/progress.md`
