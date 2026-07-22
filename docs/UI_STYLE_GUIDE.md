# Easy BI Studio UI 规范（对齐 Innos IDE-Mono 主题）

本规范用于让 Studio 前端与 Innos 平台视觉一致，后续接入后无需重做样式。
样式来源：Innos `embodied-platform/desktop/src/renderer/styles/innos-tokens.css`
（提交 `1bdec31 style(benchmark): 重构模型测试平台 UI 对齐 IDE mono 主题`）。

## 0. 技术栈

- React 18 + Vite + TypeScript（与 Innos admin-ui / desktop 同栈）。
- Tailwind v4：`@tailwindcss/vite` 插件 + CSS 里 `@import "tailwindcss"`。
- 图标：`lucide-react`。
- 不引入 UI 组件库；用设计令牌 + 少量组件类 + Tailwind 原子类。

## 1. 主题模型

- **Light = Mono White**（默认，`:root`）；**Dark = Mono Grayscale**（`[data-theme="dark"]`）。
- 强调色 `--ide-accent` 是**单色**：Light 近黑 `#1a1a1a`，Dark 近白 `#f0f0f0`。**不要用彩色主色**；
  彩色仅用于语义状态（success/warning/error/info）。
- 挂载：`applyTheme()` 给 `document.documentElement` 设 `data-theme`；持久化 key `easybi-theme`；
  首屏在入口先调用，防明暗闪烁。
- 作用域：token（`--ide-*`）全局；结构性 class 建议放在根 `.innos-app` 包裹下（与 Innos 一致，
  避免样式外泄）。Studio 是独立应用，根节点固定加 `className="innos-app"`。

## 2. 设计令牌（`--ide-*`）

### Surfaces / 文本 / 边框（Light / Dark）

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--ide-bg-app` | `#ffffff` | `#1a1a1a` | 应用底色 |
| `--ide-bg-chrome` | `#f7f7f7` | `#141414` | 侧栏/标题栏 |
| `--ide-bg-panel` | `#ffffff` | `#1a1a1a` | 面板 |
| `--ide-bg-elevated` | `#ffffff` | `#232323` | 卡片/悬浮/hover 行 |
| `--ide-bg-input` | `#ffffff` | `#1f1f1f` | 表单输入 |
| `--ide-border-subtle` | `#ececec` | `#2a2a2a` | 细分隔 |
| `--ide-border` | `#e0e0e0` | `#333333` | 常规边框 |
| `--ide-border-strong` | `#c8c8c8` | `#3d3d3d` | 强边框 |
| `--ide-text-primary` | `#1a1a1a` | `#e5e5e5` | 主文本 |
| `--ide-text-secondary` | `#5a5a5a` | `#a0a0a0` | 次文本 |
| `--ide-text-tertiary` | `#888888` | `#6e6e6e` | 三级/占位 |
| `--ide-text-muted` | `#b0b0b0` | `#4a4a4a` | 最弱 |
| `--ide-accent` | `#1a1a1a` | `#f0f0f0` | 强调（单色） |
| `--ide-accent-soft` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.08)` | 强调软背景 |
| `--ide-accent-ring` | `rgba(0,0,0,.12)` | `rgba(255,255,255,.18)` | 焦点环 |
| `--ide-text-on-accent-inverse` | `#ffffff` | `#1a1a1a` | 强调背景上的文字 |

### 语义状态色

| Token | Light | Dark |
|---|---|---|
| `--state-success` | `#1faa6a` | `#2dbd7e` |
| `--state-warning` | `#c98610` | `#d8a657` |
| `--state-error` | `#d23a3a` | `#ff7373` |
| `--state-info` | `#2a85e8` | `#5cb4e8` |

### 字体 / 间距 / 圆角 / 阴影

- 字体：`--ide-font-sans`（Inter/PingFang/系统）、`--ide-font-mono`（JetBrains Mono…）。
- 字号：`--ide-fz-2xs..xl`（10/11/12/13/14/16px）。
- 间距：`--ide-sp-1..8`（2/4/6/8/12/16/20/24px）。
- 圆角：`--ide-radius-sm/md/lg/full`（4/6/8/9999px）。
- 阴影：`--ide-shadow-1 / -card / -pop / -modal`（很克制；浮层允许更深）。
- 焦点环：`--ide-ring`。

## 3. 组件类

从 `innos-tokens.css` 移植到 Studio `src/styles.css`（保持类名一致，便于对照）：

- `.ide-card`：面板/卡片（bg-elevated + border + radius-md）。
- `.ide-input`：输入框（focus 用 accent 边框 + ring）。
- `.ide-btn` / `.ide-btn-primary` / `.ide-btn-ghost` / `.ide-btn-icon`：按钮族（高 28px）。
- `.ide-panel`：侧栏面板底。
- `.ide-scroll`：细滚动条。
- `.ide-text-mono` / `.ide-text-sans` / `.ide-truncate`：排版辅助。
- 图标尺寸：`.ic-12/14/16/18/22`（约束未设尺寸的 lucide SVG）。

结构类（作用域 `.innos-app`）：
- 侧栏：`.sidebar` `.sb-top` `.app-brand` `.brand-mark` `.brand-name` `.sb-section`
  `.sb-nav-item(.active)` `.sb-new` `.sb-bottom` `.sb-theme-toggle`。
- 顶栏：`.topbar` `.crumb` `.topbar-right` `.topbar-iconbtn`；分段标签 `.ws-tabs` `.ws-tab(.active)`。
- 卡片网格/KPI、trace/log-line（工具轨迹，用于 AI 抽屉的执行过程渲染）。

## 3.1 AI 对话抽屉

- 全局对话抽屉在 App 根挂载（`AgentDrawerProvider`），跨页面共享任务；页面通过
  `useAgentDrawer().startAction(projectId, action, prompt?)` 唤起。
- **只经 AgentBridge + Job/SSE**：抽屉调用 `/api/easybi/agent-actions`（发起）、
  `/agent-tasks/:id/messages`（多轮回复）、`/agent-tasks/:id/cancel`（取消）、
  `/jobs/:id/events`（SSE 流式）。前端**不得**直连任何 AI 厂商 API，不得内嵌厂商协议。
- Provider 由后端环境变量 `EASYBI_AGENT_PROVIDER` 决定（本机 `claude` → 后续 `innos`），
  前端不感知、不需改动；抽屉用 `/api/easybi/agent-health` 展示当前 Provider。
- 事件→视图的映射逻辑放纯函数 `panels/agent-chat.ts`（可单测），组件只负责渲染。
- 写类动作（write）由后端自动建检查点，前端在快捷入口标注「写」。

## 4. 布局骨架

```
<div class="innos-app">            // flex row, 100vh, bg-app
  <aside class="sidebar">          // 侧栏：品牌 + 工作区切换/新建 + 导航 + 底部主题切换
  <div class="canvas flex-1">      // 主区
    <header class="topbar">        // 顶栏：面包屑 + 右侧操作
    <main class="page-body ide-scroll">  // 滚动内容
  </div>
</div>
```

- 无 react-router：用 union 类型 `route`/`tab` 状态切换（与 Innos admin-ui 一致）。
- 页面统一 `TopBar + PageBody` 组合；卡片用 `.ide-card`；表格用 emb→ide 表格样式。

## 5. 接入 cloud-gateway 的前端契约（后续接入用）

Innos 内部工具前端统一：
- 一个 `CLOUD_GATEWAY_URL`（如 `https://innos-bot.canpan.net/cloud-gateway`）。
- 统一 fetch 包装器注入 base + 服务 token（如 benchmark 的 `x-bench-token`）。
- Studio 接入时对应：所有 `/api/easybi/*` 前端请求经网关反代到 `127.0.0.1:8932`；
  网关注入 `x-easybi-token`，studio-service 校验。当前本地开发直连 `127.0.0.1:8932`，
  用一个 `getBaseUrl()`（默认相对 `/api`，可被环境/设置覆盖为网关地址）预留切换点。

## 6. 命名与约定

- 令牌一律 `--ide-*` / `--state-*`；组件类 `ide-*`；结构类置于 `.innos-app` 下。
- 颜色只用令牌，不写死 hex（状态色也走 `--state-*`）。
- 图标只用 lucide-react；尺寸走 `.ic-*` 或显式 `w-4 h-4`。
- 中文优先、tabular-nums 用于数字列。
