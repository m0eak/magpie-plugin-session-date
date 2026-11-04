## 目标与边界

为 magpie 构建独立插件 `Session Date Filter`，只在公开 hook 允许的位置变换请求中的 LobeHub Memory/Credentials system prompt，并在后续阶段实现隐私友好的聚合计数。当前只执行 Task 1：独立 package 基础、纯函数 matcher / 协议适配、README 初稿与测试。绝不实现 hook、stats 持久化、HTTP service、页面、完整 manifest 或部署。

不修改 LobeHub 或 magpie 源码，不访问线上服务或生产数据，不读密钥，不发模型请求，不安装全局依赖，不创建远程仓库、不 push、不发布、不部署。只在本工程工作。

## Task 1 — 本阶段执行

**文件职责**

- `package.json`：合法 npm 包名 `lobehub-plugin-session-date-filter`；ESM；Node 内置 `node --test` 测试脚本；明确 `files` 发布白名单，仅包含 `src/` 与 `README.md`；不声明未核验的宿主 hook/page manifest，不加运行依赖。
- `src/matcher.mjs`：导出 `stripSessionDates(text) -> { text, removedLines }`。限于经核验的 LobeHub `<tools description="The tools you can use below">`、`<tool name="Memory">` / `<tool name="Credentials">`、`<tool.instructions>`、`<session_context>` 结构与目标日期整行；保护 fenced code、引用和普通正文；异常输入 fail-open。
- `src/protocols.mjs`：导出 `filterRequest(body, protocol) -> { body, removedLines, supported }`。显式支持 chat / responses / anthropic / gemini 中约定的合法 system/developer 文本；其他文本/结构保留。无变更和 unsupported 返回原引用；改动时只复制必要路径，不修改输入；不做 hook / stats / HTTP side effects。
- `test/matcher.test.mjs`、`test/protocols.test.mjs`：先写断言并观察正确的 red，再实现，覆盖正负路径、四协议、malformed fail-open、元数据与输入不变性等。
- `README.md`：记录用途、边界、当前开发阶段、非缓存命中承诺及 Memory 相对时间提示的潜在影响。
- `docs/superpowers/specs/2026-11-04-session-date-filter-design.md`：冻结主代理批准的八条规格。
- `docs/superpowers/plans/2026-11-04-session-date-filter-plan.md`：本执行计划。
- `.superpowers/sdd/session-date-filter/task-1-brief.md`：任务 1 派遣简报。
- `.superpowers/sdd/session-date-filter/progress.md`：持久阶段账本，不清理。
- `.superpowers/sdd/session-date-filter/task-1-report.md`：测试、源码证据、提交与风险报告；提交后生成以记录实际 SHA/status。
- `.superpowers/sdd/session-date-filter/task-1-review.patch`：提交后从基线生成的完整 review patch；新仓以 `git show --format=fuller --stat --patch HEAD`。

**接口与行为契约**

```js
stripSessionDates(text) // -> { text: string, removedLines: number }
filterRequest(body, protocol) // -> { body, removedLines: number, supported: boolean }
```

`protocol` 只识别 `chat`、`responses`、`anthropic`、`gemini`。只处理 chat `messages[]` 中 system/developer 的字符串 content 与 `type=text` / `type=input_text` blocks；Responses `instructions` 和 type=message 且 role=system/developer 的 `input[]` 字符串 / `type=input_text` blocks；Anthropic 顶层 `system` 字符串 / `type=text` blocks；Gemini `systemInstruction` 字符串或 Gemini Part 的 `text`（允许 thought / thoughtSignature 元数据；混有其他未知字段则 fail-open）。未知字段和 malformed block 保留，不抛给网关。按协议字段识别文本块，不扫描任意对象里的 `text` 字段；Gemini Part 按其官方 `text` 文本成员加已知文本元数据识别。wrapper 跨 block 则不拼接、不匹配。

**验收命令**

```sh
node --test test/matcher.test.mjs test/protocols.test.mjs   # red 预期非零；实现后 green 预期零
npm test                                                   # 全部测试通过
node --check src/matcher.mjs && node --check src/protocols.mjs
npm pack --dry-run

git diff --check
git status --short --branch
git show --format=fuller --stat --patch HEAD
```

本工程无依赖，故不生成 lockfile。使用已有 Node/Bun/Git；禁止全局安装。一次本地 commit；不 push。

## Task 2 — 后续阶段，不属于本次执行

核验宿主公开 `onRequest` 真实接口及 gateway/provider-routing lifecycle；验证每个客户端 HTTP 请求只计一次且 provider fallback 不重复；实现 fail-open matcher 集成与隐私聚合 stats，约 30 秒异步 flush 和多 host 持久化合并；按实际 Bun/SQLite 能力做并发与故障测试；实现 loopback page.service 只读统计 API。不得假定共享内存或凭空保证跨进程 exactly-once。

## Task 3 — 后续阶段，不属于本次执行

实现紧凑 sidebar 统计 UI、light/dark/onTheme、状态与四计数/时间字段；按已核验的 page-fingerprint / 宿主设计处理 page/service，不开放监听端口、不绕过 CSP/token 校验；补齐准确 manifest、宿主原生安装/模拟请求集成、package 检查和最终文档。交付前由主代理另行安排独立审查。

## 当前阶段风险与回滚

主要风险是 prompt 包装格式变动和合法协议 text-block 形态差异；用严格 allowlist / fail-open 和合成 fixtures 控制。完全伪造同一 XML wrapper 的普通正文不可语义可靠地区分，需在 README/报告明示。Session date 删除可能影响缺少消息时间戳的 Memory 相对时间 fallback。新工程初始路径已检查不存在；以 feature 分支开发。若实现需回滚，只需保留报告后 revert 本地提交；不触碰参考仓库。
