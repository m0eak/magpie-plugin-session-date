# Session Date Filter / 会话日期清理

> **本插件尚未发布或部署。** 2026 年 11 月 8 日的宿主验收记录见 [`docs/acceptance.md`](docs/acceptance.md)，该记录适用于当时注明的代码快照；本文所述独立开关、分类统计和并发设置同步属于后续变更，已通过文档所列本地测试，但尚未在宿主中验收。

此独立插件在 magpie 的公开异步请求 hook 中，对已识别的 system/developer 提示词执行确定性变换：移除完整单行的 Topic Title 表格行和 `Current date: YYYY-MM-DD` 行（含已知括号时区后缀），并在 LobeHub Memory / Credentials 的结构 wrapper 内继续移除完整英文 `Session date: Weekday, Month D, YYYY` 行。当前规则没有验证任意多行标题或未知注入模板，不对这些形态作保证。它不扫描 user/assistant/tool 历史、未知字段、图片或非文本块，不做协议转换；不保存请求正文、Key、模型、会话、provider、agent 或逐请求明细。合法未知扩展或部分多模态历史不会阻断对已识别 system/developer 文本的安全过滤；未知且无命中的无关payload不计量。合法Gemini已知媒体/code part可能增加unmatched统计口径，相关验收边界见 [`docs/acceptance.md`](docs/acceptance.md)。完全伪造同一 XML wrapper 的普通正文无法可靠地从真实工具模板语义区分，不承诺绝无误匹配。

## 插件页面

sidebar页面“会话日期清理 / Session Date Filter”提供两个独立开关：日期开关同时控制 `Current date` 与 wrapper 内 `Session date`，标题开关控制 Topic Title 行。页面同时显示总计和日期/标题分类的删除行数与命中请求数，以及服务/存储状态；没有reset、日统计、图表或请求内容查看。

开关保存在插件数据目录的 `filter-config.json`，写入先安全创建目录，再用同目录临时文件原子替换；同一数据目录的其他host每约500ms轮询发现配置变化，因此跨host传播不是即时的。每个请求只读取一次冻结的完整设置快照，并用该快照处理该请求所有支持的文本块。页面以认证 `PATCH` 提交明确变更字段，服务在锁内合并磁盘最新状态；`PUT` 保留为显式全量替换。锁使用异步等待，不阻塞host事件循环，并记录PID与唯一owner token：owner进程仍存活时不会因等待超时被回收；回收进程死亡锁时另用原子guard串行化二次核验与删除。guard损坏或无法确认时会安全等待并报超时，不会冒险删除锁。原子替换或锁写入失败时，本实例内存状态不先行改变；设置读取失败时过滤fail-open、设置API报告不可用，不会静默恢复默认值。设置变更会影响后续prompt，供应商缓存行为不在本插件保证范围内。

统计表示**提示词变换次数，不代表模型缓存命中率**。移除动态元数据行可能弱化 Memory 在消息缺少时间戳时的相对时间 fallback。源码修复不代表当前运行实例已经部署；版本切换也不保证供应商继续沿用旧 prompt 缓存。其他动态提示词、路由与缓存 TTL 仍影响效果，插件不保证节省 token 或命中缓存。

初始 page iframe 只经宿主 bridge 握手后导航到 `window.magpie.service`，不从 `connect-src 'none'` 沙箱直接 fetch。service 文档重新连接宿主的 `hello` / `theme` / `visibility` 消息桥，以跟随主题和暂停隐藏页面的轮询。服务 token 只通过当前本地 service HTML 的每响应 CSP nonce bootstrap传递，之后作为 `/api/stats` Bearer token；没有读取宿主窗口 DOM或Cookie。`uiOrigin`严格验证并仅加入service HTML的 `connect-src`。统计服务仅绑定`127.0.0.1`，宿主 `page.service` 负责以页面token代理到后端；不写死生产URL/localhost，不移除token认证，不增加额外公开端口。`sessionDateFilterPort` 是manifest service option，缺省3479；需更改时应让host选项与服务监听端口保持一致。

**统计页目前仅支持 magpie Web 模式**：宿主 desktop bridge 不提供该页面的 service 地址。此限制只说明统计页面的 service 接入边界；不据此判断过滤 hook 在 desktop 中是否可用，其 desktop 加载/运行未在本轮验证。

## 聚合 API 和统计语义

统计使用只读 `GET /api/stats` 与 `GET /health`；设置 API 提供认证 `GET /api/settings`、字段合并 `PATCH /api/settings` 和全量替换 `PUT /api/settings`。统计schemaVersion=1，字段含原聚合计数、日期与标题分类计数、UTC `startedAt` / `updatedAt` / `lastMatchedAt`、`status` 与 `persistence`。页面与存储层均校验分类命中请求数不超过对应删除行数。页面拒绝错误schema、非安全整数、负数、计数关系错误或非法UTC时间，不把其他JSON误画成零。首次API失败显示不可用而非零；之后失败保留最近成功值并标旧数据。监听启动失败不会影响请求过滤，但统计页面不可用。

每个进入支持hook的可计量请求计一次；客户端新HTTP重试是另一次请求。总命中表示至少实际删除一条日期或标题行；日期、标题分类命中请求数可以重叠，混合命中时总命中只加一次。分类命中与删除行计数从本版本开始累计；升级时保留既有总数与时间，新增分类从零起算，历史总数不能回溯归类，也不会伪造分摊。计数在当前host pending立即可见，其他host在事务提交后出现；正常flush约30秒，存储锁/故障会延迟。进程异常退出或host shutdown时，未flush增量可能丢失；不承诺零丢失、跨进程exactly-once或实际缓存收益。

## 安装与卸载（本地包，不发布）

`npm pack` 会从当前 package 内容生成本地归档 `lobehub-plugin-session-date-filter-0.1.0.tgz`。本仓库不包含生成的 tarball。`.tgz` 是分发容器，不是可直接加载的插件目录：`plugin add <tarball>` 即使登记成功，也不代表包已解压，更不代表 hook、listener 或页面已加载。下面先解压到一个**尚不存在的独立目录**（避免覆盖已有内容），再把其中 `package` 子目录的绝对路径作为 path spec 传给宿主：

```sh
PLUGIN_ARCHIVE=/path/to/lobehub-plugin-session-date-filter-0.1.0.tgz
PLUGIN_DIR=/path/to/session-date-filter-unpacked

# 目标必须不存在；mkdir 后 tar 才会把包解到该目录下的 package/
test -f "$PLUGIN_ARCHIVE" || { echo "PLUGIN_ARCHIVE not found" >&2; exit 1; }
test ! -e "$PLUGIN_DIR" || { echo "PLUGIN_DIR already exists; choose a new path" >&2; exit 1; }
mkdir -p "$PLUGIN_DIR" || exit 1
tar -xzf "$PLUGIN_ARCHIVE" -C "$PLUGIN_DIR" || exit 1
PLUGIN_SPEC="$(cd "$PLUGIN_DIR/package" && pwd -P)" || exit 1

magpie plugin add "$PLUGIN_SPEC"
```

卸载时，在同一 shell 中沿用上面得到的 `PLUGIN_SPEC`；若已关闭 shell，则以相同的 `PLUGIN_DIR` 重新计算该绝对路径。传给 `plugin rm` 的必须是**与安装时完全相同的解包目录 path spec**，不要改用未经该路径实测的短名称：

```sh
magpie plugin rm "$PLUGIN_SPEC"
```

移除登记后，关闭并重新启动所有已加载该插件的宿主进程，再核对插件登记、页面和 hook 已移除，以及原统计 service 端口已关闭。运行中的宿主可能尚未重新加载插件配置，因此 `plugin rm` 返回成功不保证既有监听立即退出；卸载验收应覆盖上述完整流程。此步骤只针对实际加载了该插件的宿主，不应停止其他无关进程。

添加命令返回成功只证明登记操作完成。之后仍需分别核对插件 `list`/loaded 状态、hook 与 listener，以及 Web 模式下的页面和 service 代理；这些检查不能由 `.tgz` 存在或 CLI 登记成功替代。本地加载证据仅适用于 [`docs/acceptance.md`](docs/acceptance.md) 记录的宿主与运行时版本，不构成对其他版本的承诺。

`package.json` 的 `private: true` 不影响本地 `npm pack`；禁止 `npm publish`。最终验收必须从最终审查代码快照重新打包，并检查新包体内容；已有 tarball 仅作为历史验收材料，不应覆盖或当作新代码快照的交付包。

## 开发与验证

```sh
npm test
node --check src/service-api.mjs
node --check src/stats-ui.mjs
node --check src/page-bridge.mjs
node --check page/boot.js
node --check page/app.mjs
```

普通的 `npm test` 使用本项目中的测试与固定 host contract fixture，可在独立 clone 中运行，不需要旁边另有宿主源码。若要按需检查宿主源码兼容性，可运行 `SESSION_DATE_FILTER_HOST_ROOT=/path/to/host npm test`；该目录须包含被检查的三份宿主源码。此静态检查不替代真实宿主与浏览器验收。

2026 年 11 月 8 日宿主验收范围与限制，以及本次源码验证结果见 [`docs/acceptance.md`](docs/acceptance.md)。该宿主验收对应文档注明的旧代码快照；本次独立开关、分类统计和并发设置同步尚未在宿主中验收。计划与规格见 `docs/superpowers/plans/2026-11-04-session-date-filter-plan.md` 与 `docs/superpowers/specs/2026-11-04-session-date-filter-design.md`。

### 过滤边界

日期只在真实物理独立整行时匹配；同一物理行上的 session 标签与日期片段不会删除。Markdown fenced code / quote 中的日期与结构标签按保护内容跳过；围栏按相同字符及不短于起始符号长度配对。保护规则是刻意有限的，不是完整 CommonMark/XML parser；畸形或未闭合结构保持 fail-open。完全伪造同结构语义仍不可仅凭文本区分，且引用 lazy continuation 等复杂 Markdown 排版可能保守漏匹配。

## 独立过滤开关与分类计数

统计页面提供“移除日期行”和“移除话题标题行”两个独立开关，默认均为开启。日期开关同时控制普通 `Current date: YYYY-MM-DD` 与已识别 Memory/Credentials wrapper 内的 `Session date`；标题开关控制完整单行 `Topic Title` 表格行。每个请求只读取一次内存配置快照，并对所有 system/developer 文本块使用该快照。关闭的类别保留动态原文。

页面通过认证的 `PATCH /api/settings` 只提交用户更改的开关字段，服务在异步跨进程锁内合并磁盘最新配置；认证 `PUT /api/settings` 保留为全量替换。数据目录在锁之前创建，设置用同目录临时文件原子替换。锁包含 PID 与唯一 owner token，持锁进程存活时不会被回收；持锁进程退出后其他进程可以回收并重试，等待超时则明确返回保存失败。页面遇到请求异常会重新读取后端状态；若重读也失败，会显示“保存结果未确认”，不再宣称设置一定未更改。配置文件仅属于插件数据目录，不修改宿主配置。

每个运行进程启动时读取一次配置，随后在内存中使用；同一数据目录下的其他进程每 500ms 轮询文件并更新快照，因此跨进程开关生效有最多约半秒的轮询延迟。只有共享同一个插件数据目录的实例能同步设置；各自使用独立目录的 host 不会互相同步。配置读取不会在每个请求触发 SQLite 或文件锁操作。切换开关会改变后续提示词，不能保证复用切换前的缓存；配置不变时，仅已开启类别的日期／标题动态值会被移除。

分类统计新增日期与标题各自的命中请求数、删除行数。一个请求同时命中两类时，总命中请求只计一次，分类命中请求分别计一次，因此两类请求数允许重叠。`stats.sqlite` 原有总数与时间保持不变，升级时新增的类别列从零开始；历史总数仍保留在原聚合中，无法追溯拆分到日期或标题。旧的未分类删除行可能令分类行数之和小于历史累计总数；不会推测或分摊旧数据。
