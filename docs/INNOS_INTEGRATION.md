# Innos 接入准备（阶段 9）

本文冻结 Easy BI Studio 接入 Innos Agent 平台所需的适配点。**本阶段不修改 Innos 代码**，只在 Studio 侧固定接口、映射与协议，确保后续接入时 Studio 页面与 Easy BI 业务模块无需重写。

## 1. 冻结的适配边界

Innos 接入只需实现以下四类适配，Studio 其余部分不变：

| 适配点 | Studio 侧契约 | Innos 需实现 |
|---|---|---|
| AI Provider | `AgentBridge`（`@easybi-studio/contracts`） | `InnosAgentBridge`：把 Innos 事件流映射为统一 `AgentEvent` |
| Skill 分发 | `SkillBundleSource` + `HttpRegistrySource`（已预留） | 版本列表 / Manifest / 不可变 Bundle 下载三个只读接口 |
| 进程托管 | `RuntimeSupervisor` 进程模型（spawn/停止/端口归属） | Sidecar 启停托管（见 §4） |
| 反向代理与导航 | Studio 管理 API `/api/easybi/*` + Runtime 代理 | 本地反代路径 + 页面导航挂载（见 §5） |

## 2. AgentBridge 冻结

`AgentBridge` 接口冻结为：

```ts
interface AgentBridge {
  healthCheck(): Promise<AgentHealth>;
  start(input: StartAgentInput): Promise<AgentTask>;
  continue(input: ContinueAgentInput): Promise<AgentTask>;
  cancel(taskId: string): Promise<void>;
  events(taskId: string): AsyncIterable<AgentEvent>;
}
```

统一事件类型（provider 必须归一化到这些，页面不解析私有协议）：

```
message_delta | tool_started | tool_finished | waiting_for_user | session | completed | failed
```

已有 `ClaudeCodeBridge`（真实）与 `FakeAgentBridge`（离线）两个实现验证了该抽象。`InnosAgentBridge` 只需产出相同事件。

### Innos 事件映射（建议）

| Innos 事件 | Studio AgentEvent |
|---|---|
| 文本增量 / token | `message_delta` |
| 工具调用开始 | `tool_started` |
| 工具调用结束 | `tool_finished`（`ok` 来自工具结果） |
| 需要人工确认 | `waiting_for_user`（`question`） |
| 会话建立 / 会话 ID | `session`（`sessionId`，用于 resume） |
| 运行完成 | `completed`（`summary`） |
| 运行失败 | `failed`（`error`，须脱敏） |

映射存根见 `packages/agent-bridge/src/innos-bridge.ts`（未连接，抛 NotImplemented）。

## 3. HttpRegistrySource 与 Innos Skill 分发契约

`HttpRegistrySource` **已是真实实现**（`packages/skill-bundle-source/src/sources/http-registry.ts`）：下载不可变归档 → 复用 `LocalArchiveSource` 完成解压/白名单/SHA-256/安装；可选 Bearer Token 从环境变量读取，不落盘、不入日志。Studio 侧通过配置即可启用（`EASYBI_SKILL_SOURCE_TYPE=http-registry`，`EASYBI_SKILL_SOURCE_DIR=<base URL>`）。因此 Innos 侧**只需实现服务端**——三个**只读**接口：

```
GET  {registry}/bundles/{bundleId}/versions          -> SkillBundleVersion[]
GET  {registry}/bundles/{bundleId}/{version}/manifest -> BundleManifest（含 files[] SHA-256）
GET  {registry}/bundles/{bundleId}/{version}/archive  -> 不可变 Bundle（tar.gz）
```

约束：
- 只分发可运行 Skill 与工作区模板；**不上传**客户数据库结构、知识库、报表结果、导出文件或 Secret；
- Bundle 版本不可变；下载后 Studio 仍走“来源 → 本地不可变缓存 → 工作区独立安装”；
- 校验白名单与 SHA-256 逻辑复用现有 `skill-bundle-source` / `skill-bundle-manager`，无需在 Innos 侧重复实现。

## 4. Sidecar 启停协议

Innos 将 Studio Service 作为本地 sidecar 托管：

- 启动：`node apps/studio-service/dist/main.js`，环境变量注入 `EASYBI_STUDIO_HOST/PORT`、`EASYBI_STUDIO_WORKSPACES_ROOT`、`EASYBI_STUDIO_DATA_DIR`、`EASYBI_SKILL_SOURCE_DIR`（或 registry 配置）、`EASYBI_AGENT_PROVIDER`；
- 就绪探测：`GET /api/easybi/health` 返回 `success:true`；
- 停止：`SIGTERM`；Studio 的 `onClose` 会停止自身启动的 Runtime 与文件监听，只清理自己启动的进程；
- Studio 重启后读取任务记录但不自动重启未知状态的 Agent/Runtime 进程（`reconcileOnStartup` 将中断任务标记 FAILED）。

## 5. 本地反代路径与认证上下文

- Innos 前端将 `/api/easybi/*` 反代到本地 sidecar；Runtime 代理路径 `/api/easybi/projects/{id}/runtime/api/v1/*` 保留原始响应（状态、Content-Type、Content-Disposition、X-EasyBI-*、Excel 二进制流、HTTP-200 JSON 错误）。同一路径透传 `POST .../queries`、`POST .../exports` 以及 `DELETE .../executions/{requestId}`、`DELETE .../tasks/{runtimeTaskId}`；取消不引入任何 Provider 专用协议。
- 认证上下文：Innos 在反代层完成登录/租户鉴权后，以头部（如 `X-EasyBI-Tenant`、`X-EasyBI-User`）向 sidecar 传递上下文；**客户数据库连接与工作区文件不经过 cloud-gateway**，始终留在本地。
- API Key/Secret：Studio 不读取、不保存、不展示；Claude/Innos 凭据由各自登录态或受控环境文件提供。
- 报表阶段编排属于 Studio 的 Provider 无关契约：Innos 仍只看到一个逻辑 task 和一条 SSE；基础建模、确定建模、逐查询编译及可选脚本编译在后端映射为多个全新 `AgentRun`。每个任务携带稳定 `reportId + reportRevision`，每个查询 run 可携带 `unitId`；阶段产物是否合格由 Studio 本地 Skill CLI 门禁判断，不依赖 Provider 自报成功。InnosAgentBridge 只需实现既有 `start/events/continue/cancel`，无需让前端理解或保存 Provider session。

## 6. 迁移清单（接入时）

1. 实现 `InnosAgentBridge`，在服务装配处按 `EASYBI_AGENT_PROVIDER=innos` 选择（`buildApp` 已支持注入 `agentBridge`）。
2. 实现 `HttpRegistrySource`（替换保留存根），复用缓存/安装/校验。
3. 配置 sidecar 启停与就绪探测。
4. 在 Innos 前端挂载 Studio 页面并配置反代与认证头。
5. 端到端验证：打开工作区 → 配置 → 知识库 → 报表 → 测试 → 发布，全部经 sidecar。

## 7. 不在本阶段做

- 不修改 Innos 代码；
- 不连接远程平台服务（HttpRegistrySource 仍为存根）；
- 不改动 Studio 页面与 Easy BI 业务模块结构。

## 8. 作为内部平台经 cloud-gateway 接入（核对 Innos 源码后补充）

依据 Innos 提交 `cc78f76《网关反代架构》` 与 `crates/cloud-gateway/src/main.rs`：

**Innos 的内部平台接入模型**：每个内部工具是一个独立进程，**只绑 `127.0.0.1`**，
由 `cloud-gateway:3722`（对外唯一入口，`0.0.0.0`）按**路径前缀反代**。加新工具 = 网关加一条反代路由。

- 反代样例（现有）：`/api/benchmark/* → 127.0.0.1:8920`、`/api/price/* → :8912`、`/api/perf/* → :8910`。
- 鉴权：网关在反代时注入**服务专属 token**（如 benchmark 的 `x-bench-token`），下游服务校验；
  网关侧先做用户/租户鉴权。
- SSE：网关对流式接口用 `bytes_stream()` 透传 + `x-accel-buffering: no`，**不缓冲**（见 `proxy_benchmark_sse`）。
- 前端：统一 `CLOUD_GATEWAY_URL` + fetch 包装器注入 base 和 token（见 desktop `renderer/config.ts` 的 `benchFetch`）。

**Studio 已天然符合该模型**（studio-service = Fastify，绑 `127.0.0.1:8932`，统一 `/api/easybi/*` 前缀）。
接入 Innos 的**改动清单**（最小）：

1. **网关加一条反代路由**：`/api/easybi/* → http://127.0.0.1:8932`。
   - Runtime 导出与 SSE（`/api/easybi/jobs/*/events`、Excel 流）走 `bytes_stream` 透传 + `x-accel-buffering:no`，不缓冲。
2. **服务 token 校验**：网关注入 `x-easybi-token`，studio-service 加一个中间件校验（预留 `EASYBI_SERVICE_TOKEN`）。
3. **前端 base/token 注入点**：studio-web 用一个 `getBaseUrl()`（默认相对 `/api`；可被设置/环境覆盖为网关地址）
   + fetch 包装器注入 token。本地开发直连 `127.0.0.1:8932` 不需要 token。
4. **AI 能力**：Studio 前端本轮已移除 AI 交互。将来接入 Innos AI = 实现走 cloud-gateway `/v1/messages`
   （Anthropic 协议）的 `InnosAgentBridge`（保留的 `AgentBridge` 抽象直接复用），前端再按需恢复对话 UI。
5. **样式**：studio-web 已对齐 Innos IDE-Mono 主题（见 `docs/UI_STYLE_GUIDE.md`），接入后视觉一致。

> 客户数据库连接与工作区文件**始终留在本地 sidecar，不经过 cloud-gateway**。
