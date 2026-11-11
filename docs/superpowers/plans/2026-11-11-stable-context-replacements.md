# 固定助手发现与时间查询提示

基线：`c7b00a8e0ff81508f7efe325ece07082d94e65fa`，来自已同步的 main。
实施目录：`/home/m0eak/lobehub-work-dir/magpie-plugin-session-date-stable-context`。
实施分支：`feature/stable-context-replacements`。

## 授权与协作

用户已批准将动态助手名单和已识别日期替换为固定提示，并要求列任务表、由子代理开始修改。
只能使用 `remote-magpie/cliproxy/gpt-6-luna`，一次一个，不得继续委派。
子代理实施期间主代理等待；实施结束由主代理亲自进行规格与代码审核、独立验收。
本任务不 commit、不 push、不合并、不部署、不重载插件，不修改宿主或其他项目。
不调用真实模型 API，不使用、打印或保存真实密钥。测试只使用合成名单和虚构凭据。
保留另外两个已有工作区的一切内容，不读取或修改其他计划的账本。

## 已确认的固定文字

助手名单块替换为以下常量，精确使用以下文字：

```xml
<available_agents>
When Agent Management tools are available, use `searchAgent` with source="user" and an optional keyword to find workspace agents. Use `getAgentDetail` with agentId to inspect an agent when needed, and `callAgent` with agentId and instruction to delegate a task.
</available_agents>
```

日期注入转换后，在同一已处理文本区域仅保留以下常量一份：

```xml
<current_time_guidance>
When the task requires the current date or time, use an available time tool or run `date` if shell access is available. Use the user's specified timezone; otherwise use the runtime's configured timezone. Do not infer the current date or time from older conversation messages. If the current time cannot be verified, say so.
</current_time_guidance>
```

## 需求与边界

1. `sessionDate` 继续控制既有合法 `Current date` 和 Memory/Credentials wrapper 内的 `Session date` 规则：移除动态日期、原位插入固定时间提示。只在实际匹配合法日期的文本中生成提示，不向无日期请求凭空追加提示。同一可处理文本区域多条日期只生成一份；已有相同提示时不重复插入。后续调用不会回填实时时间，也不会实际执行任何工具。
2. `topicTitle` 继续控制原有标题行移除，独立于其他开关。
3. 新增独立布尔开关 `availableAgents`，默认关闭。仅开启时将合法的完整名单块原位替换为固定常量。固定名单块再次处理应无变更、无新命中。
4. 保持消息数量、role、顺序、其他文本、工具声明、工具选择、媒体、未知扩展和缓存元数据。不得搬移内容、复制名单、追加新 user/system 消息或将 user 内容升级成 system。
5. system/developer 中按明确块模板识别名单，保留 Markdown 围栏/引用保护。名单必须完整、无嵌套、无重复歧义；畸形或歧义区域原样放行。不以一个非贪婪正则宣称支持任意 XML。
6. 环境 user 路径必须支持，但只开放给保守识别的宿主环境模板，不在全部用户历史上裸跑替换。按本机宿主结构检查完整、顶层、非引用的 `<agent_management_context>`、其 `<instruction>` 及当前 agent/名单结构，限定环境消息候选位置，普通用户自然语言、代码示例、引文、assistant/tool 历史不处理。user 路径只做名单替换，不扩展日期和标题过滤。四种协议须明确各自环境 user 的支持形状。
7. `meta.systemInjection` 已由宿主 `MessageCleanupProcessor` 删除，不可依赖这一字段必然存在，也不可把客户端文本当认证来源。完整仿造同一宿主模板无法从真实注入中仅凭文本绝对区分，README 与验收文档必须坦诚说明，不能声称零误匹配。
8. 宿主 `<instruction>` 包含“名单列出了助手”的旧文字。检查替换后语义是否冲突，仅对已知精确的相关句子进行确定性修正；不得重写当前 agent 自我管理、模型/插件说明，亦不得扩展为任意自然语言改写。若不修正，需明确说明判断理由并交主代理审查。
9. 无名单块时不凭空插入名单提示。明确这一范围不保证宿主其他块、块整体出现/消失或其他动态注入的稳定性。
10. 实现确定性：同一模板仅日期/时区后缀或名单成员/顺序/描述不同，启用相应开关后输出完全相同；重复执行幂等。只对支持模板作此保证。

## 配置与统计

- 保留旧两键配置中的开关值，缺少第三键按关闭处理。新读写、PATCH/PUT、页面客户端、冻结快照和跨进程更新规则一致。
- 保留配置异常恢复、同内容同 mtime 恢复、并发锁、旧请求不覆盖新保存等已有修复。
- 旧二进制严格拒绝第三键；不得暗示新旧版本可无条件共享新格式。文档给出统一版本后启用以及回滚配置的要求，不实际执行部署。读取旧配置不应擅自写盘。
- 显式区分 `changed` 与 `removedLines`；只有块替换而零删除行的请求仍须返回变换正文并正确计量。
- 保留 `removedLines`、`dateRemovedLines`、`topicTitleRemovedLines` 的原单位，表示移除的原始日期/标题行。不得将替换名单块数混入删除行数。
- 新增 `availableAgentsMatchedRequests`、`availableAgentsReplacedBlocks`、`timeGuidanceInsertedBlocks`，或提出语义等价且一致的简化命名。
- 总命中请求表示任一实际变换，混合命中只加一次；分类命中可重叠。固定输出再次输入不再计命中。
- 同步更改 hook、内存 pending、SQLite 建表/迁移/读取/flush/合并、所有统计关系校验、service API、空统计、页面验证及展示。历史分类字段从零开始，不补算、不伪分配，保留旧累计值和时间。
- 旧统计的删除行数大于等于命中请求数，不再适用于新增的纯块替换命中；所有层均须调整。兼容方案要明确 API schema 与旧字段缺省行为。

## 文件范围和工作分解

| 工作 | 主要文件 | 验收要点 |
| --- | --- | --- |
| 固定常量、文本规则 | `src/matcher.mjs` 或新增小型模块 | 日期去动态值、名单整块替换、保护引用、幂等 |
| 协议适配 | `src/protocols.mjs` | 四协议；保留结构；受限环境 user；独立 changed |
| 请求处理 | `src/request.hooks.mjs`、必要时 `src/request-measurement.mjs` | 单快照；纯替换生效；匹配/异常计量 |
| 设置兼容 | `src/filter-config.mjs`、`src/service-api.mjs` | 三开关、旧配置兼容、PATCH 与异常恢复 |
| 统计与 UI | `src/stats-store.mjs`、`src/stats-ui.mjs`、`page/app.mjs`、`page/service.html`、`page/style.css` | 单位明确、迁移、完整字段校验、第三开关 |
| 回归与文档 | `test/`、`package.json`、`README.md`、`docs/acceptance.md` | 新测试纳入默认命令；公开实际覆盖边界 |

可保留现有低层纯删除导出以兼容旧调用，新增请求级替换入口；不要为了通过旧测试让生产路径继续只删除。测试随批准的新行为更新，保留旧保护性场景。

## 必要验证

- 新规则先写可复现的失败测试，再实施，记录红绿结果。
- 四协议的日期、名单、混合转换及仅名单的零删除行返回；普通 user/assistant/tool、引用、围栏、媒体和非文本不变。
- 不同日期、时区后缀、名单顺序/成员/描述的最终 payload 对比；所有支持样式的幂等；重复/嵌套/畸形块。
- 多日期仅一个提示，已有提示+新日期无重复；关闭开关按原输入保留；标题开关不受影响。
- 所有三开关组合；旧配置不丢状态；并发 PATCH、异常恢复；旧 SQLite 迁移、纯替换及混合统计；页面读写及验证。
- `npm test`，必要时定向 Node/Bun 测试，语法检查、`git diff --check`、`npm pack --dry-run`；不安装全局依赖。
- 脱敏检查当前改动与打包内容，只输出是否发现问题和脱敏位置，不输出疑似密钥、真实名单或请求正文。
- 最终报告包括修改文件、命令与通过/跳过/失败数、实现边界、待主代理复核风险。禁止把本地合成测试称为真实缓存收益证据。

## 当前状态

Task 1 已完成：Luna 实施、修复主代理检查点发现，并完成最后的兼容说明修订。
Task 2 已完成：主代理亲自规格审核与代码 review，独立完整测试、32 项具体回归、实际 hook 的 8 组开关组合及打包/语法/模式扫描均通过。验收细节记录在本计划本地工作区的 `parent-review.md`。
本地合成验收未验证真实供应商缓存收益，也未执行运行中宿主的安装或重载。
本计划不包含提交、推送、合并或部署。
