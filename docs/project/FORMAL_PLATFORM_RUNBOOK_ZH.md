# Stream2Graph 正式平台运行手册

配套文档：

- [FORMAL_PLATFORM_USER_GUIDE_ZH.md](./FORMAL_PLATFORM_USER_GUIDE_ZH.md)

## 1. 平台目标

这套正式平台采用绿色重写路线，保留现有 Python 算法、评测和数据资产，但抛弃旧的原型式前后端。

当前交付覆盖 5 个核心模块：

- `/`：公开首页，展示项目定位、模块入口和正式平台能力
- `/login`：管理员登录页
- `/app/realtime`：实时成图工作台
- `/app/samples`：静态样本浏览与双模型对比
- `/study/[participantCode]`：参与者任务页
- `/app/reports`：实验、用户研究和导出管理页

## 2. 目录结构

```text
stream2graph/
├─ apps/
│  ├─ api/              # FastAPI + SQLAlchemy + Alembic
│  └─ web/              # Next.js App Router 正式前端
├─ packages/
│  ├─ contracts/        # 前后端共享 Zod DTO
│  └─ ui/               # 平台设计系统组件
├─ docs/project/
│  └─ FORMAL_PLATFORM_RUNBOOK_ZH.md
├─ var/artifacts/       # 运行产物、报告、导出文件
└─ docker-compose.platform.yml
```

## 3. 技术栈

- 前端：`Next.js 15 + TypeScript + Tailwind CSS + Radix UI primitives + TanStack Query + Zod`
- 后端：`FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL`
- 任务执行：独立 Python worker 轮询 `run_jobs`
- 数据与算法：继续复用仓库内现有 Python 研究代码

## 4. 本地启动

### 4.0 一键启动

如果你已经准备好 `.venv-platform` 和前端依赖，可以直接在仓库根目录执行：

```bash
pnpm dev:up
```

它会自动：

- 补 `.env`
- 尝试启动 PostgreSQL
- 执行 Alembic 迁移
- 后台启动 API / worker / Web

配套命令：

```bash
pnpm dev:status
pnpm dev:down
```

Windows PowerShell 对应命令：

```powershell
pnpm dev:up:win
pnpm dev:status:win
pnpm dev:down:win
pnpm dev:restart:win
```

默认日志目录：

- `var/log/api.log`
- `var/log/worker.log`
- `var/log/web.log`

Windows 说明：

- Windows 脚本位于 [scripts/dev-up.ps1](../../scripts/dev-up.ps1)、[scripts/dev-down.ps1](../../scripts/dev-down.ps1)、[scripts/dev-status.ps1](../../scripts/dev-status.ps1)、[scripts/dev-restart.ps1](../../scripts/dev-restart.ps1)
- 默认使用 `.venv-platform\Scripts\python.exe`、`.venv-platform\Scripts\uvicorn.exe` 和 `.venv-platform\Scripts\alembic.exe`
- 如果本机已自行启动 PostgreSQL，可先设置 `$env:S2G_START_DB='0'`
- 如果不需要额外后台进程，可设置 `$env:S2G_START_WORKER='0'` 或 `$env:S2G_START_AUDIO_HELPER='0'`

### 4.1 准备环境变量

复制根目录环境变量模板：

```bash
cp .env.example .env
```

关键变量：

- `DATABASE_URL`：PostgreSQL 连接串
- `S2G_ADMIN_USERNAME` / `S2G_ADMIN_PASSWORD`：管理员账号
- `S2G_DEFAULT_DATASET_VERSION`：默认数据集版本
- `NEXT_PUBLIC_API_BASE_URL`：前端请求 API 的地址
- `NEXT_PUBLIC_AUDIO_HELPER_BASE_URL`：前端连接本地音频辅助层的地址
- `S2G_AUDIO_HELPER_CORS_ORIGINS`：允许访问本地 helper 的前端域名列表
- `S2G_HELPER_TRANSCRIBER`：本地转写后端，默认 `faster_whisper`
- `S2G_HELPER_MODEL_SIZE`：Whisper 模型大小，默认 `small`

### 4.2 启动 PostgreSQL

```bash
docker compose -f docker-compose.platform.yml up -d
```

### 4.3 安装前端依赖

```bash
pnpm install
```

### 4.4 安装后端依赖

建议使用独立虚拟环境：

```bash
python3 -m venv .venv-platform
./.venv-platform/bin/pip install --index-url https://pypi.org/simple --trusted-host pypi.org --trusted-host files.pythonhosted.org -e "apps/api[test]"
```

### 4.5 执行数据库迁移

```bash
./.venv-platform/bin/alembic -c apps/api/alembic.ini upgrade head
```

备注：

- 当前 `apps/api/app/main.py` 在启动时也会执行 `Base.metadata.create_all(...)`
- Alembic 仍然保留为正式迁移入口，推荐继续使用迁移命令

### 4.6 启动 API

```bash
./.venv-platform/bin/uvicorn app.main:app --app-dir apps/api --reload
```

启动后可访问：

- API 健康检查：`http://127.0.0.1:8000/api/health`
- OpenAPI 文档：`http://127.0.0.1:8000/docs`

### 4.7 启动 worker

```bash
PYTHONPATH=apps/api ./.venv-platform/bin/python -m app.worker
```

或者通过环境变量启用 inline worker：

```bash
S2G_INLINE_WORKER=true ./.venv-platform/bin/uvicorn app.main:app --app-dir apps/api --reload
```

### 4.8 启动前端

```bash
pnpm dev:web
```

默认访问地址：

- Web：`http://127.0.0.1:3000`

### 4.9 启动系统声音辅助层（可选）

如果需要使用“系统声音（增强模式）”，先安装 helper 依赖，再在另一个终端执行：

```bash
./.venv-platform/bin/pip install -e "apps/audio-helper"
```

然后启动：

```bash
pnpm audio-helper:dev
```

默认访问地址：

- helper health：`http://127.0.0.1:8765/health`
- helper capabilities：`http://127.0.0.1:8765/capabilities`

当前实现会由浏览器提供共享音频流，再由 helper 在本机分段转写并通过 SSE 回推文本。

推荐检查点：

- `GET /capabilities` 返回 `supported`
- `transcriber_backend` 为 `faster_whisper` 或你显式设置的后端
- 如果返回 `limited`，通常是 helper 依赖还没安装，或跨域白名单没有包含当前前端域名

## 5. 已实现的 API 边界

### 5.1 认证

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

管理员会话使用服务端签名 cookie：`s2g_admin_session`

### 5.2 Catalog

- `GET /api/v1/catalog/datasets`
- `GET /api/v1/catalog/datasets/{slug}/splits`
- `GET /api/v1/catalog/datasets/{slug}/samples`
- `GET /api/v1/catalog/datasets/{slug}/samples/{sample_id}`

### 5.3 Realtime Sessions

以下接口要求管理员登录：

- `GET /api/v1/realtime/sessions`
- `POST /api/v1/realtime/sessions`
- `GET /api/v1/realtime/sessions/{session_id}`
- `POST /api/v1/realtime/sessions/{session_id}/chunks`
- `POST /api/v1/realtime/sessions/{session_id}/snapshot`
- `POST /api/v1/realtime/sessions/{session_id}/flush`
- `POST /api/v1/realtime/sessions/{session_id}/close`
- `POST /api/v1/realtime/sessions/{session_id}/report`

### 5.4 Runs

以下接口要求管理员登录：

- `GET /api/v1/runs`
- `POST /api/v1/runs/sample-compare`
- `POST /api/v1/runs/benchmark-suite`
- `GET /api/v1/runs/{run_id}`
- `GET /api/v1/runs/{run_id}/artifacts`
- `GET /api/v1/runs/{run_id}/artifacts/download`
- `GET /api/v1/runs/stream/events?run_id=...`

### 5.5 Studies

管理员接口：

- `GET /api/v1/studies/tasks`
- `POST /api/v1/studies/tasks`
- `POST /api/v1/studies/tasks/{task_id}/sessions`
- `GET /api/v1/studies/sessions`

参与者接口：

- `GET /api/v1/studies/participant/{participant_code}`
- `POST /api/v1/studies/participant/{participant_code}/start`
- `POST /api/v1/studies/participant/{participant_code}/events`
- `POST /api/v1/studies/participant/{participant_code}/autosave`
- `POST /api/v1/studies/participant/{participant_code}/submit`
- `POST /api/v1/studies/participant/{participant_code}/survey`

### 5.6 Reports

以下接口要求管理员登录：

- `GET /api/v1/reports`
- `GET /api/v1/reports/{report_id}`
- `GET /api/v1/reports/exports/download?target=...&fmt=...`

## 6. 页面与使用方式

### 6.1 实时成图工作台

管理员进入 `/app/realtime` 后可完成：

- 创建实时 session
- 粘贴 transcript 并逐条发送 chunk
- 使用麦克风输入浏览器语音识别结果
- 验证浏览器共享音频能力
- 连接本地系统声音辅助层
- 查看增量图区、事件流、稳定性指标和评测快照
- 保存 session report
- 关闭或恢复最近一次会话

音频输入相关补充约束：

- 当前工作台已支持文本 Transcript 和浏览器麦克风识别
- 后续正式平台必须补充“系统声音输入”能力
- 该能力需要同时考虑 macOS 与 Windows
- Windows 可优先考虑系统回环或浏览器系统音频采集
- macOS 需要重点评估共享标签页音频、屏幕采集音频和系统授权限制
- 即使系统声音能力未就绪，Transcript 输入也必须始终可用，作为稳定降级路径

### 6.2 样本浏览与对比

管理员进入 `/app/samples` 后可完成：

- 切换数据集版本和 split
- 检索 sample id
- 查看参考对话与参考 Mermaid
- 配置两个 predictor
- 发起可追溯 run job
- 通过 SSE 获取运行状态并查看双模型输出、compile 状态和离线指标

### 6.3 用户研究页

管理员在 `/app/reports` 中先创建 `StudyTask`，再发放 participant session。

参与者进入 `/study/{participantCode}` 后可完成：

- 查看任务说明和输入材料
- 查看系统初稿
- 编辑最终 Mermaid
- 自动保存草稿
- 提交最终答案
- 填写问卷
- 查看 compile 成功状态和自动评分结果

支持的研究条件：

- `manual`
- `heuristic`
- `model_system`

### 6.4 导出

管理员在 `/app/reports` 中可导出：

- `target=runs`
- `target=studies`
- `target=realtime`

导出格式：

- `json`
- `csv`
- `markdown`

所有导出和运行产物会写入 `var/artifacts/`

## 7. 设计实现说明

前端采用轻量但正式的平台设计系统，方向为：

- 中文优先
- light-first
- 圆角、层次、柔和背景和明确状态反馈
- 参考 Material Design 3 的层次与反馈理念，但不照搬 M3 外观

当前 UI 基础能力由 `packages/ui` 提供：

- `Button`
- `Card`
- `Input`
- `Textarea`
- `Badge`
- `StatCard`
- `SectionHeading`

## 8. 数据与算法集成策略

本次重写不改写原有研究算法。

新后端的策略是：

- 实时成图：直接包装旧版 realtime pipeline 运行时
- 样本对比与离线指标：调用现有 predictor / metrics 能力
- benchmark 套件：通过受控 job + worker 执行
- 报告与导出：统一走新平台 report service

## 9. 当前建议的验证命令

前端：

```bash
pnpm typecheck:web
pnpm lint:web
```

后端：

```bash
python3 -m py_compile apps/api/app/*.py apps/api/app/routers/*.py apps/api/app/services/*.py apps/api/tests/*.py
./.venv-platform/bin/python -m pytest apps/api/tests
```

## 10. 后续扩展建议

- 把 `catalog` 的公开能力与管理员能力进一步拆开
- 为 `runs`、`studies` 和 `reports` 补更完整的 API 集成测试
- 把当前内嵌 worker 拆成独立 deployable service
- 为前端补 Playwright E2E
- 将首页内容进一步和论文叙事、版本索引打通
