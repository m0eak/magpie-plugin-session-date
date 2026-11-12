# 过滤 debug 设计

日期：2026-11-12，Asia/Shanghai。状态：实现与主代理本地审核已完成，宿主现场验收待进行；尚未提交或部署。最新验证见 [验收文档](../../acceptance.md)。

## 目标与依据

用户需要在开启 debug 后看到过滤器实际删除或替换了什么，以排查“名单仍然出现”和“日期没有移除”。新增能力必须保持日期、标题、助手名单三个过滤功能的输出一致，不能把日志、运行时间或请求标识加入模型请求。

本设计基于当前 `main` 的 `d297d1ca95187f6a15fe7367a0071cb38211ee1f`，以及本机待办 `.superpowers/sdd/2026-11-11-stable-context-replacements/debug-backlog.md`。待办是本机文件，执行者不必依赖它；实施要求以本文和配套计划为准。容量、保留期、接口和独立配置文件是本次规划提出的默认方案。

## 现有接入点

| 位置 | 现有职责 | debug 接入要求 |
| --- | --- | --- |
| `index.mjs` 的 `server(input, options)` | 用 `input.directory` 初始化插件数据目录和本地服务 | 初始化独立 debug 配置与写入器；无目录时只禁用 debug |
| `src/request.hooks.mjs` 的 `createRequestHook` | 协议、请求校验，读取过滤快照并调用转换 | 为每次合格请求读取一次 debug 快照，收集摘要，异步提交 |
| `src/protocols.mjs` | chat / responses / anthropic / gemini 文本定位 | 附加字段路径和角色，不改变协议结构或文本选取 |
| `src/stable-context.mjs` | 助手名单与关联指令替换、日期提示编排 | 在实际替换处报告名单和已知指令短语的编辑 |
| `src/matcher.mjs` | 日期、标题等行的匹配与变换 | 在已确认编辑处报告日期或标题，不记录整个 wrapper |
| `src/service-api.mjs`、`page/` | 认证后的设置与统计页面 | 增加独立 debug 开关、路径和状态 |

debug 不修改匹配规则、环境 user 消息范围、角色顺序、历史保护、既有计数规则或统计库 schema。

## 开关与保存位置

现有 `filter-config.json` 和 `/api/settings` 保持三个布尔键契约。debug 单独使用：

```text
<input.directory>/session-date-filter/
  debug-config.json
  debug/
    filter-<runId>-000001.jsonl
    filter-<runId>-000002.jsonl
```

`debug-config.json` 只接受 `{"enabled":false}` 这一结构，值可为 true；默认 false，首次读取不写文件。配置使用同目录临时文件原子替换、目录 0700、文件 0600，以及跨进程写入锁；不依赖过滤配置是否可用。

目录以宿主传入的 `input.directory` 为准，不自行拼 HOME。普通安装通常落在宿主配置目录的 `session-date-filter/debug/`；XDG 或便携安装跟随宿主目录。页面显示实际绝对路径。

配置读取错误、损坏、缺少有效数据根时，debug 关闭并报告状态，原有过滤继续。跨进程开关传播沿用约 500 ms 的刷新间隔；本进程保存后立即更新。每次请求只取一次快照。关闭不删除既有日志。

## 记录格式

每个支持且通过现有请求校验的请求，最多写一条 JSONL 摘要。没有命中也写 `outcome:"unchanged"`，避免把“没匹配到”误解为“没运行”。不支持的协议和无效请求保持现有提前返回行为，不为日志增加额外扫描。

摘要包含：

- `schemaVersion:1`、仅用于日志的 ISO 时间戳、随机 `runId`、进程内递增 `sequence`、协议名称。
- 实际使用的三个过滤开关快照；过滤配置不可用时为 null，并记录 `outcome:"filter_settings_unavailable"`。
- `outcome:"changed"|"unchanged"|"filter_settings_unavailable"|"filter_error"`。只记录现有控制流已能确认的状态，不猜测未命中原因。
- 转换结果提供的日期删除行、标题删除行、名单替换块、时间提示插入块计数。内部过滤异常用 `filter_error`，不记录原始异常对象。
- 有界 `edits`、未收录编辑数 `omittedEdits` 和截断标记。转换异常时丢弃该次已收集编辑，只留错误摘要，避免将未返回给宿主的中间编辑当成已应用编辑。

当前 `filterRequest` 会在内部 catch 后返回原请求。为区分这种情况与真实无命中，新增可选且受保护的 `diagnostics.onError()`，只在原 catch 分支通知，不传异常对象，不改变该分支原有返回值；通知失败也不能影响原有 fail-open 行为。

每条编辑包含：

| 字段 | 含义 |
| --- | --- |
| `kind` | `current_date`、`tool_session_date`、`topic_title`、`available_agents` 或 `agent_instruction` |
| `action` | `delete` 或 `replace`，对应实际编辑 |
| `path` | 原请求文本字段的 JSON Pointer，如 `/messages/1/content` 或 `/system/0/text` |
| `role` | 实际消息角色，或协议级 system/instructions 字段的 system 语义 |
| `stage` | `agent_context`、`session_dates` 或 `prompt_metadata` |
| `range` | `{start,end,unit:"utf16",basis:"stage-input"}`，半开区间 |
| `before`、`after` | 脱敏且限长后的实际片段；纯删除的 after 为空 |
| `redacted`、`truncated`、`omittedReason` | 脱敏、截断或省略情况 |
| `insertedTimeGuidance` | 该日期编辑是否实际插入固定时间提示 |

位置按对应阶段输入字符串计算，不宣称是最初请求字符串的原始 offset。名单替换先执行，wrapper 内日期与元数据行随后执行；阶段间不引入复杂的原始位置映射。`path` 始终指向原请求字段。

记录日期被替换成时间提示时，将该实际替换作为一条日期编辑，after 是真实替换内容，`insertedTimeGuidance:true`；不再为同一次插入生成重复编辑。摘要插入计数仍来自现有转换结果。

仅捕获实际编辑的最小片段。名单可包含整个被替换块；关联 `<instruction>` 只捕获被替换的已知短语，不捕获整段 instruction。日期只捕获对应行，不捕获 Memory / Credentials wrapper 的其他文字。

不记录完整 prompt、其他对话、headers、URL、cwd、query、模型、provider、宿主 session 等字段。宿主 hook 没有保证提供 topicId / operationId / requestId，故使用本地 `runId + sequence`，不把 session 冒充 topicId，不写回请求。

## 脱敏与容量默认值

| 项目 | 第一版建议值与行为 |
| --- | --- |
| 敏感内容 | 脱敏 Bearer、Authorization/Cookie、常见 key/token/password/secret 赋值、URL 凭据与敏感查询参数、已知密钥前缀、PEM 私钥块；仅用合成数据测试 |
| 平台 ID | 命中片段里的 `agt_`、`tpc_`、`op_` 标识替换为固定占位符；不另存原值或原文哈希 |
| 单片段扫描上限 | 原片段超过 64 KiB UTF-8 时整段省略，仅记录长度与 `oversize`，不截取可能切断凭据的原文 |
| 单编辑原文 / 替换文 | 先脱敏，再分别截到 8 KiB / 1 KiB UTF-8；不截断多字节字符 |
| 每请求编辑数 | 最多 16 条；超过后只累计 `omittedEdits` |
| 单条 JSONL | 含换行最多 64 KiB UTF-8；继续缩减片段或省略编辑，保留摘要与明确标记 |
| 内存待写队列 | 最多 64 条且合计最多 1 MiB，以先到上限为准；队列只保存脱敏、序列化后的记录 |
| 刷盘 | 最迟 250 ms，或积累到 64 KiB 时触发；单进程仅一个异步写入循环 |
| 单文件 | 最多 2 MiB；达到上限前创建下一分段 |
| 整个日志目录 | 本插件管理的 JSONL 文件合计最多 20 MiB；写入前清理最旧分段腾出容量 |
| 保留期 | 写入前及启用时清理超过 7 天的本插件 JSONL；全部宿主停止或 debug 关闭期间不保证准时清理 |

脱敏是确定性规则，不保证识别任意无标记秘密。标题和助手描述仍可能保留本机排障需要的普通文字，因此第一版不自动上传日志，也不提供“已完全脱敏”的承诺。凡整段省略或截断，查看者都能从标记得知。

容量不足、锁竞争、队列满或写盘出错时丢弃相应新记录，增加本进程 `droppedRequests`；不阻塞模型请求，不改过滤结果。不会为了写日志无限重试、无限缓存或回退打印原片段。

## 多进程、轮转与故障隔离

`runId` 是启动实例随机标识，文件名不能只用 PID。新建日志目录使用 0700，新建日志文件使用 0600；创建及追加不跟随同名符号链接。多个宿主可能共用数据目录，需要专用目录写入锁覆盖“清理、核算、轮转、追加、关闭文件”这一整批操作。

实现沿用仓库已有 mkdir 锁的思路，但必须满足以下明确条件：

1. 异步锁竞争最多 250 ms；拿不到则丢弃本批，只影响 debug。
2. 锁含随机 owner token 和 PID；释放必须核对 token。活进程的锁不能单凭年龄回收。
3. 只在 owner 被证明已退出时尝试回收；使用单一回收者、owner 复核和退休目录重命名，避免旧回收者删除新 owner 的锁。PID 已复用且仍存活、权限不足、owner 元数据缺失或无从证明退出时，保守停止本次日志写入并显示 `lock_unavailable`，不猜测、不强删。
4. 每批只在持锁期间打开目标 JSONL，关闭后才释放锁；不得保留锁外文件句柄。这样清理不会删除另一进程正在写入的文件。
5. 自己的上次分段若已被清理，分配新的分段，不依赖文件仍存在。只清理严格符合本插件文件名且经 lstat 确认的普通文件，不跟随符号链接、不清理未知文件。
6. 清理失败或无法确认容量足够时不追加。追加失败后关闭句柄并尽力移除或截回本次未完成的尾行；无法修复的尾行不追加续写，下次换新分段。其已占空间仍计入总额。

锁不自动破坏性抢占。异常退出在 owner 初始化前遗留的无法验证锁，可能需要用户在相关宿主停用后清理；页面必须显示锁故障，而不能悄悄声称正在记录。这是第一版选择的保守故障边界。

配置读取、编辑观察回调、脱敏、序列化、入队、写盘、清理、关闭的异常均独立捕获，不能使主转换抛错或放弃已有过滤。可选观察回调返回值不参与文本变换，也不把额外 debug 字段挂到请求 body。

关闭时停止新采集，丢弃尚未开始写入的队列；已经开始的单批写入允许完成。队列标注启用代次，关闭再开启不能把上代未写记录补写。退出不等待无上限 flush；在途批次以外的记录允许丢失，累计统计不受影响。

## 页面与本地 API

增加认证的 `/api/debug`，沿用已有 Bearer token、Host/Origin 和 CORS 边界。GET 读配置及本进程写入状态，PUT 只接受完整的 `{enabled:boolean}`；其他字段、类型、方法均拒绝。不提供日志正文、下载或清空接口。

正常 GET/PUT 返回：

```json
{
  "settings": {"enabled": false},
  "status": {
    "state": "disabled",
    "directory": "<实际日志目录或 null>",
    "queuedRequests": 0,
    "writtenRequests": 0,
    "droppedRequests": 0,
    "lastWriteAt": null,
    "lastErrorCode": null
  }
}
```

`state` 为 `disabled`、`ready`、`degraded` 或 `config_unavailable`。配置不可读时 GET 返回 503，settings 为 null，status 标识配置故障；PUT 可通过保存完整合法配置修复。写入器故障但配置可读时返回 200，state 为 degraded，用户仍可关闭 debug。错误仅使用固定错误码，不透出原始异常正文。written / dropped / queued 是本进程数据，不冒充所有宿主的汇总。

页面增加第四个独立开关“调试日志 / Debug logging”，显示实际目录、写入状态和丢弃条数。关闭时不显示“正在记录”；ready 表示采集就绪，最近成功时间单列显示。配置保存失败回滚该开关，并显示 debug 错误。debug API 故障不能禁用已有三个过滤开关或清空统计。

UI 使用独立的 `src/debug-ui.mjs` 请求/校验函数，复用现有 token 传入方式，但不把 debug 结构加入原 `validateStats` 或 `readFilterSettings`。

## 验收与实施边界

- 同一输入、同一过滤配置，debug 关 / 开 / 配置损坏 / 任意日志组件抛错，最终 body 与原有分类计数深度相等；body 的 JSON 序列化逐字相等。
- 四协议、字符串与文本块、环境首条 user、三个过滤开关全部 8 种组合都覆盖。
- 纯名单命中即使删除行数为 0 也能记录；重复过滤后的无变更只写 unchanged，不伪造编辑。
- 编辑位置对应实际阶段输入；原始日期、名单、关联短语可定位，其他系统文字、普通 user 和历史不进入日志。
- 用合成秘密验证先脱敏后限长；覆盖多行、截断边界、超大匹配片段、Unicode、未知异常。
- 真实临时目录与两个测试子进程验证不交错、总容量、清理、竞争和崩溃锁边界；不使用真实宿主数据和模型请求。
- 页面认证、开关保存与故障隔离，以及关闭、轮转、队列满、写失败均有测试。

本设计初稿仅用于规划；用户随后授权由一名 Luna 子代理实施，主代理已亲自审核并完成本地验证。实施中将采集与写入职责集中在现有转换模块和 `src/debug-writer.mjs`，页面交互保留在 `page/app.mjs`，没有新增独立 UI 模块。当前未 commit、push 或部署，宿主人工验收仍待进行。
