# Session Date Filter / 会话日期清理

> **开发中：阶段 1 / 3。** 当前仅有纯函数过滤与单元测试；尚无 magpie 插件 manifest、request hook、统计存储、页面或安装包。不要安装到生产环境。

此独立插件计划在 magpie 的公开请求 hook 中，对客户端请求中的 LobeHub Memory / Credentials 工具提示词执行窄范围变换：只移除经结构 wrapper 确认的 `<session_context>` 中完整英文 `Session date: Weekday, Month D, YYYY` 行。它不会扫描任意 system prompt、user/assistant/tool 内容、未知字段、图片或非文本块；不做协议转换。纯逻辑模块不发网络请求、不记录请求正文、不保留 key、模型、会话或 provider 明细。

此操作只计提示词变换次数，不代表模型端缓存命中率，也不能保证节省 token 或改善缓存。其他动态提示词、路由和缓存 TTL 仍会影响结果。删除日期可能减弱 Memory 在消息缺少时间戳时的相对时间 fallback。

由于正文中完全伪造与目标工具完全相同的 XML 包装无法可靠地从真实工具模板语义区分，匹配只做严格结构约束，并不承诺绝无误匹配。日期匹配也不是对整个 JSON 序列化字节完全不变；除删除的目标行与其行分隔符外，结构及非文本元数据应保持。

## 本阶段纯函数接口

- `src/matcher.mjs`：`stripSessionDates(text) -> { text, removedLines }`
- `src/protocols.mjs`：`filterRequest(body, protocol) -> { body, removedLines, supported }`
- 支持协议：chat、responses、anthropic、gemini。只检查 system/developer 或协议顶层系统指令位置；content blocks 需要有协议规定的 text discriminator（Gemini Part 按 `text` 成员识别，并对混合未知字段 fail-open）。未知协议及 malformed 内容 fail-open；不扫描其他对象的任意 `text` 字段。

## 本地测试

无需安装依赖：

```sh
npm test
```

实现计划与精确边界见 `docs/superpowers/specs/2026-11-04-session-date-filter-design.md` 和 `docs/superpowers/plans/2026-11-04-session-date-filter-plan.md`。
