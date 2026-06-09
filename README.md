# Stream2Graph

Stream2Graph 是一个把语音、转写文本和会议内容实时整理成结构图的工程仓库。当前主线是正式平台，包含 Next.js 前端、FastAPI 后端、共享类型契约和 UI 组件库；旧版数据集、脚本和实验报告仍保留在 `versions/`、`tools/`、`reports/` 等目录中，方便复现实验和追踪演进。

## 当前平台

正式平台入口：

- 前端应用：[apps/web](./apps/web/README.md)
- 后端 API：[apps/api](./apps/api/README.md)
- 系统音频辅助服务：`apps/audio-helper`
- 前后端共享契约：`packages/contracts`
- 共享 UI 组件：`packages/ui`

常用页面：

- 首页：`http://127.0.0.1:3000`
- 实时工作台：`http://127.0.0.1:3000/app/realtime`
- 样本对照：`http://127.0.0.1:3000/app/samples`
- 报告中心：`http://127.0.0.1:3000/app/reports`
- 设置页：`http://127.0.0.1:3000/app/settings`
- API 健康检查：`http://127.0.0.1:8000/api/health`

## 目录结构

```text
apps/
  web/             Next.js 前端应用
  api/             FastAPI 后端服务
  audio-helper/    本地系统音频和转写辅助服务
packages/
  contracts/       Zod schema 与 TypeScript 类型
  ui/              React UI 基础组件
docs/              项目说明、运行手册、研究和方案文档
versions/          历史数据集与算法版本归档
tools/             数据处理、评测、渲染和实验工具
reports/           实验报告、评测报告、变更报告
configs/           评测和运行配置
scripts/           开发环境启动、停止、状态检查脚本
var/               本地运行日志、PID、产物缓存
```

## 环境要求

- Node.js 与 pnpm，仓库声明的包管理器为 `pnpm@10.30.3`
- Python 3.11+
- PostgreSQL，本地默认端口 `5432`
- Windows 用户建议使用 PowerShell 运行 `*:win` 脚本

首次准备：

```bash
pnpm install
cp .env.example .env
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
py -3.11 -m venv .venv-platform
.\.venv-platform\Scripts\python.exe -m pip install -U pip
.\.venv-platform\Scripts\python.exe -m pip install -e "apps/api[test]"
.\.venv-platform\Scripts\python.exe -m pip install -e "apps/audio-helper"
```

macOS / Linux 可用：

```bash
python3.11 -m venv .venv-platform
./.venv-platform/bin/python -m pip install -U pip
./.venv-platform/bin/python -m pip install -e "apps/api[test]"
./.venv-platform/bin/python -m pip install -e "apps/audio-helper"
```

## 快速启动

Windows 一键启动：

```powershell
pnpm dev:up:win
pnpm dev:status:win
pnpm dev:down:win
```

macOS / Linux 一键启动：

```bash
pnpm dev:up
pnpm dev:status
pnpm dev:down
```

默认会管理：

- API：`0.0.0.0:8000`
- Web：`0.0.0.0:3000`
- worker：后台任务处理
- audio-helper：`0.0.0.0:8765`
- PostgreSQL：如果配置允许，启动脚本会尝试检查或拉起数据库

日志和 PID 默认写入：

- `var/log/api.log`
- `var/log/web.log`
- `var/log/worker.log`
- `var/log/audio-helper.log`
- `var/run/*.pid`

## 分服务启动

只启动前端：

```bash
pnpm dev:web
```

只启动 API：

```bash
pnpm api:dev
```

只启动 worker：

```bash
pnpm api:worker
```

只启动音频辅助服务：

```bash
pnpm audio-helper:dev
```

数据库迁移：

```bash
pnpm api:migrate
```

检查：

```bash
pnpm typecheck:web
pnpm lint:web
pnpm api:test
```

## 配置说明

主要配置来自根目录 `.env`，可从 `.env.example` 复制。

常见变量：

- `DATABASE_URL`：PostgreSQL 连接串
- `S2G_SESSION_SECRET`：登录会话密钥
- `S2G_ADMIN_USERNAME` / `S2G_ADMIN_PASSWORD`：默认管理员账号
- `S2G_CORS_ORIGINS` / `S2G_CORS_ORIGIN_REGEX`：API CORS 白名单
- `NEXT_PUBLIC_API_BASE_URL`：前端直接访问 API 时的默认地址
- `API_PROXY_TARGET`：Next.js 服务端 rewrite 的 API 目标
- `NEXT_PUBLIC_API_BROWSER_PROXY`：默认走同源 `/api/*` 转发，设为 `0` 时关闭
- `NEXT_PUBLIC_AUDIO_HELPER_BASE_URL`：音频辅助服务地址
- `S2G_LLM_PROFILES_JSON`：Gate / Planner / 模型配置
- `S2G_STT_PROFILES_JSON`：语音识别配置

默认情况下，浏览器访问前端的 `/api/*` 会由 Next.js 转发到 FastAPI，局域网访问时手机或平板只需要打开前端地址，通常不需要浏览器直接访问 `:8000`。

## 局域网访问

在同一 Wi-Fi 或交换机下：

1. 部署机器启动服务：

```bash
pnpm api:dev:lan
pnpm dev:web:lan
pnpm audio-helper:dev:lan
```

2. 其他设备访问：

```text
http://<部署机器内网 IP>:3000
```

3. 确认系统防火墙放行：

- `3000`：前端
- `8000`：API
- `8765`：音频辅助服务
- `5432`：PostgreSQL，仅在确有需要时开放

## 主要能力

- 实时工作台：输入文本、浏览器语音、系统音频转写、实时成图、时间线回退、批注、导出报告
- 运行时配置：在设置页管理 LLM、STT、声纹等配置
- 样本对照：浏览数据集版本、样本和实验对照
- 报告中心：查看与下载实验报告
- 研究任务：`/study/[participantCode]` 支持用户研究流程
- 评测与数据处理：`tools/`、`configs/evaluation/`、`reports/evaluation/` 保留离线实验工具链

## 共享包

`packages/contracts` 提供前后端共享的 Zod schema 与 TypeScript 类型。前端 API 客户端会用这些 schema 校验后端响应，减少接口漂移。

`packages/ui` 提供 Card、Button、Badge 等基础组件，用于统一正式平台视觉风格。

## 历史版本与数据集

历史实验主线保存在 `versions/`：

- `versions/v1_2026-02-05_legacy_8k_pipeline`
- `versions/v2_2026-02-08_real_100percent_license_fix`
- `versions/v3_2026-02-27_latest_9k_cscw`

版本索引见：[VERSION_INDEX.md](./VERSION_INDEX.md)

当前 API 默认数据集版本由 `S2G_DEFAULT_DATASET_VERSION` 控制，默认值在 `apps/api/app/config.py` 中定义。

## 推荐文档

- [正式平台运行手册](./docs/project/FORMAL_PLATFORM_RUNBOOK_ZH.md)
- [正式平台使用指南](./docs/project/FORMAL_PLATFORM_USER_GUIDE_ZH.md)
- [项目总览](./docs/project/PROJECT_OVERVIEW_ZH.md)
- [开发工具说明](./docs/project/STREAM2GRAPH_DEVELOPMENT_TOOLS_ZH.md)
- [工作区布局](./docs/workspace/WORKSPACE_LAYOUT.md)

## 常见问题

前端打开后 API 报错：

- 确认 `http://127.0.0.1:8000/api/health` 返回正常
- 确认 `.env` 中 `API_PROXY_TARGET` 或 `NEXT_PUBLIC_API_BASE_URL` 指向正确 API
- 如果前端端口不是 `3000`，检查 API 的 CORS 配置

语音或系统音频不可用：

- 浏览器语音依赖浏览器能力和权限
- 系统音频依赖 `apps/audio-helper` 服务
- 检查 `http://127.0.0.1:8765/health`

Windows 启动脚本找不到 Python：

- 确认 `.venv-platform\Scripts\python.exe` 存在
- 重新创建虚拟环境并安装 `apps/api`、`apps/audio-helper`

## 安全提醒

- 不要提交真实 API Key、数据库密码或第三方服务密钥
- `.env` 应保留在本地，提交前检查 `git status`
- 对外部署时请替换默认管理员密码和 `S2G_SESSION_SECRET`
