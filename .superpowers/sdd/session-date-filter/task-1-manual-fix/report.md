# Task 1 手工复修报告

状态：**DONE_WITH_CONCERNS — 主代理亲审为 FAIL 后，F1/F2/F3 已按本轮范围补修；等待主代理亲看 diff 与独立验收。本报告不代表验收通过，也不代表插件整体完成。**

## 范围与提交

- 分支：`feature/session-date-filter`
- 固定 BASE：`8acf8a81dfc1cbe077272295752d2d5fc60cb7d0`
- 源码与测试实施提交：`901d12e0a656527dd20de7e188263f995c008299`；交接HEAD以 `review.patch` 头部/最终交接信息为准。
- 仅变更：`src/matcher.mjs`、`test/matcher.test.mjs`、README过滤边界文案，以及本轮报告/brief/progress追加。本轮没有修改页面、协议、hook、计量、SQLite或service实现。
- 第三阶段原有未提交 `progress.md` 和 `task-3-report.md` 改动保留；没有重新格式化或覆盖。工程内历史未跟踪报告、日志、fixtures、DB、旧包均保留。未操作参考宿主仓库/SSH/生产配置/密钥/真实提示词/模型；未部署、发布、push或重打最终包。

## F1 — 合法围栏信息串

根因：旧正则拒绝包含 `~` 或反引号的 info string，将合法围栏的结束行误认作新的起始行，代码日期保护错位。

修复：起始行提取 fence 字符run与info分开；仍限制0–3前导空格和至少3个同符号；backtick fence 只拒绝info内backtick，允许`~`；tilde fence允许二者。closing仍要求同字符、不短于opening且后续仅水平空白。未做完整Markdown解析，也没有整体跳过含围栏的文本。

回归使用完整输出 `deepEqual`，包含 `~~~js~literal`、`~~~js\`literal`、` ```js~literal`、四字符围栏、多段围栏、错误类型/长度的close、CRLF，以及同一session内真实围栏后独立日期正例。围栏内日期被保留，真实日期完整删除。

## F2 — 源文物理整行边界

根因：旧实现以session子串的`start/end`作为行边界，标签夹在日期两侧时局部子串会把日期片段误认成独立整行。

修复：按完整原文反查该行真正物理行首、扫描原文行尾；仅当目标行完整包含在session span内时才检查/删除。同行标签及标签外字节不会被消费；删除时保留到原物理行首的span前缀，并仅跳过目标行与它原有换行符。

回归覆盖标签+日期+标签同一行、开标签与日期同行、日期与闭标签同行（均要求原文与`removedLines:0`完全相等），以及CRLF下缩进日期加行尾tab/空格独立正例（完整输出deepEqual，其他字节保持）。

## F3 — 各结构层忽略受保护标签

根因：Markdown保护集合只被外层`<tools>`扫描使用，内层顶层tool栈及`tool.instructions`、`session_context`成对扫描仍以原始子串配对。代码/引用示例里的伪close可破坏真实结构或使整个候选tree被丢弃。

修复：引入小型共用`nextUnprotectedTag`，用于 instructions/session 的开闭标签查找；`findTopLevelTools`现按完整文本原始offset扫描并忽略protected行内的所有`<tool...>`与`</tool>`匹配。外层保护扫描规则不变。真实未闭合结构+fenced伪close仍以原文、0移除fail-open。

回归覆盖fence和quote中的内层伪close、所有层级的伪opening/closing、其他平级tool中的伪close不连带跳过Memory、缺少真实tool close不能被代码伪close补齐。均为完整输出deepEqual。

## TDD与验证证据

- 固定基线真实red：使用`git show BASE:src/matcher.mjs`生成本目录局部baseline快照，再把最终matcher测试导入重定向到快照执行。命令：`node --test .superpowers/sdd/session-date-filter/task-1-manual-fix/baseline-matcher.test.mjs`，exit **1**；50项中 **43 pass / 7 fail / 0 skip**。失败为F1 2项、F2 1项、F3 4项；全是行为deepEqual失败，不是缺模块。原始输出含命令与exit：`red.log`。基线快照文件仅为本地证据，不提交。
- 修复后matcher：`node --test test/matcher.test.mjs`，exit **0**；**50/50 pass**、0 fail/skip，见`green.log`。
- 核心+协议+手工hook回归：`node --test test/matcher.test.mjs test/protocols.test.mjs test/manual-review-fix.test.mjs`，exit **0**；**74 pass**、0 fail/skip，见`node-core-hook.log`。
- 全量：`npm test`，exit **0**；Node阶段 **91项：84 pass / 0 fail / 7 skip**（Bun-only用例在Node阶段skip）；Bun阶段 **57 pass / 0 fail**，4个测试文件；Task2 Bun integration成功。见`full-test.log`。这些分别是Node与Bun阶段的suite计数，不将跨运行时重测伪装为独立行为总数。
- `node --check src/matcher.mjs`、`node --check test/matcher.test.mjs`、`git diff --check` 均通过；不执行npm pack，本轮没有生成最终tarball。
- 主代理此前对原始旧代码的inline复现和亲审结论是问题定位来源；本轮独立实际执行了固定BASE快照测试红灯及当前修改测试绿灯，二者已区分记录。

## 文件清单与交付

- `src/matcher.mjs`：三项最小修复。
- `test/matcher.test.mjs`：F1/F2/F3完整输出回归。
- `README.md`：有限Markdown/结构保护及fail-open边界说明。
- `.superpowers/sdd/session-date-filter/progress.md`：仅追加本轮状态，保留Task3实施者内容。
- `.superpowers/sdd/session-date-filter/task-1-manual-fix/brief.md`、`report.md`：本轮范围/报告。
- `.superpowers/sdd/session-date-filter/task-1-manual-fix/red.log`、`green.log`、`node-core-hook.log`、`full-test.log`：日志未提交。
- `.superpowers/sdd/session-date-filter/task-1-manual-fix/review.patch`：BASE..HEAD完整diff与stat；不提交。
- `dist/task3-fix1`内旧包没有本轮matcher修复，不能交付安装；最终包须等主代理与独立验收之后统一重包。

## 剩余局限与交接

- 仍是刻意有限的CommonMark保护扫描器，不是Markdown AST/XML parser；quote lazy continuation等复杂CommonMark排版仍可能保守漏匹配。对同一格式、结构完全相同的语义伪造wrapper无法仅凭文本可靠区分，此既有限制已在README保留。
- 真正畸形、嵌套或未闭合结构仍fail-open；可导致不处理合法平级提示词但不应破坏提示词内容。
- 现在交主代理亲自审查BASE..HEAD diff；随后按主代理安排独立验收。本轮实施者没有自行放行、派遣子代理或部署。
