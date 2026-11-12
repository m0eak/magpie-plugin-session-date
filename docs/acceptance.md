# Local acceptance summary

Recorded on November 8, 2026. The session date filter passed local Web integration acceptance for the source snapshot based on `ddc384ce4674bd70b2638c28624c15a97d8b11d8` plus the accepted working changes. It has not been published or deployed.

## Recorded environment and checks

The recorded host was version 0.1.3319, with Bun 1.3.10, Node.js v22.23.0, Chromium 149.0.7827.55, and Playwright Core 1.61.1. The recorded checks reported:

- Node test suite: 84 passed, 0 failed, and 8 Bun-only checks skipped.
- Bun test suite: 62 passed and 0 failed.
- Bun integration check: passed.
- Local host acceptance covered plugin loading, the page/service bridge and token checks, filtering counts, narrow layout, refresh and stale-state behavior, persistence and restart readback, and the documented remove-and-restart uninstall flow.

The integration used an isolated local host and a synthetic loopback upstream. It did not send real business model requests. These are results recorded in the acceptance evidence; this publication preparation did not rerun the test suites.

## Limits

Acceptance applies to the recorded environment. The desktop statistics page, other host versions, and real-world cache benefits were not verified. Known Gemini media and code parts can increase the unmatched-count denominator. Statistics count prompt transformations and do not measure model cache hits or token savings. Pending increments can be lost if the process exits abnormally before persistence. Removing a plugin registration may require restarting host processes that loaded it.

## Follow-up source validation

On November 11, 2026, the source changes for independent date and topic-title controls, category counters, and concurrent settings updates passed local validation on the merge candidate. Node reported 108 passing tests, 11 skipped, and 0 failures; Bun reported 67 passing tests, 1 skipped, and 0 failures. The local integration check passed for the hook, read-only HTTP service, owner-only permissions, and four-process SQLite aggregation. `npm pack --dry-run --json --ignore-scripts` listed 18 package files.

This follow-up did not repeat the November 8 host acceptance, install or reload the plugin in a running host, publish a package, send real model requests, or measure provider cache behavior. The host acceptance above remains limited to its recorded November 8 source snapshot.


## 固定上下文替换

2026-11-11 增加日期与助手名单的固定提示变换：日期行仍按原规则移除，并仅在确实移除合法日期行的文本区域插入一份固定 `current_time_guidance`；助手列表由独立的 `availableAgents` 开关控制，默认关闭，命中时将完整块原位替换为固定 Agent Management 工具说明。列表替换块数、列表命中请求数和时间提示插入块数独立计量，名单替换不计入删除行数。相同固定输出再次处理不会再次命中。

助手名单在 system/developer 内容按有界、配对正确的结构规则匹配，并保护 Markdown 引用和代码围栏。在 chat、Responses、Anthropic、Gemini 中，user 角色仅在会话开始的首条合格环境消息检查：可独立包含完整顶层 `<agent_management_context>`，或与宿主已知的 `<user_memory>`、`<expertise>`、`<group_context>`、`<discord_context>`、`<plan>`、`<agent_knowledge>`、`<agent_documents_index>`、`<agent_document>`、`<available_tools>`、`<current_agent_context>`、`<current_group_context>` 和 `<onboarding_context>` 顶层块合并。只替换名单块，其他环境块和周围环境文字原样保留；不处理 user 日期或标题。assistant/model/tool/function 调用或结果之后的 user 消息不属于环境候选。插件拿不到已被宿主清理掉的 `systemInjection` 标记，因此文本无法证明一个完整结构是否由宿主生成；对完整仿造同一宿主环境结构的正文不声称零误匹配。没有合法名单块时不会改写旧指令或插入替代提示。此处理不保证宿主其他动态块或名单块整体出现/消失时的缓存稳定性。

时间提示插入数按实际写入的文本块统计，可大于命中请求数；每个新插入提示必须对应其文本区域中被移除的日期行。统计校验要求每个命中请求至少有一条移除行或一个名单替换块，因此纯名单命中（0 删除行、1 替换块）有效，而没有任何实际改动的命中记录会使统计降级。

旧两键配置会在读取内存中补 `availableAgents: false`，不会因读取而写回文件。新版本保存后使用三键格式，旧二进制严格拒绝未知第三键。统计 API 的 `schemaVersion` 仍为 1；SQLite 内部 schema 已迁移到 2，旧二进制不支持升级后的数据库。所有共享数据目录的宿主必须统一版本。若需回滚并保留旧版统计，应在升级前以一致性方式备份旧数据，并在回滚时恢复该兼容备份；仅恢复两键配置不能兼容 schema 2 数据库，恢复升级前备份会丢失升级后的新增计数。本项目不提供现场拷贝或删除数据库的回滚命令，也未执行备份或迁移。

启用第三开关前统一升级所有加载插件的宿主进程；回滚旧版前关闭新开关并恢复两键设置格式。SQLite 旧版累计统计保留，新增类别从迁移后计数，不追溯分配。

本地合成测试证明变换输出确定且幂等，不构成真实 provider 缓存命中或 token 节省证据。

## Debug 日志边界（2026-11-12）

Debug 默认关闭。开启后，只将实际匹配到的名单块、已知 instruction 替换短语、日期/标题行，以及合格请求的无命中摘要写入 `<input.directory>/session-date-filter/debug/`。日期和标题事件在 matcher 实际删除处捕获，offset 对应所标记的变换阶段输入；不会对整份 prompt 做首尾 diff。日志只带本地 runId、sequence、协议和字段路径，不含宿主会话标识、headers、模型、provider、cwd 或完整 prompt。

写入前按固定规则脱敏，并限制单片段 8 KiB / 1 KiB、原片段超过 64 KiB 整段省略、每请求最多 16 个编辑、JSONL 单文件 2 MiB、目录合计 20 MiB、保留 7 天。队列上限 64 条 / 1 MiB，250 ms 或积累到 64 KiB 时写入。配置、观察器、锁或磁盘错误只影响 debug 状态；关闭开关会丢弃尚未写入队列。页面没有读取、下载或清空日志正文的接口。

本地 Node/Bun 合成测试覆盖 debug 开关、四协议输出等价、多进程日志写入、轮转与脱敏。宿主内嵌页面尚未现场验收；需由用户开启开关后检查本机插件数据目录，并确认关闭 debug 后新请求不再追加日志。

2026-11-12 主代理独立审核后的本地验证：`npm test` 的 Node 阶段 161 通过、18 跳过、0 失败；Bun 阶段 80 通过、1 跳过、0 失败，并通过真实本地 HTTP 的 debug API 集成。Node 下需 Bun 的页面/服务用例在 Bun 阶段实际执行；未启用的可选真实宿主检查不作为覆盖。另通过 13 个改动 ESM 文件的语法检查、差异检查和打包清单检查（21 个文件，无运行时日志、配置或数据库）。独立故障复现确认采集异常不改变最终过滤 payload，明确标记的合成凭据完成脱敏，实际 HTML 的禁用开关在合法读取后可用，关闭时记录不重复计入丢弃数。所有验证使用临时目录、合成请求或本地 HTTP，未调用真实模型 API；这些结果不等同于宿主内嵌页面现场验收或供应商缓存命中证明。
