# Task 3 Brief — 页面、完整 manifest 与本地包

## 目标与约束
在 `feature/session-date-filter` 的批准 BASE `f55c1bcc84297da4147fbf712ac0a1a365296822` 上实现紧凑只读统计页、宿主真实 page/service manifest、严格只读资产/统计路由、Node/Bun测试、安装说明和本地可安装 tarball。不得修改宿主、部署、发布、联网生产、泄漏或移除 service token，不删除历史证据。保留工作区已有 progress 与未跟踪历史资产；只精确暂存本任务文件。

## 设计决策
- 宿主 page shell `page/index.html` 载入官方 `_magpie/bridge.js` 与本地 `boot.js`。遵循 page-fingerprint：await `window.magpie.ready`，读取 `window.magpie.service`，将受校验的代理 origin 放进 service 导航 query `uiOrigin`，再 `location.replace(service + query)`；service 页面由本机服务提供 HTML/CSS/JS 与 read-only API，因此使用宿主 `page.service` 的代理调整 CSP，而非从初始 `connect-src 'none'` iframe 直接 fetch。只在有 bridge service 时运行；不使用固定生产地址或 localhost fallback。
- Manifest按宿主 `PageSpec` / `ServiceSpec` 使用 `page.file`, `page.service.port=3479`, `option=sessionDateFilterPort`；服务从 server options 读同名端口，默认3479，插件没有多余options声明，不新增permissions。UI页和service资源页是不同角色。
- API仅 `GET /api/stats`、`GET /health`、合法 `OPTIONS`；静态资产用固定路由 map：`/`, `/app.mjs`, `/style.css`，拒绝其他path、query与错误Host/Origin/method；API校验Bearer，允许合法Origin-null预检及Authorization/Content-Type，保持宿主 token/proxy，不增加自定义header。响应使用固定内容，不从请求拼接磁盘路径。
- UI按用户确认的宿主原生紧凑风格；`textContent`、安全计数/关系和UTC schema校验，主题读 service URL 的 `theme`/`lang` query（不直接依赖被service导航丢弃的iframe bridge），5s可见轮询、单飞/有界超时/旧值保留、初次失败无假零。无写入/reset/模型请求/正文数据。
- Node 22与Bun 1.3.10可用。新增测试先red后green；完整 `npm test` 和package审查只在实现稳定后执行。包输出到工程 `dist/`，用临时安全检查确认不覆盖旧产物。

## 宿主依据（只读参考仓库 HEAD `50265256ba56ac164a680da0689e1c6d90dac471`）
`docs/subsystems/plugin-runtime.md:274`、`internal/plugin/page.go:24-63,170-198,235-268`：`page.service` schema / `ServiceSpec` option取值、真实页面+host部分门槛；`internal/gui/pagebridge.js:1-42,80-92`：service只在ready后经bridge给页面，Theme/Visibility API；`internal/gui/pluginpage.go:223-252,330-365`：初始page CSP `connect-src 'none'`；`internal/gui/pageservice.go:112-180`：代理保留Origin:null、移除Cookie、sandbox响应，并按 `uiOrigin` 允许的来源调整服务页面CSP。官方页样例 `internal/gui/testdata/page-plugin/{package.json,page/index.html,app.js,style.css}`。

## fingerprint参考与安全边界
社区 `page-fingerprint` boot同样等ready后读取 `window.magpie.service`，设置 `uiOrigin` 后导航service；其service页用Origin校验、Bearer API auth、host allowlist及白名单资产。此插件据此实现最小固定路由，不照抄其大UI或大段实现。

## 验收/剩余
本轮目标是本地静态/单元集成验证、准确本地CLI安装/卸载说明与tarball；不运行宿主build、不部署、不发布、不做真实浏览器/CSP/远程proxy/真实宿主loader最终验收。另行由主代理安排独立代理执行真实宿主、页面代理及浏览器验收。本 brief 与报告可随该独立验收后续补充，但不得称已上线。
