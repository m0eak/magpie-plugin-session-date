# Session Date Filter / 会话日期清理

> **核心亲审与独立验收通过；真实宿主 Web/browser 整体验收未完成，禁止视为已部署。** 这里的通过仅指核心实现的审查与独立检查，不包括完整宿主集成验收；插件未发布/部署。

此独立插件在 magpie 的公开异步请求 hook 中，对客户端请求中的 LobeHub Memory / Credentials 工具提示词执行窄范围变换：仅移除经结构 wrapper 确认的 `<session_context>` 中完整英文 `Session date: Weekday, Month D, YYYY` 行。它不扫描任意 system prompt、user/assistant/tool 内容、未知字段、图片或非文本块，不做协议转换；不保存请求正文、Key、模型、会话、provider、agent 或逐请求明细。合法未知扩展或部分多模态历史不会阻断对已识别 system/developer 文本的安全过滤；未知且无命中的无关payload不计量。合法Gemini已知媒体/code part可能增加unmatched统计口径，见独立复审记录。完全伪造同一 XML wrapper 的普通正文无法可靠地从真实工具模板语义区分，不承诺绝无误匹配。

## 插件页面

sidebar页面“会话日期清理 / Session Date Filter”只显示聚合数与时间：累计移除行数、已处理/命中/未命中请求、统计开始/最近命中/更新时间，以及服务/存储状态。页面没有reset、独立启停、日统计、图表或请求内容查看。

统计表示**提示词变换次数，不代表模型缓存命中率**。删除日期可能弱化 Memory 在消息缺少时间戳时的相对时间 fallback。其他动态提示词、路由与缓存 TTL 仍影响效果，插件不保证节省 token 或命中缓存。

初始 page iframe 只经宿主 bridge 握手后导航到 `window.magpie.service`，不从 `connect-src 'none'` 沙箱直接 fetch。service 文档重新连接宿主的 `hello` / `theme` / `visibility` 消息桥，以跟随主题和暂停隐藏页面的轮询。服务 token 只通过当前本地 service HTML 的每响应 CSP nonce bootstrap传递，之后作为 `/api/stats` Bearer token；没有读取宿主窗口 DOM或Cookie。`uiOrigin`严格验证并仅加入service HTML的 `connect-src`。统计服务仅绑定`127.0.0.1`，宿主 `page.service` 负责以页面token代理到后端；不写死生产URL/localhost，不移除token认证，不增加额外公开端口。`sessionDateFilterPort` 是manifest service option，缺省3479；需更改时应让host选项与服务监听端口保持一致。

**统计页目前仅支持 magpie Web 模式**：宿主 desktop bridge 不提供该页面的 service 地址。此限制只说明统计页面的 service 接入边界；不据此判断过滤 hook 在 desktop 中是否可用，其 desktop 加载/运行未在本轮验证。

## 聚合 API 和统计语义

服务只读：`GET /api/stats` 与 `GET /health`。统计schemaVersion=1，字段：`processedRequests`、`matchedRequests`、`removedLines`、`unmatchedRequests=processedRequests-matchedRequests`、UTC `startedAt` / `updatedAt` / `lastMatchedAt`、`status` 与 `persistence`。页面拒绝错误schema、非安全整数、负数、计数关系错误或非法UTC时间，不把其他JSON误画成零。首次API失败显示不可用而非零；之后失败保留最近成功值并标旧数据。监听启动失败不会影响请求过滤，但统计页面不可用。

每个进入支持hook的可计量请求计一次；客户端新HTTP重试是另一次请求。命中计数表示至少实际删除了日期行；`removedLines`是删除的行数，与请求数不是同一口径。计数在当前host pending立即可见，其他host在事务提交后出现；正常flush约30秒，存储锁/故障会延迟。进程异常退出或host shutdown时，未flush增量可能丢失；不承诺零丢失、跨进程exactly-once或实际缓存收益。

## 安装与卸载（本地包，不发布）

工程内分发文件名为 `lobehub-plugin-session-date-filter-0.1.0.tgz`。`.tgz` 是分发容器，不是可直接加载的插件目录：`plugin add <tarball>` 即使登记成功，也不代表包已解压，更不代表 hook、listener 或页面已加载。下面先解压到一个**尚不存在的独立目录**（避免覆盖已有内容），再把其中 `package` 子目录的绝对路径作为 path spec 传给宿主：

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

添加命令返回成功只证明登记操作完成。之后仍需分别核对插件 `list`/loaded 状态、hook 与 listener，以及 Web 模式下的页面和 service 代理；这些检查不能由 `.tgz` 存在或 CLI 登记成功替代。本地加载证据仅适用于独立验收报告记录的宿主与运行时版本，不构成对其他版本的承诺。

`package.json` 的 `private: true` 不影响本地 `npm pack`；禁止 `npm publish`。下一次最终验收必须从新 HEAD 重新打包，并检查新包体内容；已有 tarball 仅作为历史验收材料，不应覆盖或当作新 HEAD 的交付包。

## 开发与验证

```sh
npm test
node --check src/service-api.mjs
node --check src/stats-ui.mjs
node --check src/page-bridge.mjs
node --check page/boot.js
node --check page/app.mjs
```

完整报告、测试日志、tarball SHA256、变更/patch及未验证项见 `.superpowers/sdd/session-date-filter/task-3-report.md`。计划与规格见 `docs/superpowers/plans/2026-11-04-session-date-filter-plan.md` 与 `docs/superpowers/specs/2026-11-04-session-date-filter-design.md`。

### 过滤边界

日期只在真实物理独立整行时匹配；同一物理行上的 session 标签与日期片段不会删除。Markdown fenced code / quote 中的日期与结构标签按保护内容跳过；围栏按相同字符及不短于起始符号长度配对。保护规则是刻意有限的，不是完整 CommonMark/XML parser；畸形或未闭合结构保持 fail-open。完全伪造同结构语义仍不可仅凭文本区分，且引用 lazy continuation 等复杂 Markdown 排版可能保守漏匹配。
