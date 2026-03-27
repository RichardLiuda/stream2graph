# Stream2Graph Versioned Archive

## 正式平台入口

2026-03 起，仓库中已经新增一套绿色重写的正式平台：

- 前端：`apps/web`
- 后端：`apps/api`
- 共享类型：`packages/contracts`
- UI 组件：`packages/ui`

建议优先阅读下面两份文档：

- [正式平台运行手册](./docs/project/FORMAL_PLATFORM_RUNBOOK_ZH.md)
- [正式平台使用指南](./docs/project/FORMAL_PLATFORM_USER_GUIDE_ZH.md)

常用命令：

```bash
pnpm dev:up
pnpm dev:status
pnpm dev:down
pnpm dev:up:win
pnpm dev:status:win
pnpm dev:down:win
pnpm dev:web
pnpm audio-helper:dev
pnpm api:dev
pnpm api:worker
pnpm typecheck:web
pnpm lint:web
pnpm api:test
```

说明：

- `pnpm dev:up` 会自动补 `.env`、尝试拉起 PostgreSQL、执行迁移，并后台启动 API / Web / worker
- `pnpm dev:up:win` / `dev:status:win` / `dev:down:win` / `dev:restart:win` 为 Windows PowerShell 对应脚本，默认也会管理 API / Web / worker / audio-helper
- `pnpm audio-helper:dev` 会启动本地系统声音辅助层，默认监听 `127.0.0.1:8765`
- 启动 helper 前，先在虚拟环境里安装：`./.venv-platform/bin/pip install -e "apps/audio-helper"`
- 进程日志默认写到 `var/log/`，PID 写到 `var/run/`
- `pnpm api:*` 系列命令默认在已经激活 `.venv-platform` 的 shell 中执行

Windows 额外说明：

- PowerShell 脚本使用 `.venv-platform\Scripts\python.exe`、`.venv-platform\Scripts\uvicorn.exe`、`.venv-platform\Scripts\alembic.exe`
- 如果本机 PostgreSQL 已经在运行，可以先设置 `$env:S2G_START_DB='0'` 再执行 `pnpm dev:up:win`
- 如果暂时不需要 worker 或 audio helper，可以分别设置 `$env:S2G_START_WORKER='0'`、`$env:S2G_START_AUDIO_HELPER='0'`

这个仓库是对 `/home/lin-server/pictures` 的版本化整理结果，目的是把不同阶段的数据集与脚本分开保存，便于追溯与复现实验。

## 版本目录

- `versions/v1_2026-02-05_legacy_8k_pipeline`
  - 8k 五阶段流水线时代产物（含 `01~05` 目录与早期脚本）
- `versions/v2_2026-02-08_real_100percent_license_fix`
  - 许可证修复与 high-quality 子集阶段
- `versions/v3_2026-02-27_latest_9k_cscw`
  - 最新版本（9k 数据 + CSCW 对话逆向工程）

详细说明见 [VERSION_INDEX.md](./VERSION_INDEX.md)。

## 最新可用发布集

- 发布路径: `versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228`
- 筛选规则:
  - `compilation_status == success`
  - 许可证有效（排除 `none/error/unknown/rate_limited`）
  - 存在 `cscw_dialogue` 且轮次在 `4~120`
- 当前规模: 4709 条
- 生成报告:
  - `reports/release_reports/release_v3_latest.md`
  - `reports/release_reports/release_v3_latest.json`

## 核心算法升级（2026-02-28）

最新算法脚本位于：

- `versions/v3_2026-02-27_latest_9k_cscw/scripts/cscw_dialogue_engine.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/run_reverse_engineering_v2.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/streaming_intent_engine.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/benchmark_streaming_intent.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/asr_stream_adapter.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/incremental_renderer.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/run_realtime_pipeline.py`
- `versions/v3_2026-02-27_latest_9k_cscw/scripts/evaluate_realtime_pipeline.py`

升级报告：

- `versions/v3_2026-02-27_latest_9k_cscw/docs/CORE_ALGO_UPGRADE_REPORT_20260228_STEP1.md`
- `versions/v3_2026-02-27_latest_9k_cscw/docs/CORE_ALGO_UPGRADE_REPORT_20260228_STEP2.md`

## 端到端闭环（ASR -> 意图 -> 增量渲染）

### 1) 运行实时流水线

```bash
python3 versions/v3_2026-02-27_latest_9k_cscw/scripts/run_realtime_pipeline.py \
  --input /path/to/transcript.jsonl \
  --realtime \
  --time-scale 1.0 \
  --output /tmp/realtime_pipeline_output.json
```

输入 transcript 支持字段：

- `timestamp_ms` (int, 可选)
- `text` (str, 必填)
- `speaker` (str, 可选)
- `is_final` (bool, 可选)
- `expected_intent` (str, 可选，用于评测)

### 2) 运行真实实时评测

```bash
python3 versions/v3_2026-02-27_latest_9k_cscw/scripts/evaluate_realtime_pipeline.py \
  --input /path/to/transcript.jsonl \
  --realtime \
  --pipeline-output /tmp/realtime_pipeline_full.json \
  --report-output /tmp/realtime_eval_report.json
```

评测输出包含：

- 端到端延迟（P50/P95）
- 意图识别准确率与 Macro-F1（当存在 `expected_intent` 标签）
- 前端稳定性指标（`flicker_index`、`mental_map_score`）
- 门槛检查结果（pass/fail）

## 训练前统一评测体系

在开始微调前，先统一评估数据与实时能力：

```bash
python3 tools/unified_pretrain_eval.py \
  --dataset-dir versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/compliant_v3_repaired_20260228 \
  --realtime-report /tmp/realtime_eval_report.json \
  --output /tmp/unified_pretrain_eval.json
```

该报告会给出：

- 数据就绪度（schema/编译/许可证/对话轮次/类型覆盖）
- 实时评测融合结果（若提供 realtime report）
- 综合 `overall_pretrain_readiness_score`
- 是否建议进入微调阶段

## 现代前端工作台（Microsoft White 主题）

已新增一个可直接对接当前后端算法的现代前端：

- 前端目录: `frontend/realtime_ui/`
- 启动服务: `tools/realtime_frontend_server.py`

### 快速启动

```bash
python3 tools/realtime_frontend_server.py --host 127.0.0.1 --port 8088
```

打开：

- `http://127.0.0.1:8088`

### 已对接能力

1. 端到端闭环：
- `ASR transcript -> intent engine -> incremental renderer`
  - 新增会话流式模式：浏览器麦克风转写可逐条推送到后端

2. 实时评测：
- 在前端直接触发 `/api/pipeline/evaluate`
- 返回延迟、意图准确率、稳定性指标
  - 支持活跃会话快照评测（不中断会话）

3. 防闪烁指标可视化：
- `flicker_index`
- `mental_map_score`
- displacement / drift 指标

4. 训练前统一评测：
- 前端可直接调用 `/api/pretrain/unified`
- 输出 `overall_pretrain_readiness_score`

5. 实验报告落盘：
- 前端支持一键保存当前实验状态到仓库：
  - `reports/experiment_reports/EXPERIMENT_REPORT_*.json`
  - `reports/experiment_reports/EXPERIMENT_REPORT_*.md`
- 同时维护：
  - `reports/experiment_reports/EXPERIMENT_REPORT_LATEST.json`
  - `reports/experiment_reports/EXPERIMENT_REPORT_LATEST.md`

### API 端点

- `GET /api/health`
- `GET /api/config`
- `GET /api/session/list`
- `POST /api/session/create`
- `POST /api/session/chunk`
- `POST /api/session/flush`
- `POST /api/session/snapshot`
- `POST /api/session/close`
- `GET /api/report/list`
- `POST /api/report/save`
- `POST /api/pipeline/run`
- `POST /api/pipeline/evaluate`
- `POST /api/pretrain/unified`

### 实时语音模式（前端）

前端支持浏览器 Web Speech API（Chrome/Edge）：

1. 点击 `麦克风开始`
2. 语音将被实时转写并按会话流式推送到后端
3. 舞台区实时增量成图
4. 点击 `结束并评测` 生成会话级评测结果

说明：

- 该模式依赖浏览器语音识别能力，不依赖额外 Python ASR 包。
- 若浏览器不支持 Web Speech API，仍可使用 transcript 文本模式。
- 可在会话过程中点击 `会话快照` 获取当前评测结果；完成后点击 `保存实验报告` 固化本次实验。

### Transcript 输入格式（前端文本框）

每行支持：

- `text`
- `speaker|text`
- `speaker|text|expected_intent`

示例：

```text
expert|First define ingestion flow and source node.|sequential
expert|Then route events to parser and validation service.|sequential
expert|Gateway module connects auth service and data service.|structural
```

## 数据说明

- 本仓库是“按阶段归档”的工程仓库，不保证不同版本之间 schema 一致。
- 旧版本中的一些目录（例如 `v1` 的 `05_final`）主要是结构与索引保留，实际内容并不完整。
- 最新可用主线以 `v3_2026-02-27_latest_9k_cscw` 为准。

## 安全说明

- 原工程中的硬编码 GitHub Token 已全部替换为 `YOUR_GITHUB_TOKEN`。
- 若需运行采集脚本，请自行配置环境变量 `GITHUB_TOKEN`。

## 变更报告机制

- 已提供自动化脚本: `tools/generate_change_report.py`
- 已配置 Git hook: `.githooks/pre-commit`
- 本地已启用 `core.hooksPath=.githooks`，每次提交前会自动新增一份报告到:
  - `reports/change_reports/CHANGE_REPORT_*.md`
  - `reports/change_reports/CHANGE_REPORT_*.json`
- 新环境首次克隆后请执行:
  - `git config core.hooksPath .githooks`
