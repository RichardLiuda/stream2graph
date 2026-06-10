# Stream2Graph API

`apps/api` 是 Stream2Graph 正式平台的后端服务，基于 FastAPI、SQLAlchemy、Alembic、PostgreSQL 和 Pydantic Settings 构建。

## 职责

- 管理管理员登录和会话
- 提供数据集、样本、运行时配置接口
- 支持实时工作台会话、转写、成图、时间线、回退、批注和报告生成
- 管理语音识别、声纹和模型配置
- 运行样本对照、benchmark、研究任务和报告导出
- 通过 worker 处理后台任务

## 目录结构

```text
apps/api/
  app/
    main.py              FastAPI app 工厂与路由注册
    config.py            环境变量配置
    db.py                SQLAlchemy engine/session
    models.py            数据库模型
    schemas.py           API schema
    routers/             HTTP 路由
    services/            业务逻辑
    worker.py            后台任务入口
  alembic/               数据库迁移
  tests/                 pytest 测试
  pyproject.toml         Python 包配置
  alembic.ini            Alembic 配置
```

## 运行

推荐从仓库根目录启动：

```bash
pnpm api:dev
```

Windows 一键平台启动会同时管理 API、前端、worker 和 audio-helper：

```powershell
pnpm dev:up:win
pnpm dev:status:win
pnpm dev:down:win
```

API 默认地址：

```text
http://127.0.0.1:8000
```

健康检查：

```text
http://127.0.0.1:8000/api/health
```

## Python 环境

Python 版本要求：`>=3.11`

Windows PowerShell：

```powershell
py -3.11 -m venv .venv-platform
.\.venv-platform\Scripts\python.exe -m pip install -U pip
.\.venv-platform\Scripts\python.exe -m pip install -e "apps/api[test]"
```

macOS / Linux：

```bash
python3.11 -m venv .venv-platform
./.venv-platform/bin/python -m pip install -U pip
./.venv-platform/bin/python -m pip install -e "apps/api[test]"
```

## 数据库

默认连接：

```env
DATABASE_URL=postgresql+psycopg://stream2graph:stream2graph@127.0.0.1:5432/stream2graph
```

执行迁移：

```bash
pnpm api:migrate
```

启动时 `create_app()` 会执行基础初始化：

- 创建缺失的表
- 创建或更新默认管理员
- 同步数据集版本目录

生产或共享环境仍建议显式执行 Alembic 迁移。

## 常用命令

```bash
pnpm api:dev
pnpm api:dev:lan
pnpm api:worker
pnpm api:migrate
pnpm api:test
```

直接运行：

```bash
PYTHONPATH=apps/api ./.venv-platform/bin/uvicorn app.main:app --app-dir apps/api --host 0.0.0.0 --port 8000 --reload
```

Windows 可参考 `scripts/dev-up.ps1` 中的命令，使用 `.venv-platform\Scripts\uvicorn.exe`。

## 配置

配置由 `app/config.py` 的 `Settings` 读取，默认从根目录 `.env` 加载。

关键变量：

- `DATABASE_URL`：数据库连接
- `S2G_SESSION_SECRET`：会话签名密钥
- `S2G_ADMIN_USERNAME` / `S2G_ADMIN_PASSWORD` / `S2G_ADMIN_DISPLAY_NAME`：默认管理员
- `S2G_CORS_ORIGINS`：显式允许的前端来源
- `S2G_CORS_ORIGIN_REGEX`：局域网或穿透域名正则
- `S2G_COOKIE_SECURE` / `S2G_COOKIE_SAMESITE` / `S2G_COOKIE_DOMAIN`：Cookie 策略
- `S2G_DEFAULT_DATASET_VERSION`：默认数据集版本
- `S2G_INLINE_WORKER`：是否在 API 进程内启动 worker
- `S2G_LLM_PROFILES_JSON`：OpenAI compatible 等 LLM 配置
- `S2G_STT_PROFILES_JSON`：STT 配置
- `S2G_MERMAID_COMPILE_COMMAND`：可选 Mermaid 编译命令

## 路由分组

所有业务路由默认挂载在 `/api/v1` 下。

```text
/api/health
/api/v1/auth/*
/api/v1/datasets/*
/api/v1/runtime-options*
/api/v1/realtime/*
/api/v1/voiceprints/*
/api/v1/runs/*
/api/v1/studies/*
/api/v1/reports/*
```

实时工作台核心接口：

```text
GET    /api/v1/realtime
POST   /api/v1/realtime
GET    /api/v1/realtime/{session_id}
PATCH  /api/v1/realtime/{session_id}
PUT    /api/v1/realtime/{session_id}
DELETE /api/v1/realtime/{session_id}
POST   /api/v1/realtime/{session_id}/chunks
POST   /api/v1/realtime/{session_id}/chunks/batch
POST   /api/v1/realtime/{session_id}/audio/transcriptions
GET    /api/v1/realtime/{session_id}/timeline
POST   /api/v1/realtime/{session_id}/rollback/preview
POST   /api/v1/realtime/{session_id}/rollback/apply
POST   /api/v1/realtime/{session_id}/rollback/edit_apply
POST   /api/v1/realtime/{session_id}/snapshot
POST   /api/v1/realtime/{session_id}/flush
POST   /api/v1/realtime/{session_id}/diagram-relayout
GET    /api/v1/realtime/{session_id}/transcript/download
POST   /api/v1/realtime/{session_id}/close
POST   /api/v1/realtime/{session_id}/report
POST   /api/v1/realtime/{session_id}/graph
```

## 服务层

重要服务：

- `services/realtime_coordination.py`：实时工作台主协调逻辑
- `services/realtime_ai.py`：Gate、Planner、模型调用与图生成
- `services/realtime_transcript.py`：转写片段处理
- `services/runtime_options.py`：运行时配置读写和连接测试
- `services/runtime_sessions.py`：实时会话状态
- `services/xfyun_asr.py`：讯飞 ASR 和声纹相关逻辑
- `services/runs.py`：运行任务
- `services/reports.py`：报告管理
- `services/studies.py`：用户研究任务

## 测试

运行全部 API 测试：

```bash
pnpm api:test
```

等价直接命令：

```bash
PYTHONPATH=apps/api ./.venv-platform/bin/python -m pytest apps/api/tests
```

常见测试文件：

- `tests/test_api_workflows.py`
- `tests/test_realtime_contracts.py`
- `tests/test_mermaid_prompting.py`
- `tests/test_xfyun_asr.py`

## 日志与产物

平台脚本默认写入：

```text
var/log/api.log
var/log/worker.log
var/run/api.pid
var/run/worker.pid
var/artifacts/
```

数据集默认来自：

```text
versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset
```

## 排错

API 无法启动：

- 检查 `.venv-platform` 是否存在
- 检查依赖是否安装：`pip install -e "apps/api[test]"`
- 检查 `DATABASE_URL` 是否可连接
- 检查端口 `8000` 是否被占用

前端登录或请求失败：

- 检查 `S2G_SESSION_SECRET`
- 检查 CORS 和 Cookie 配置
- 优先使用 Next.js 同源 `/api/*` 代理，减少跨域问题

实时成图失败：

- 检查 `S2G_LLM_PROFILES_JSON`
- 检查模型 API Key 对应的环境变量是否存在
- 查看 `var/log/api.log`

语音识别失败：

- 检查 `S2G_STT_PROFILES_JSON`
- 检查对应 provider 的 endpoint、app_id、api_key、api_secret
- 查看 `services/xfyun_asr.py` 相关日志
