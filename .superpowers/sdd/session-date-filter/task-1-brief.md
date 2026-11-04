# Task 1 简报：独立插件基础与纯函数过滤器

**执行者**：本实施子代理；不得再派任何子代理。主代理负责规划/审查。上一研究代理已结束，不唤回、不继承其长上下文。

**授权**：用户已授权按主代理决定的计划继续本地实现；按阶段一完成并提交。仅在 `/home/m0eak/lobehub-work-dir/magpie-plugin-session-date` 工作。不得修改后续阶段、部署或访问生产环境。

**目标**：实现独立 package 基础、纯函数 matcher 和协议适配、README 初稿、测试及阶段文档。

**绑定规格**：请以 `docs/superpowers/specs/2026-11-04-session-date-filter-design.md` 八条原文为准；不得自行放宽范围。

**产物**：`src/matcher.mjs` 的 `stripSessionDates(text) -> {text, removedLines}`；`src/protocols.mjs` 的 `filterRequest(body, protocol) -> {body, removedLines, supported}`；Node 内置测试 `test/matcher.test.mjs` / `test/protocols.test.mjs`；`package.json`；README 初稿；plan/spec/progress/brief/report/review patch。

**TDD**：先写测试，运行并观察正确 red，再写最小实现至 green。覆盖四协议、精确 wrapper、只删完整 Session date 日期行、缩进/LF/CRLF、精确分隔符、多处/空块/幂等、不误伤角色/引用/fenced code/普通文本/非文本/图片/tool/thinking、异常输入 fail-open、对象不就地改写、meta（特别 cache_control）不变、unsupported 原引用。

LobeHub 当前合成 fixture 格式由以下源码核实：
- `packages/builtin-tool-memory/src/systemRole.ts:1-8`；模板有 `<session_context>` 与 `Session date: {{date}}`。
- `packages/builtin-tool-creds/src/systemRole.ts:1-8`；模板有 `<session_context>` 与 `Session date: {{session_date}}`。
- `packages/prompts/src/prompts/plugin/index.ts:8-10`；外层 `<tools description="The tools you can use below">`。
- `packages/prompts/src/prompts/plugin/tools.ts:15-23`；`<tool name="${tool.name}">` 与 `<tool.instructions>` 的真实包装格式。

绝不从运行时复制请求。测试 fixture 根据以上源码合成。

**禁止项**：不修改 LobeHub/宿主源码；不 pull 新仓库；不 SSH；不读生产配置/提示词/密钥；不访问线上网关或模型；不做 hook/stats/HTTP/UI/完整 manifest；不安装全局依赖；不 push/发布/部署/装生产；不 destructive reset/clean；不改全局 Git 身份。

**交付证据**：报告写完整 red/green 命令及退出码、测试摘要、源码行号、`git diff --check`、最终 status、commit SHA、文件清单和疑虑；生成基线到 HEAD 的完整 `task-1-review.patch`。一次本地提交。之后主代理独立审查。
