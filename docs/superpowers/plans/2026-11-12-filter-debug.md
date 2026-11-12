# 过滤 debug 实现计划

> **实施记录：** 六项实现任务已由单一 Luna 子代理完成，主代理已亲自审核并独立验证通过。清单保留实施前步骤作为审核索引，不作为当前未完成状态。宿主现场验收与发布尚未进行；最新验证见 [验收文档](../../acceptance.md)。

**目标：** 独立开启 debug 后，可以在本机查看过滤器实际处理的片段与无命中摘要，且发给模型的请求不受 debug 影响。

**架构：** 在现有匹配位置加入可选、异常隔离的编辑观察接口，由协议层附加字段路径，由请求 hook 汇总。独立 debug 配置控制有界脱敏采集和异步 JSONL 写入；本地认证 API 和页面负责开关、路径及状态，原过滤配置和统计契约保持不变。

**技术栈：** JavaScript ESM、Node 内建测试、Bun 测试与现有 Bun 本地服务、内建 fs/crypto；不新增生产依赖。

**规格：** [过滤 debug 设计](../specs/2026-11-12-filter-debug-design.md)。基线为 `main` 的 `d297d1ca95187f6a15fe7367a0071cb38211ee1f`。

## 全局约束

- 当前选定 worktree 内实施，先确认实际工作区状态；不得覆盖用户修改。
- 只运行一名实施子代理，模型为 `remote-magpie/cliproxy/gpt-6-luna`；主代理在子代理工作时等待，收到结果后亲自 review。
- 任务以明文交付，并让代理先用一句话确认理解；此前无完整上下文的派发曾被当成密文，不可把代理未读懂任务当成已实施。
- 不调用真实模型 API，不使用或输出真实密钥，不读取真实请求做测试，不碰 TokenHarbor。
- debug 默认 false；与三个过滤开关独立。不得给 `filter-config.json` 增加第四键，不更改 `/api/settings` 和统计库 schema。
- 单文件 2 MiB、插件 JSONL 总量 20 MiB、保留 7 天；过期清理发生在启用或写入前。
- 单记录含换行最多 64 KiB UTF-8；每请求最多 16 条编辑，原文 / 替换文分别最多 8 KiB / 1 KiB；原片段超过 64 KiB 时整段省略。
- 待写队列最多 64 条且最多 1 MiB；最长批次触发延迟 250 ms、锁竞争最多 250 ms。
- debug 关闭不创建日志目录、不额外采集片段；关闭不删除既有日志。
- debug 故障不能影响过滤结果、统计结果、模型请求字段、角色顺序和前缀文本。
- 日志片段不进入 stdout、stderr 或宿主应用日志；只使用合成秘密。
- 计划创建时仅有规划授权，用户后续的“luna开干吧”已授权实施；commit、push、合并和部署仍需用户后续指令，计划中的完成步骤不能自行转化为发布授权。

## 文件与职责

| 文件 | 操作 | 职责 |
| --- | --- | --- |
| `src/debug-config.mjs` | 新增 | 严格单键配置、原子更新、跨进程刷新、损坏隔离 |
| `src/debug-events.mjs` | 新增 | 有界编辑收集、脱敏、UTF-8 限长、请求摘要序列化 |
| `src/debug-log.mjs` | 新增 | 独立日志队列、跨进程目录锁、容量轮转、运行状态与生命周期 |
| `src/matcher.mjs` | 修改 | 日期、标题实际编辑的可选观察接口 |
| `src/stable-context.mjs` | 修改 | 名单及最小指令短语编辑观察接口 |
| `src/protocols.mjs` | 修改 | 四协议的字段路径、角色和观察接口传递 |
| `src/request.hooks.mjs` | 修改 | 单请求 debug 快照、摘要收尾；不改返回体契约 |
| `index.mjs` | 修改 | 初始化 debug 配置与运行实例，连到本地 API |
| `src/service-api.mjs` | 修改 | 认证 `/api/debug`，生命周期清理 |
| `src/debug-ui.mjs` | 新增 | debug API 请求、严格响应校验，独立于过滤与统计 |
| `page/app.mjs`、`page/service.html` | 修改 | 独立开关、目录与状态 |
| `test/debug-*.test.mjs`、`test/fixtures/debug-*.mjs` | 新增 | 采集、脱敏、写入、API、UI、故障与多进程验证 |
| `package.json` | 修改 | 将新增测试纳入当前显式测试入口 |
| `README.md`、`docs/acceptance.md` | 修改 | 默认行为、路径、数据保留、异常边界和验证范围 |

`src/filter-config.mjs`、`src/stats-store.mjs`、`src/page-bridge.mjs` 不预设需要修改。不得为共享少量逻辑先做无关重构；若复用锁模式，必须复核其 owner / 回收行为满足新规格。

## 接口约定

下列接口是本计划选定的模块边界；内部辅助函数由实施者保持简洁。

```js
// debug-config.mjs：directory 已经是插件数据根。
createDebugConfigStore({ dataDir, refreshMs = 500 })
// -> { snapshot(), replace({ enabled }), close() }
// snapshot() -> { enabled:boolean } | null；null 表示配置故障。

// debug-events.mjs：只在 enabled 快照为 true 时构造。
createDebugCollector({ runId, sequence, protocol, settings, timestamp })
// -> { observe(edit), finish({ outcome, counts }) }
// finish -> 一个已脱敏、UTF-8 限长且含换行的 JSONL 字符串。
// filter_error 时 finish 丢弃中间 edits；observe/finish 均由外层保护调用。

// debug-log.mjs
createDebugLog({ directory, clock, fs, limits })
// -> { runId, beginGeneration(), enqueue(line, generation),
//      recordDrop(code), disable(), snapshot(), close() }
// beginGeneration 返回启用代次；enqueue 不等写盘、不过量保留。
// disable 丢弃未开始批次，close 有界关闭；均不抛至请求 hook。
// 采集/序列化失败用 recordDrop(固定码) 更新本进程诊断，不传原始错误。

// protocols.mjs：保留原三参调用兼容。
filterRequest(body, protocol, settings, diagnostics)
// diagnostics 可省略，形如 { onEdit(edit), onError() }。
// 返回结构保持原样，不附 debug 信息。
```

统一 Edit 字段见规格。协议层为文本字段绑定 `path` / `role`；转换层补 `kind` / `stage` / `range` / before / after；观察回调只在确认实际编辑后触发。任何观察异常均在靠近调用点的位置吞掉，不让主转换的 catch 因 debug 放弃过滤。原 catch 分支受保护地调用 `diagnostics.onError()`，让 collector 标记 filter_error 并丢弃中间 edits，不改变原返回值。

`transformPromptText` 继续使用现有第三参 context，增加可选 `observe`；matcher 的内部 options 传递受保护观察函数与阶段名，不将它混入持久化过滤设置。

## 任务一：独立配置和有界脱敏记录

**交付物：** 在没有请求 hook 和 UI 的情况下，可独立验证配置兼容、采集和序列化边界。

- [ ] 新增 `test/debug-config.test.mjs` 与 `test/debug-events.test.mjs`，使用临时目录及合成片段。断言默认关闭且读不写、严格布尔校验、无效/缺失数据根、损坏 debug 配置不影响原三键配置、原子保存与约 500 ms 跨实例同步。
- [ ] 断言 before/after 只包含传入的匹配片段；Bearer、Cookie、键值凭据、URL 凭据、PEM、平台 ID 均按规格脱敏；覆盖多行、秘密跨截断边界、中文和 emoji、超大原片段整段省略。
- [ ] 断言 16 条上限、64 KiB 最终记录上限、正确 omittedEdits、filter_error 不留中间编辑、无命中合法空 edits。不得为满足断言把原始片段哈希落盘。
- [ ] 运行 `node --test test/debug-config.test.mjs test/debug-events.test.mjs`，确认缺少模块或行为时失败。
- [ ] 实现 `src/debug-config.mjs` 和 `src/debug-events.mjs`。沿用现有原子写、权限与配置更新模式，但使用独立文件与状态。遇到超大原片段先判断 UTF-8 长度，超过扫描上限直接省略；正常片段先脱敏，再按 UTF-8 字节预算截断。
- [ ] 重跑本任务测试；检查日志字符串中不含测试秘密、无效 Unicode 或无关 prompt 文字。

**通过标准：** 新配置不改变旧过滤配置或其校验；finish 得到完整 JSONL，所有省略可辨认，没有秘密原值或原始身份哈希。

## 任务二：实际编辑采集和四协议位置

**交付物：** 转换器可通过观察接口提供实际编辑，默认调用输出与基线相同。

- [ ] 新增 `test/debug-transform.test.mjs`。为四协议构造日期、标题、名单、关联指令、环境 user、文本块、围栏与历史夹杂样本；对三个过滤开关的 8 种组合，比较无观察 / 有观察 / 观察抛错的 body、引用不变要求及既有计数。
- [ ] 针对每个 kind 断言 before/after、字段路径、角色、阶段与半开区间。至少包含先名单替换再日期处理、wrapper 日期后元数据处理，防止把阶段 offset 说成原文 offset。
- [ ] 覆盖 0 删除行的纯名单命中、重复过滤后的 unchanged、一次日期插入一次时间提示、不重复生成同一次编辑，以及仅已知指令短语被记录。
- [ ] 覆盖转换器内部抛错后仍返回原 body 的现有 catch 分支：onError 被通知、回调抛错也不外泄，collector 丢弃未应用的编辑，返回结构不增加 debug 字段。
- [ ] 运行 `node --test test/debug-transform.test.mjs`，确认新增观察能力缺失时失败。
- [ ] 修改 `src/matcher.mjs`、`src/stable-context.mjs`、`src/protocols.mjs`。在真实编辑点调用受保护 observer；不事后 diff 整份 prompt，不扩大匹配范围，不改变转换顺序。对各协议字段逐项绑定路径，保留原 3 参 filterRequest 兼容。
- [ ] 重跑新测试和 `node --test test/matcher.test.mjs test/protocols.test.mjs test/stable-context-replacements.test.mjs test/manual-review-fix.test.mjs test/prompt-metadata.test.mjs`。

**通过标准：** 观察接口能解释每项实际改动；无观察时不额外构造编辑片段，任意观察异常都不影响已匹配过滤。所有旧保护边界继续通过。

## 任务三：有界、多进程 JSONL 写入

**交付物：** 临时目录内可安全轮转、限制总容量、报告丢弃和写入故障的独立写入器。

- [ ] 新增 `test/debug-log.test.mjs`、`test/fixtures/debug-log-writer.mjs`。通过注入时钟、低容量测试 limits 和受控 fs 故障，验证 250 ms 触发、64 条 / 1 MiB 双队列上限、单文件 2 MiB / 总量 20 MiB 的等价缩小边界、保留期及每条记录完整换行。
- [ ] 用两个真实子进程共享临时目录，验证 runId 不同、无交错半行、总容量清理、跨进程删除旧分段后继续写入、没有锁外打开的日志句柄。
- [ ] 覆盖 owner 活着但年龄很大、退出 owner、回收竞争、PID 仍活着、缺失 owner、owner token 换代、锁竞争超时；不得仅通过 sleep 等待长时限。使用 IPC/标记同步，不用真实宿主进程。
- [ ] 覆盖 ENOSPC/EACCES、删除失败、短写/追加失败、损坏尾行、符号链接和未知文件保护、队列满后丢新记录、关闭与关闭再开启代次切换。
- [ ] 运行 `node --test test/debug-log.test.mjs`，确认缺少写入器时失败。
- [ ] 实现 `src/debug-log.mjs`。锁持有范围包括清理、空间核算、轮转、追加与关闭；写入前预留整批实际字节。严格按规格处理 owner 证明、回收与故障，不引入日志平台或生产依赖。
- [ ] 队列只保留已脱敏 JSONL；append 后及时关闭。错误转换为固定状态码与 droppedRequests，禁止输出记录正文。timer 允许进程自然退出；close 不无限等待。
- [ ] 重跑上述测试。检查每个 managed JSONL 文件大小与合计值，读取每个完整行验证 JSON；未知文件和 symlink 目标内容保持不变。

**通过标准：** 存储和锁故障只损失 debug 记录；多进程不会互删在途文件、误删新锁或在容量不确定时继续追加。

## 任务四：请求 hook 与运行生命周期

**交付物：** 请求层可以按一次快照采集并异步记录，开关与故障均不影响最终 payload。

- [ ] 新增 `test/debug-hook.test.mjs`，给 `createRequestHook` 注入 debug 配置、collector、writer 和时钟替身。覆盖开启、关闭、空路径、配置读取抛错、过滤配置不可用、转换异常、observer/脱敏/finish/enqueue 各自抛错。
- [ ] 对四协议、全部 8 种过滤开关组合，断言仅切换 debug 状态时 hook 的返回体深度相等，`JSON.stringify` 逐字相等，累计统计事件相等。
- [ ] 断言关闭不构造 collector、不生成片段、不入队、不建日志目录；每请求只读一次 debug 快照。无效请求/未知协议沿用早退。
- [ ] 断言 ready 的有效无命中请求产生一条 unchanged；过滤配置不可用产生固定原因摘要；过滤异常不保留中间 edits。纯名单命中不依赖 removedLines 大于 0。
- [ ] 运行 `node --test test/debug-hook.test.mjs`，确认缺少接入时失败。
- [ ] 在 `src/request.hooks.mjs` 和 `index.mjs` 接入 debug 实例。保持现有过滤路径和统计微任务语义，不 await 写盘。处理 hook 先于 server 构造的情况，不能把早期无目录实例永久缓存成不可升级状态。
- [ ] 将写入器 close 接到已有服务 stop/测试 teardown；本地服务监听失败时不使过滤或 debug 初始化互相依赖。宿主若没有统一关闭回调，采用可 unref timer 和进程自然退出，不为此增加新的宿主协议。
- [ ] 重跑新测试和 `node --test test/filter-controls-node.mjs test/recovery-fix.test.mjs`。

**通过标准：** debug 在配置、采集、写入各故障点都属于旁路；无需真实模型即可证明最终 payload 一致。生命周期不挂住测试或宿主退出。

## 任务五：认证 API 和独立页面开关

**交付物：** 用户可以在现有页面独立开关 debug，看到实际路径、就绪/故障状态和丢弃条数。

- [ ] 新增 `test/debug-api.test.mjs` 与 `test/debug-ui.test.mjs`。API 测试用 Bun 本地临时服务和合成 token；UI 延用现有 mock DOM/fetch 风格。
- [ ] 断言 `/api/debug` 的 GET/PUT 认证、Host/Origin、OPTIONS、参数/方法/额外字段拒绝；响应结构和固定错误码满足设计，日志正文从任何路由均不可读取。
- [ ] 断言配置损坏 GET 503、合法 PUT 可修复；写入器故障配置仍可关闭；所有计数标为本进程。不得返回原始异常或请求文本。
- [ ] 断言 debug API 失败仅影响第四开关，旧过滤开关和统计继续可用；保存失败回滚；关闭不显示正在写入；路径以 textContent 渲染。
- [ ] 运行 `bun test test/debug-api.test.mjs test/debug-ui.test.mjs`，确认缺少功能时失败。
- [ ] 修改 `src/service-api.mjs` 和 `index.mjs`，在已有认证边界内增加路由及状态；同步静态资源白名单，加入 `src/debug-ui.mjs` 对应浏览器资源路径。
- [ ] 新增 `src/debug-ui.mjs`，使用函数参数传入现有服务 token，不另存真实 token。修改 `page/app.mjs`、`page/service.html`，独立读取和保存，不让 debug 错误走现有过滤设置的统一禁用分支。
- [ ] 重跑上述测试及 `bun test test/task2.test.mjs test/task3-ui.test.mjs test/task3-bridge.test.mjs test/task3-fix.test.mjs`。

**通过标准：** 不增加日志正文暴露面；用户能确认日志位置、是否就绪及是否丢弃；第四开关独立，旧 API 契约不变。

## 任务六：文档与主代理验收

**交付物：** 明确数据边界、可重复测试入口及完整审核记录；不自动发布。

- [ ] 更新 `package.json` 的显式测试入口，Node 测试纳入 Node 段，依赖 Bun.serve 的 API 测试纳入 Bun 段；确保常规 `npm test` 真正执行新增测试，不把 skip 计为覆盖。
- [ ] 更新 `README.md`，修正当前“完全不保存请求片段/逐请求明细”的无条件陈述：默认仍不保存，开启 debug 后保存有界脱敏的命中片段及摘要。写清独立配置、实际目录、容量/保留期、开关传播、关闭与丢弃语义、锁故障边界；不复制机器实际日志。
- [ ] 更新 `docs/acceptance.md`，区分本地测试通过、宿主现场未验收和日志保留限制，不宣称已部署。
- [ ] 运行 `npm test`、`git diff --check`，并对新增/修改的 ESM 文件运行 `node --check`。仅当实现有新改动或失败时重复相应检查。
- [ ] 使用 `npm pack --dry-run --json` 核对新 src 模块/页面资源在包内，没有本机日志、配置、任务文件或真实数据。
- [ ] 子代理检查脱敏与差异后交回：变更文件、验证结果、已知限制、未提交状态。报告中只使用合成样本，不贴真实密钥或请求。
- [ ] 主代理亲自 review：从 `git diff` 和测试证据检查以下五项高风险失败模式，不因子代理自检通过而省略。

| 审查重点 | 必须看到的证据 |
| --- | --- |
| debug 改变最终请求或使过滤跳过 | 四协议 × 8 组合的开关/故障对照；无 callback 返回值参与转换 |
| 记录错误范围或未生效编辑 | 最小片段、阶段 offset、纯名单命中、幂等及 filter_error 丢弃中间 edits |
| 原文泄漏或无界内存增长 | 合成秘密边界测试、先脱敏后截断、64 KiB / 16 条 / 队列双上限 |
| 多进程轮转竞争或磁盘写满 | 真实双进程、owner token 竞态、持锁写入关闭、总量与错误注入测试 |
| debug 故障连带破坏设置和页面 | 独立配置、旧三键契约、API 认证与 UI 故障隔离测试 |

- [ ] 若发现问题，仍只派一名指定 Luna 修复；主代理等待后再次审核受影响部分。
- [ ] 向用户报告可审阅结果与现场测试方法，等待其当次发布指令；本计划不自动 commit、push、合并、安装或重载插件。

## 规划完成自检

- 需求覆盖：独立开关、原片段、无命中摘要、实际路径、脱敏、容量、保留、失败隔离、payload 一致性均已对应任务。
- 类型一致：单键 debug 配置、Edit、JSONL 摘要和 `/api/debug` 状态以配套设计为准；不新增不存在的宿主关联 ID。
- 执行顺序：先可独立验证的采集/配置，再转换和写入，随后 hook、API/UI；不要求未存在的模块在前置任务中可运行。
- 验证范围：Node/Bun 分工、临时目录、双进程、合成秘密和打包边界均明确。
- 初稿授权范围：当时仅两份规划文档；实施现已取得用户后续授权并完成，发布仍未授权。
