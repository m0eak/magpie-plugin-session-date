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
- 当前：修复轮 3 改动、文档与日志已准备，待本地提交和生成定向 review patch；等待主代理复审，不宣称 clean。


- 未执行：Task 2/3、hook/stats/service/UI/manifest、部署/联网/SSH/生产数据访问。
