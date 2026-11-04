# Task 2 实施报告（修复轮）

- `src/request.hooks.mjs`: `createRequestHook()` / `onRequest` are at lines 19-58; valid protocol/body guard at 4-16, best-effort `queueMicrotask` aggregation at 27-45, no DB read/write in request path.
- `src/stats-store.mjs`: constants/strict aggregate value validation lines 5-61; runtime configuration and timer lines 64-104; record lines 107-120; secure filesystem/WAL and immediate initialization lines 139-201; committed validation/read lines 203-222; stable API snapshot lines 224-243; bounded async retry scheduling lines 245-283; single atomic aggregate transaction and consume-after-commit lines 285-335; singleton config directory near EOF.
- `src/service-api.mjs`: fixed loopback GET-only API, strict host/origin/method/path checks at lines 12-59.
- `index.mjs`: optional port resolution from the host's actual second `options` argument and default listener management at lines 6-21.
- `test/task2.test.mjs`: protocol counters line 40; cold request-hook and host lock/event-loop/automatic retry test lines 107-173; in-flight record/snapshot race line 175; five fresh+three seeded four-process races line 231; independent four-process seeded race line 301; config-root singleton line 348; HTTP CORS/method/host tests line 396.

## 结论

Task 2 实现与本轮验证已完成，**等待主代理独立复审；不代表 review clean**。当前 BASE 为 `9755c77ceaa12344c2f68f1c34c23ebe32693dbe`，尚未提交。任务范围只涉及本插件；无 Task 3 UI、部署、push、生产/联网/SSH/模型请求。

## 基线与边界

- 唯一工程：本插件 `feature/session-date-filter`；主仓 HEAD `9755c77ceaa12344c2f68f1c34c23ebe32693dbe`。
- 参考宿主为只读 `magpie` HEAD `50265256ba56ac164a680da0689e1c6d90dac471`。其工作区只读核验，不修改。
- 沿用诊断文件 `task-2-diagnosis/diagnosis.md` 及相关探针/日志，不重放历史11轮或Task1四轮。
- 既有tracked `progress.md`、`README.md`、`package.json` 和大量Task1/Task2未跟踪日志、诊断、`test-data/debug-*`/`race-mini` 原样保留。最终 `test-data` 仅剩起始时已存在的非本轮目录；本轮 `task2-${process.pid}` 测试目录已由测试hook清理。未删除、覆盖或reset任何来源不明资源。
- 最终改动文件（按本任务）：`src/stats-store.mjs`、`src/request.hooks.mjs`、`src/service-api.mjs`、`index.mjs`、`package.json`、`test/task2.test.mjs`、`test/task2-integration.bun.mjs`、`test/fixtures/stats-writer.bun.mjs`、`README.md`、新增本轮brief/report/log。`test/fixtures/stats-writer.mjs` 是起始遗留，不作为Node测试自动发现项，未删除。

## 宿主契约证据与实现选择

- `docs/subsystems/gateway-request-hooks.md` 与 `internal/plugin/host.js`：hook 导出 `async onRequest(body, ctx)`，protocol 为 `chat/responses/anthropic/gemini`，`undefined` 保留原body；host在routing前调用一次，provider fallback针对 `onProvider`，本插件未实现`onProvider`。Hook统计通过 microtask转入内存record，不触发SQLite查询/写入。
- `internal/plugin/host.js:1323` 以 `fn(input, p.options)` 调用 default server；`host.js:1271..` 的 `input.directory` 为工作配置目录；`host.go:1133-1160` 从plugin配置传每个包的 `options` 并在input传 `settings.Dir()`。因此 `index.mjs` 使用**第二参数**读取可选 `sessionDateFilterPort`，而非错误读取 `input.options`；默认127.0.0.1:3479，配置端口限定1024..65535，manifest没有虚构空page或page.service。
- `internal/plugin/page.go` 与 `plugin-runtime.md`：`page.service` 只在真实页面文件和host module都存在时有效，service代理走宿主token路径、反代至loopback、移除Cookie并接受sandbox `Origin:null`。Task2只有loopback service，不暴露公网端口；Task3创建真实HTML后方可manifest绑定。
- `internal/plugin/host.go:904` host.stop关闭stdin，等约2秒后结束不退出的Bun host；插件缺少可确认的关闭回调契约。`index.mjs` 不声称async flush能挡住宿主强制停机；close仅best-effort，不宣称reload强制关闭时保证保存。意外进程崩溃/强制终止仍可能丢本进程未提交pending窗口。
- 本机runtime：Bun 1.3.10，Bun内置SQLite 3.51.2，无外部依赖安装。未声明支持早于该实测环境版本。

## 根因修复与语义

- First-open：单一database连接执行WAL切换，之后 `transaction.immediate()` 原子schema验证/建表/seed，取消之前存在分支开库初始化所造成的deferred seed写竞态。未知schema、非SQLite/损坏数据库进入degraded，不删除、不静默重建。
- 同步SQLite busy timeout：初始化WAL/schema/seed上限10ms；运行期flush上限2ms。`onRequest`只内存record；同步DB等待只允许在API/周期后台flush路径出现，pending不会受统计失败影响而丢失。
- Retry：failed BUSY只触发一个 `unref` 退避timer（25/75/200/500/1000ms，最多2秒窗口、有限次数）；在正常30秒周期到期后新一轮可再尝试。成功提交后只减提交快照字段；其间record仍留pending；SQLite transaction成功为唯一消费提交点，无commit后snapshot重提delta。相同host snapshot=committed+local pending；其他host仅commit后可见。正常flush周期约30秒；跨进程读者在当前写进程周期flush后才看到其增量。
- 聚合保存四计数与三个UTC时间字段；不存正文、模型、key、session、provider、agent等明细。坏数据及超安全整数读取不得静默归零。
- 数据目录为宿主 `directory/session-date-filter/stats.sqlite`，目录chmod 0700，DB/WAL/SHM owner-only 0600。
- API GET-only `/api/stats`（可选`/health`）loopback bind，拒绝未知host/origin、method、path/query；仅Origin null/loopback same origin，CORS非通配credential。错误响应只发固定通用状态。
- `package.json` npm test用`&&`显式串行Node纯逻辑测试、Bun Task2测试、Bun真实集成测试；Node不会自动发现Bun专属测试/可执行fixture。任一阶段失败整体失败。

## TDD与验收记录

- 新red：`task-2-recovery-red-baseline.log`，`bun test test/task2.test.mjs`，12/13 pass、1 fail，真实子进程`SQLITE_BUSY`、退出码1。保留，不伪造。
- 最终Node：`node --test test/matcher.test.mjs test/protocols.test.mjs`，57/57，退出码0，`task-2-recovery-green-node-final.log`。
- 最终Bun：`bun test test/task2.test.mjs`，19/19，退出码0，`task-2-recovery-green-bun-final.log`（显式单独运行最终Bun suite，保留`LOCK_METRICS`原始输出）；最终整套`npm test`对应`task-2-recovery-green-suite-final.log`。测试包含四协议计数、unsupported/非法不计、80并发hook、实时外部`BEGIN IMMEDIATE`锁、release后自动重试、锁中hook/eventloop响应、flush期间新增record不被旧snapshot清除、snapshot无重复、未知schema/corrupt/权限、service GET/CORS/method/host拒绝、singleton目录。
- 真实Bun多进程竞争：同一Bun测试中8轮全部通过：5轮fresh空库四进程同步屏障首开 + 3轮已存在schema库四writer同步释放。每轮各writer 25请求，最终精确 `processed/matched/removed/unmatched=100/52/52/48`，UTC started/updated/lastMatched合并期望一致，每个子进程最终status=ok。整体验收平均约1.2秒；保留每轮摘要于final-bun日志。另有seeded writer独立竞争再通过4/4。
- 持锁耗时实测：真实SQLite `BEGIN IMMEDIATE`锁holder下，最终完整npm suite所含锁测量：冷启动onRequest只运行过滤+内存record，观测0.240ms，且断言store.db仍为null；不是通过该hook触发数据库初始化。首次flush Promise总用时11.412ms（含初始化/SQL事务/调度，不等同event-loop阻塞），运行期busy同步wait上限配置2ms；20ms heartbeat实测24.298ms（受OS调度影响，未见秒级卡顿）；pending为1并degraded保留。写入release后自动恢复观测7.214ms（包括轮询与locker退出）。最终持久统计为1/1/1、无重复，状态ok。以上来自Bun 1.3.10本机合成DB；只测一次，不是统计分布或普遍保证。
- Bun集成：`bun run test/task2-integration.bun.mjs`，hook过滤、API只读、owner-only和4进程聚合通过，退出0，`task-2-recovery-green-integration-final.log`（最终suite内集成步骤的命令退出码亦记录于suite log）。测试目录位于工程test-data下并finally清理。
- 最终全套：`npm test`，Node 57/57 + Bun 19/19 + integration均通过，退出0，`task-2-recovery-green-suite-final.log`。
- Syntax检查、`git diff --check`均退出0；`npm pack --dry-run`退出0、8个发布文件，无test-data、诊断、测试和历史日志入包。见`task-2-recovery-pack-final.log`。

## Task3消费的当前接口（仅记录已实现内容，不改变功能）

```js
// src/request.hooks.mjs
export async function onRequest(body, ctx) // 与宿主导出的实际名称；默认导出对象仍通过package的magpie.hooks暴露。

// src/stats-store.mjs
export class StatsStore { constructor({ dataDir, autoFlush = true, flushIntervalMs = 30_000, ... }) ; record(event); snapshot(); flush(); close(); }
export function configureStatsStore({ directory, ...options }); // singleton固定写入directory/session-date-filter/stats.sqlite
export function getStatsStore();

// src/service-api.mjs
export function createService({ store, port = 3479 }); // Bun.serve，只bind 127.0.0.1
// GET /api/stats -> {schemaVersion:1,status:'ok'|'degraded',stats:{processedRequests,matchedRequests,removedLines,unmatchedRequests,startedAt,updatedAt,lastMatchedAt},persistence}

// index.mjs
export default { id:'session-date-filter', async server(input, options) { ... } };
// package options第二参数可指定sessionDateFilterPort；无page/service manifest时仅供本地测试或进程内使用，Task3要加真实page后才能绑定代理路径。
```

状态`degraded`表示本地storage/schema/SQLite不可用或lock提交失败；同host快照仍合并pending，但跨host未提交计数不可见。Task3页面应只展示聚合数与时间、状态和约30秒正常flush说明，不提供正文、模型或身份明细，不增加reset/写API。路径仅取宿主`input.directory`，不接受UI/URL用户给的文件路径。宿主server `options`位于第二实参；不可读`input.options`。

## 已知局限/审查关注

1. 锁重试在单次窗口内最多2秒；持续锁定时status degraded、pending留在内存，等待后续30秒周期，不承诺固定30秒可见。
2. 强制终止/reload可中止Bun进程，未flush内存窗口可能丢；不承诺跨进程/崩溃exactly-once。
3. plugin-host可能不提供专属优雅插件dispose hook；本代码不挂process signal以避免改变宿主进程信号链，server主动留给host管理，Task3需与host page生命周期再次核对。
4. 默认3479在真实宿主部署前未验证占用/绑定；如果其他进程占用host启动会失败，不伪装为插件拥有者。Task3和安装前须审慎核对本机端口/`page.service`同port设置。
5. API CORS允许sandbox null和严格loopback same-origin；宿主token反向代理契约来自指定只读宿主源码。Task2暂未真实页面调用API。

## 工作区与交接

- 本地分支当前HEAD仍为BASE `9755c77ceaa12344c2f68f1c34c23ebe32693dbe`，未提交、未push。
- `progress.md`目前含之前Task1/Task2内容并可能存在既有格式问题；Task2进度应在追加完整验收数据后更新，不能覆盖Task1历史。
- 提交前应按本报告复核，并至少独立检查`index.mjs` server第二参数、`stats-store.mjs`提交边界/重试退避、Bun真实并发日志和npm pack白名单。只有主代理审核确认后才决定是否本地commit及生成 BASE..HEAD patch；当前没有review patch，也不启动Task3。

---

## 历史阻塞报告（保留原状态与历史失败；被上方本轮实测结果取代）

> 以下为Task2修复前的阻塞摘要。其失败日志、诊断探针和报告历史仍保留；不得把其中旧失败描述当作当前最终状态，也不删除该失败证据。

# Task 2 implementation report (amended status)

**This report supersedes earlier optimistic/intermediate notes. Task 2 is not ready for review or commit.** The implementation is incomplete because four Bun processes sharing the DB still intermittently produce `SQLITE_BUSY` on flush; the exact transactional merge acceptance is not met. No Task 2 commit has been made. Keep the working tree and all evidence intact; do not stage/commit or report clean.

### 历史确认的宿主契约

- Read-only reference host HEAD: `50265256ba56ac164a680da0689e1c6d90dac471`; host worktree was clean. Source/docs reviewed: `docs/subsystems/gateway-request-hooks.md`, `gateway-middleware.md`, `plugin-runtime.md`, `internal/plugin/gateway.go`, `page.go`, `host.js`, `host.go`, `internal/gui/pageservice.go`, `pluginpage.go`, `pagebridge.js`.
- The published request hook is `export async function onRequest(body, ctx)` with `ctx.protocol ∈ {chat,responses,anthropic,gemini}`; `undefined` preserves original. It executes before routing. Provider fallback reruns only `onProvider`; this plugin has no such export and no `onResponse`.
- `internal/plugin/host.js:1271-1345,1395-1445` loads the gateway hook and the package's main/default OpenCode server in the same Bun plugin-host process, so their module singleton can be shared. It clones body and validates/rolls back hook errors. `host.go:1153-1164` passes `settings.Dir()` as plugin-host `directory`; `settings.go:1474-1482` documents the config root. Fixed data path is `<directory>/session-date-filter/stats.sqlite`, not the install package, `node_modules`, `plugins.json`, or static assets.
- `internal/plugin/page.go:44-61,192-198` only accepts `page.service` when a real page file and host-side module both exist. `internal/gui/pluginpage.go:280-309,330-337`, `pageservice.go:88-127,138-149`, and `pagebridge.js:6-22` establish host warmup, loopback reverse proxy, Cookie removal, sandbox `Origin: null`, page-token URL, and `magpie.service`. Because Task 3 HTML does not exist yet, package has no `page` entry. Task 2 exposes API internally only; Task 3 must add a real page and then bind service port.
- Local runtime: Bun 1.3.10, SQLite 3.51.2, built-in `bun:sqlite` verified. No dependencies installed. Floor v0.1.1999 remains unverified / not advertised.
- Statistics contract intended: processed once per supported protocol/legal body, including no-match; matched once per request with actual removal; removedLines counts actual lines; unmatched derived; UTC timestamps, no content/identity/detail. Per-request pending is in-memory, async ~30s flush, store failures must not block transform. Only same-process pending is included in snapshot; other hosts visible after commit. Sudden crash can lose local unflushed window.

### 历史未提交实现文件记录

- `src/request.hooks.mjs`: public async `onRequest`, calls Task 1 `filterRequest`, returns undefined if no match, does not mutate body, no exception text logged. It counts validated body even if matcher unexpectedly throws (processed-but-unmatched).
- `src/stats-store.mjs`: Bun SQLite schema v1, fixed data directory, WAL, parameterized transaction for aggregate increments, UTC times and owner-only modes, degraded generic status and safe API shape. This module currently contains iterative fixes and should be reviewed carefully; avoid trusting intermediate status claims.
- `src/service-api.mjs`: loopback GET-only API plus OPTIONS; host/origin allowlist; generic errors, no paths/stacks.
- `index.mjs`: plugin server entry; starts API at fixed 127.0.0.1 port 3479 and configures shared store.
- `package.json`: declares hook + main and no page. Scripts include Node tests and Bun tests.
- `test/task2.test.mjs`, `test/fixtures/stats-writer.bun.mjs`, `test/task2-integration.bun.mjs`; legacy `test/fixtures/stats-writer.mjs` existed. `test-data/` and debug fixtures existed and were not safe to remove without checking ownership.
- `README.md`, SDD `task-2-brief.md`, `progress.md`, `task-2-report.md` contained interim text before this recovery run.

### 历史失败与根因状态

- `task-2-red-api.log`: valid expected missing-module failure, exit 1.
- Intermediate `task-2-green-iteration*.log` / `task-2-green-final*.log` were historical; many were failed iterations. They are not final green evidence.
- `task-2-green-integration-final2.log`: one standalone integration run passed at the time (hook, read-only HTTP service, permissions, and four-process aggregate on a seeded WAL DB). Later concurrent writer tests still had failures, so that run alone did not establish repeatability.
- `task-2-green-final11.log`: 12/13 pass; child-process SQLite merge failed with `flush status degraded busy`.
- `task-2-npm-test-final.log`: 64 pass / 9 fail. Failures included Node auto-discovering Bun-only `.bun.mjs`, fixtures, direct `bun:` imports under Node, `Service requires Bun`, and a storage persistence failure. Historical Task1 portion in that run passed 58/58, but complete suite failed.
- 历史阻塞点：四进程共享数据库曾间歇`SQLITE_BUSY`；当时忙等上限为5000ms会卡event loop；没有可靠的后台重试，因此pending会留到进程退出丢失。

> 上述“当前失败”措辞是原始报告保留文本，只代表修复前状态。请以本文上方“根因修复与语义”“TDD与验收记录”及最终日志为当前状态。原始diagnosis目录和全部`task-2-*`历史日志均保留；本轮没有移除或伪造失败轨迹。

### 最后一轮测量修订（对应最终提交版本）

前文阈值与约0.35秒指标是此前被后续版本覆盖的历史记录。最终提交候选代码的确切值与测量见 `task-2-recovery-green-bun-final.log` / `task-2-recovery-green-suite-final.log`：初始化/WAL/schema busy上限10ms，运行期flush上限2ms；最终完整`npm test`所含锁测量：冷request hook 0.240ms，执行后store.db仍未打开；单次首次`flush()` Promise用时11.412ms（含初始化/SQL事务/调度，不等同event-loop阻塞）；20ms heartbeat实测24.298ms；写入release后自动恢复观测7.214ms（包括轮询与locker退出）。该值是一次本机合成运行，不是性能分位数或普遍保证。8轮并发均为4/4 writer成功。
