# Task 1 手工复修简报

## 边界与基线

- 工程：`/home/m0eak/lobehub-work-dir/magpie-plugin-session-date`
- 分支：`feature/session-date-filter`
- 固定基线：`8acf8a81dfc1cbe077272295752d2d5fc60cb7d0`
- 仅修复主代理亲审发现的 F1/F2/F3 精确过滤缺陷；不改页面、部署、发布，不改协议/计量/SQLite/service/hook，不触碰参考宿主仓库、SSH、生产配置、真实提示词/Key/模型。
- 保留第三阶段已有未提交 `progress.md` 与 `task-3-report.md` 变更，以及全部历史/未跟踪证据；不 reset/clean/stash/amend，不使用 `git add .`。只精确提交 matcher、本轮回归测试、必要文案与报告；原始日志和 review.patch 不提交。

## 缺陷与绑定验收

- **F1 — CommonMark fence info string**：当前 opener 正则禁止 info string 含 `~` 或 backtick，误把 close 当 opener并错位保护。仅修正 fence opener 基本规则：0–3个前导空格、反引号/波浪线run至少3；backtick fence 的 info string 禁止反引号但允许波浪线；tilde fence info 可含二者；close 必须同符号且长度至少 opener、其后仅水平空白。覆盖普通/4字符围栏、多围栏、合法 `~~~js~literal`、反引号 info 与反引号围栏含 `~`、LF/CRLF、quote，以及同一session内真实日期正例。不能因含 fence 的文本一律跳过。
- **F2 — 真实物理整行边界**：session span 子串的局部首尾不能伪装成原文物理整行。只移除相对于原始完整字符串独立成行的日期；同行开标签/闭标签、单侧同行均保留；独立整行正例可移除。移除目标行及其原分隔符外，所有字节 exact equal；支持LF/CRLF、缩进、行首/行尾。
- **F3 — 结构扫描忽略受保护伪标签**：工具树和 tool.instructions/session_context 的 opening/closing tags统一忽略位于fence/quote保护行的匹配。示例伪标签不得截断真实配对，也不得连带让平级Memory被跳过。仍然真实未闭合/嵌套/异常结构必须fail-open；不能拿伪close补齐真实缺close。

## 执行与验收

1. 先将完整输出 `deepEqual` 行为断言追加至 `test/matcher.test.mjs`，旧实现运行并保存真实失败及命令/退出码到 `red.log`（禁止以缺模块充数）。
2. 最小修复 `src/matcher.mjs`，不加parser依赖、不搭通用Markdown/XML parser、不重设计插件。
3. 执行定向 matcher、Node纯核心+manual hook回归，再一次 `npm test`；报告suite实际数量与skip。日志留在本目录。
4. 执行必要语法检查与 `git diff --check`。不重打最终tarball；`dist/task3-fix1` 为旧产物，不含本修复，明确不可交付。
5. 写报告及BASE到新HEAD完整审查patch（含log/stat/full diff，不递归嵌入历史patch）。报告状态为主代理亲审FAIL后补修、待独立验收；实施者不得自行审查放行。
6. 本地精确stage并commit；沿用repo-local作者，不改全局，不push。

## 风险与局限

保持当前保护规则的保守边界（包括blockquotes lazy continuation可能漏匹配）；不扩展任意行内日期识别，不实现完整CommonMark/XML语义解析。真实同结构伪造语义不可区分这一既有README局限不变。预算约20分钟/25次批量工具调用；若遇架构性阻塞，带证据交回，不无限循环。
