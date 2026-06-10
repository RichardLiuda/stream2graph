# Stream2Graph Apps

`apps/` 是 Stream2Graph 正式平台的应用入口目录，包含可以直接运行和展示的前端、后端与本地音频辅助服务。对于比赛提交来说，这一层 README 可以作为评委快速理解系统形态的入口：它说明 Stream2Graph 解决什么问题、有哪些核心能力、三个应用如何协同，以及如何在本地快速打开完整演示。

## 项目简介

Stream2Graph 面向会议讨论、课堂讲解、访谈记录、头脑风暴和流程梳理等高信息密度场景，目标是把“不断流入的语音或文本”实时转化为“可阅读、可编辑、可回退、可导出的结构图”。传统记录工具通常只保留线性文字，用户需要在会后重新阅读、提炼、归类和画图；而 Stream2Graph 尝试把这个过程提前到实时阶段，让信息在产生时就同步进入结构化视图。

系统支持用户直接输入文本、粘贴 Transcript、使用浏览器语音识别，或通过本地音频辅助服务接入系统声音。后端会把转写片段组织为实时会话，经过 Gate、Planner 和 Renderer 等模块生成 Mermaid 主图与结构化节点，并在前端工作台中持续更新。用户可以查看历史快照、回退到某一时刻、编辑转写、添加批注、重新布局图表，并最终导出报告或图表结果。

对于参赛展示，推荐重点强调三点：

- **实时性**：内容输入后，图结构会随会话推进持续更新，而不是等全部文本结束后一次性生成。
- **可追溯性**：每次更新都有时间线和快照，用户可以回看图结构如何演化，也可以回退修正。
- **可操作性**：生成结果不是静态截图，而是可以继续批注、编辑、重排、下载和生成报告的工作台。

## 解决的问题

在多人讨论和长文本整理中，信息常常有三个痛点：

- **线性记录难以表达关系**：会议纪要或转写文本只能按时间排列，因果、层级、并列和流程关系不明显。
- **会后整理成本高**：用户需要重新阅读大量文本，再人工抽取重点、归并主题、绘制结构图。
- **AI 结果缺少过程控制**：一次性生成的图如果有错误，用户很难知道错误从哪一步开始，也难以回退到某个中间状态。

Stream2Graph 的应用层把这些问题拆成一条可操作链路：

```text
语音/文本输入 -> 转写片段 -> 实时会话 -> 结构规划 -> 图表渲染 -> 时间线快照 -> 编辑/回退/导出
```

这也是 `apps/` 下三个服务的职责边界：`web` 负责交互和展示，`api` 负责会话与智能处理，`audio-helper` 负责本地音频输入能力。

## 系统亮点

### 1. 实时工作台

前端实时工作台是比赛演示中最核心的页面。它把输入源、当前字幕、主图、结构视图、更新时间线、历史会话、批注工具和报告导出集中在同一个工作界面里。用户可以一边输入或播放语音，一边观察图结构逐步形成。

### 2. 双视图成图

系统同时维护 Mermaid 主图和结构化节点视图。主图适合快速展示流程与关系，结构视图适合检查节点、层级和连接。两者来自同一会话状态，便于对照和调试。

### 3. 时间线与回退

每次关键更新都可以形成快照。用户可以在时间线上选择历史版本，预览回退影响，再应用回退或编辑转写后重新生成。这让 AI 辅助成图从“不可控的一次性输出”变成“可追踪的编辑流程”。

### 4. 本地音频辅助

除浏览器输入外，`audio-helper` 提供本地系统音频转写能力，适合演示会议录音、在线视频、远程会议声音等场景。它作为独立服务运行，降低了前端和后端对操作系统音频环境的耦合。

### 5. 可配置模型链路

后端通过运行时配置管理 LLM、STT、Gate、Planner、声纹等能力。比赛演示时可以展示系统不绑定单一模型，而是支持 OpenAI compatible、讯飞等不同服务配置。

## 推荐演示路径

比赛现场可以按下面顺序演示：

1. 打开首页，简要说明 Stream2Graph 的目标：把实时语流整理成结构图。
2. 进入实时工作台：`/app/realtime`。
3. 选择演示模式或输入一段会议/流程类文本。
4. 发送 Transcript 或开启语音输入，观察主图和结构视图更新。
5. 展示时间线：选择历史快照，预览回退，说明可追溯能力。
6. 使用批注工具在画布上标记重点。
7. 导出报告或下载图表，说明结果可以沉淀和分享。
8. 进入设置页，展示模型和 STT 配置能力。

## 应用列表

| 目录 | 服务 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| [`web`](./web/README.md) | Next.js 前端 | `3000` | 首页、实时工作台、样本对照、报告中心、设置页和用户研究页 |
| [`api`](./api/README.md) | FastAPI 后端 | `8000` | 登录、数据集、实时会话、成图、回退、报告、运行任务和研究任务接口 |
| `audio-helper` | FastAPI 本地音频服务 | `8765` | 本机系统音频和 faster-whisper 转写辅助服务 |

## 架构概览

```text
Browser
  |
  | http://127.0.0.1:3000
  v
apps/web  -- /api/* rewrite -->  apps/api
  |                              |
  |                              | PostgreSQL / artifacts / reports
  |                              v
  +---- audio stream ---->  apps/audio-helper
```

常规浏览器请求只需要访问 `web`。前端的 `/api/*` 请求会由 Next.js rewrite 转发到 `api`，因此在局域网演示时，其他设备通常只需要打开 `http://<部署机器内网 IP>:3000`。

实时音频链路：

```text
Browser -> web :3000 -> audio-helper :8765 -> local transcription
Browser -> web :3000 -> api :8000 -> realtime session / graph updates
```

实时成图链路：

```text
Transcript chunk
  -> API realtime session
  -> Gate / Planner / Renderer
  -> Mermaid graph + structured nodes
  -> timeline snapshot
  -> Web canvas update
```

## 推荐启动方式

在仓库根目录启动整个平台。

Windows PowerShell：

```powershell
pnpm dev:up:win
pnpm dev:status:win
pnpm dev:down:win
```

macOS / Linux：

```bash
pnpm dev:up
pnpm dev:status
pnpm dev:down
```

启动后常用地址：

```text
Web:          http://127.0.0.1:3000
Realtime:     http://127.0.0.1:3000/app/realtime
API health:   http://127.0.0.1:8000/api/health
Audio health: http://127.0.0.1:8765/health
```

日志和 PID 位于仓库根目录：

```text
var/log/
var/run/
```

## 单独启动

只启动前端：

```bash
pnpm dev:web
```

只启动后端 API：

```bash
pnpm api:dev
```

只启动后端 worker：

```bash
pnpm api:worker
```

只启动音频辅助服务：

```bash
pnpm audio-helper:dev
```

## 依赖准备

前端依赖：

```bash
pnpm install
```

Python 虚拟环境建议统一放在仓库根目录 `.venv-platform`。

Windows PowerShell：

```powershell
py -3.11 -m venv .venv-platform
.\.venv-platform\Scripts\python.exe -m pip install -U pip
.\.venv-platform\Scripts\python.exe -m pip install -e "apps/api[test]"
.\.venv-platform\Scripts\python.exe -m pip install -e "apps/audio-helper"
```

macOS / Linux：

```bash
python3.11 -m venv .venv-platform
./.venv-platform/bin/python -m pip install -U pip
./.venv-platform/bin/python -m pip install -e "apps/api[test]"
./.venv-platform/bin/python -m pip install -e "apps/audio-helper"
```

## 配置入口

主要配置在仓库根目录 `.env`，从 `.env.example` 复制：

```bash
cp .env.example .env
```

重点变量：

- `DATABASE_URL`：API 数据库连接
- `S2G_ADMIN_USERNAME` / `S2G_ADMIN_PASSWORD`：管理员登录
- `API_PROXY_TARGET`：Web rewrite 到 API 的目标
- `NEXT_PUBLIC_API_BASE_URL`：前端直接访问 API 时的地址
- `NEXT_PUBLIC_AUDIO_HELPER_BASE_URL`：音频辅助服务地址
- `S2G_LLM_PROFILES_JSON`：LLM / Planner / Gate 配置
- `S2G_STT_PROFILES_JSON`：STT 配置

## 检查命令

前端类型检查：

```bash
pnpm typecheck:web
```

前端 lint：

```bash
pnpm lint:web
```

API 测试：

```bash
pnpm api:test
```

数据库迁移：

```bash
pnpm api:migrate
```

## 开发建议

- 跨应用接口变更时，同步更新 `packages/contracts` 和前端 API 客户端。
- Web 视觉和交互改动优先在 `apps/web/components` 内保持局部化。
- API 业务逻辑优先放在 `apps/api/app/services`，路由层保持薄。
- 本地音频能力与系统环境关系较大，调试时先访问 `/health`，再检查浏览器权限和日志。
- 提交前确认 `.env`、日志、PID、本地缓存和构建产物没有进入 Git。
