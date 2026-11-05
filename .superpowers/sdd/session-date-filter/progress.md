# Session Date Filter — SDD 阶段账本

## Task 1 — 独立插件基础与纯函数过滤器
- 状态：修复轮 3 已实现并通过验证，待定向复审
- 分支：`feature/session-date-filter`
- 初始目标路径检查：不存在；因此创建新工程
- 开发工具：Node、Bun、Git 均已存在（Node v22.23.0、Bun 1.3.10、Git 2.43.0）；未安装依赖/软件
- 只读模板核验：Memory `packages/builtin-tool-memory/src/systemRole.ts:1-8`；Credentials `packages/builtin-tool-creds/src/systemRole.ts:1-8`；外层 `<tools>` `packages/prompts/src/prompts/plugin/index.ts:8-10`；`<tool>` / `<tool.instructions>` `packages/prompts/src/prompts/plugin/tools.ts:15-23`
- Task 1 TDD Red：`node --test test/matcher.test.mjs test/protocols.test.mjs` 在无实现阶段退出码 1（module-not-found）；增加占位 exports 后，同一命令退出码 1（29 tests，17 个功能断言失败，失败指向 matcher/protocols 行为缺失）。
- Task 1 Green：`node --test test/matcher.test.mjs test/protocols.test.mjs` 与 `npm test` 均退出码 0，36/36 通过。
- 质量门：ESM syntax check、`npm pack --dry-run`、4 文件 package 白名单断言和 `git diff --check` 均退出码 0。
- 未执行：Task 2/3、hook/stats/service/UI/manifest、部署/联网/SSH/生产数据访问。
- 修复轮 1 TDD：先新增 C1/I1/I2/I3/M1 回归测试；`node --test test/matcher.test.mjs test/protocols.test.mjs` 在修复前退出码 1，44 tests / 37 pass / 7 fail。原始 stdout+stderr 合并日志：`task-1-fix-1-red.log`。不改写初次 Task 1 缺少原始日志的历史事实。
- 修复轮 1 Green：定向 suite 45/45 通过，日志：`task-1-fix-1-green.log`。
- 处理：C1 逐个原样追加扫描区间（包含匹配前跳过 wrapper、未闭合尾部）；Chat 只接收 text discriminator，Responses 保留 input_text；Gemini 不处理顶层字符串，只处理 systemInstruction.parts 中 text，且校验 thought boolean / thoughtSignature string；M1 用 setUTCFullYear 兼容 0001–0099 并保留 weekday/month/day 校验。
- 修复轮 2 TDD：在旧实现上先运行 matcher 专项测试，退出码 1（33 tests / 29 pass / 4 fail），复现未闭合外层内嵌目标、完整非目标外层内嵌多个目标、malformed 前后边界及 nested/unmatched close。日志 `task-1-fix-2-red.log`。
- 修复轮 2 Green：定向 matcher+protocol 50/50、全量 npm 50/50；日志 `task-1-fix-2-green.log` / `task-1-fix-2-full-test.log`。
- 修复轮 2 策略：先扫描并验证整个文本的顶层 `<tools>` 标签结构；任何嵌套/未配对/非完整 closing 标签使整段 fail-open；平级完整合法 wrapper 逐个过滤。残余 tradeoff：malformed 结构会连带跳过其他平级合法 wrapper，以确保无意外删改。
- 修复轮 3 TDD：新增 blockquote/fenced-code 伪 closing 的精确原文断言；旧实现 `node --test test/matcher.test.mjs` 退出码 1，35 tests / 33 pass / 2 fail。日志 `task-1-fix-3-red.log`。
- 修复轮 3 Green：matcher 35/35、全量 npm suite 52/52；日志 `task-1-fix-3-green.log` / `task-1-fix-3-full-test.log`。closing 标签保护行现在 fail-open，不会伪关闭 `<tools>` 外层。
- 当前：修复轮 3 已提交（`2b174713bc093d9482a4e06ed11d88d022da2652`），matcher 35/35、完整 npm suite 52/52。复审包已生成，等待主代理定向复审；不宣称 clean。


## Task 2 — request hook、统计存储与只读 service API
- 状态：fix2已实现、定向与全套测试通过并本地提交，待独立复审；不宣称review clean，不push/部署。
- 当前Task2交付基线为 `2f1a01542195bf4a07b10b3b2059c025fc9c94f4`；fix1为`c3cf88c3102e86d937955d8e064a7307b07597e2`，fix2前HEAD为`5ced8e0b8b55954e962dd733c1d96a6580e7e44d`。fix2本地提交及完整复审补丁均在Task2报告中登记。历史probe/报告/DB/WAL等untracked证据原位保留，未清理。
- 根因沿用完整诊断 `.superpowers/sdd/session-date-filter/task-2-diagnosis/diagnosis.md`：deferred seed INSERT竞争导致first-open丢pending；旧5秒busy handler同步卡event loop；Node默认发现混跑Bun测试/fixture。本轮新red：`task-2-recovery-red-baseline.log`，Bun 12/13、exit1，失败为真实并发writer SQLITE_BUSY。
- 修复：IMMEDIATE schema+seed事务；初始化WAL/schema/seed busy上限10ms，运行期flush busy上限2ms；request hook经microtask只做内存计数。后台有限退避（25/75/200/500/1000ms，总窗口2秒、timer unref），失败保留pending，事务提交后只消费提交快照；成功边界为事务commit，无snapshot重提delta。坏schema/数据范围异常不静默清零。详情/边界见 `task-2-report.md` 和 `task-2-recovery-brief.md`。
- 宿主只读契约（参考HEAD `50265256ba56ac164a680da0689e1c6d90dac471`）：`host.js:1323` 调用 `fn(input,p.options)`；`input.directory=settings.Dir()` 见 `host.go:1133-1160`。插件服务端第二参数才是package options。PluginHost reload由Go关闭Bun子进程（`host.go:538-560,904-925`），不发现插件dispose回调；故不宣称强制stop能等异步flush。page.service需真实page，Task2无page entry。
- 验收（Bun1.3.10 / SQLite3.51.2）：`node --test test/matcher.test.mjs test/protocols.test.mjs` 57/57；`bun test test/task2.test.mjs` 19/19；`bun run test/task2-integration.bun.mjs`通过；最终`npm test` exit0（上述三组串行短路）。Bun多进程8轮均4/4 writer ok，5 fresh +3 seeded，每轮100/52/52/48精确。真实BEGIN IMMEDIATE锁下同步busy等待配置2ms、冷request hook实测约0.24ms且DB仍未打开；单次首次flush Promise总用时11.412ms，20ms heartbeat实测24.298ms；释放锁后约7.214ms自动commit，无手动flush/重复。此为合成环境实测，不是普遍性能保证。
- 质量门：所有本轮JS语法检查、`git diff --check`、`npm pack --dry-run`均exit0。npm包仅8文件，不含测试、test-data、诊断和日志。测试路径在工程内，Task2 pid目录finally清理；起始debug/test-data全部保留。最终测试日志：`task-2-recovery-green-node-final.log`、`task-2-recovery-green-bun6.log`、`task-2-recovery-green-integration-final.log`、`task-2-recovery-green-suite-final.log`；质量日志`task-2-recovery-git-diff-check.log`、`task-2-recovery-pack-final.log`。
- 本轮fix1依据独立审查报告`task-2-acceptance/task-2-review.md`修复I1浅层可计量结构、I2 OPTIONS先path/query allowlist、I3 listener启动失败仅统计部分降级；spec已追加主代理Ruling。详情/命令/日志见`task-2-report.md` fix1节；red日志`task-2-fix-1-red-i1.log`、`task-2-fix-1-red-i2.log`、`task-2-fix-1-red-i3.log`；green定向21/21、完整`npm test` Node57/57+Bun38/38+integration exit0，日志`task-2-fix-1-green-focused.log`、`task-2-fix-1-green-full.log`。

- 修复轮 4 TDD：旧 HEAD 上 matcher 40 项中 35 pass / 5 fail（退出码 1），日志 `task-1-fix-4-red.log`；修复后 matcher 40/40 与 `npm test` 57/57 通过（退出码 0），日志 `task-1-fix-4-green.log` / `task-1-fix-4-full-test.log`。统一在顶层结构扫描前跳过 protected Markdown 行的开/闭 `<tools>` 标签，实际 malformed/unpaired 结构仍整段 fail-open。
- 当前：修复轮 4 已提交（`9755c77ceaa12344c2f68f1c34c23ebe32693dbe`），复审结论为 clean；Task 1 阶段一完成。结论不覆盖 Task 2/3。

## 最终复审结论

- Task 1: complete (commits eae3285..9755c77, review clean)。阶段一规格符合 PASS、代码质量 PASS；没有启动 Task 2。
