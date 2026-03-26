# Stream2Graph 正式平台使用指南

## 1. 这份文档给谁看

这份文档面向两类使用者：

- 管理员：负责登录平台、运行实时演示、发起样本比较、创建用户研究任务、导出报告
- 参与者：通过 `participant code` 进入任务页，编辑 Mermaid，提交答案并填写问卷

如果你需要的是部署、迁移和目录结构说明，请看：

- [FORMAL_PLATFORM_RUNBOOK_ZH.md](./FORMAL_PLATFORM_RUNBOOK_ZH.md)

## 2. 平台入口

正式平台的主要页面如下：

- `/`：公开首页
- `/login`：管理员登录页
- `/app/realtime`：实时成图工作台
- `/app/samples`：静态样本浏览与对比
- `/app/reports`：实验、研究和导出页
- `/study/[participantCode]`：参与者任务页

## 3. 首次使用前准备

### 3.1 启动依赖

在仓库根目录执行：

```bash
docker compose -f docker-compose.platform.yml up -d
pnpm install
python3 -m venv .venv-platform
./.venv-platform/bin/pip install --index-url https://pypi.org/simple --trusted-host pypi.org --trusted-host files.pythonhosted.org -e "apps/api[test]"
cp .env.example .env
source .venv-platform/bin/activate
pnpm api:migrate
```

### 3.2 启动服务

建议开 3 个终端：

终端 1：

```bash
source .venv-platform/bin/activate
pnpm api:dev
```

终端 2：

```bash
source .venv-platform/bin/activate
pnpm api:worker
```

终端 3：

```bash
pnpm dev:web
```

默认地址：

- 前端：`http://127.0.0.1:3000`
- API：`http://127.0.0.1:8000`
- OpenAPI：`http://127.0.0.1:8000/docs`

### 3.3 管理员账号

默认管理员账号来自根目录 `.env`：

- 用户名：`S2G_ADMIN_USERNAME`
- 密码：`S2G_ADMIN_PASSWORD`

如果没有改动 `.env.example`，默认是：

- 用户名：`admin`
- 密码：`admin123456`

## 4. 管理员使用流程

### 4.1 登录平台

1. 打开 `http://127.0.0.1:3000/login`
2. 输入管理员用户名和密码
3. 登录后进入正式平台工作区

说明：

- 管理员状态由服务端签名 cookie 保存
- `/app/*`、运行任务和报告导出都要求管理员登录

### 4.2 使用实时成图工作台

打开 `/app/realtime` 后，可以完成一整条实时演示流程。

建议使用顺序：

1. 设置会话标题和数据集版本
2. 选择输入来源
3. 点击“创建会话”
4. 使用对应输入方式写入文本
5. 查看增量图舞台、事件流、实时指标
6. 如需强制输出最终状态，点击“Flush”
7. 如需归档本次会话，点击“保存报告”
8. 完成后点击“关闭会话”

Transcript 支持三种格式：

- `text`
- `speaker|text`
- `speaker|text|expected_intent`

示例：

```text
expert|First define ingestion flow and source node.|sequential
expert|Then route events to parser and validation service.|sequential
expert|Gateway module connects auth service and data service.|structural
```

麦克风模式说明：

- 浏览器支持 Web Speech API 时，可点击“麦克风开始”
- 语音会被转成文本并按 chunk 写入当前 session
- 如果浏览器不支持，使用文本 Transcript 模式即可

输入来源说明：

- `Transcript 输入`
  - 最稳定，推荐作为主要演示路径
- `浏览器麦克风`
  - 依赖 Web Speech API，适合快速验证
- `系统声音（实验性）`
  - 只验证 Chrome/Edge 是否能拿到共享音频轨道
  - 当前不会直接把共享音频转成文本
- `系统声音（增强模式）`
  - 依赖本地 `audio helper`
  - 浏览器会共享标签页或屏幕音频，helper 在本机完成分段转写后回写会话
  - 使用前请先安装 helper 依赖并启动 `pnpm audio-helper:dev`

后续正式能力要求：

- 平台需要支持“麦克风输入”和“系统声音输入”两种音源
- `系统声音输入` 需要兼顾 macOS 与 Windows
- Windows 通常更容易支持系统回环音频
- macOS 通常更依赖浏览器共享标签页音频、屏幕采集音频或系统授权
- 因此系统声音能力不能简单等价为当前浏览器麦克风按钮
- 在正式实现完成前，Transcript 输入仍然是最稳定的演示方式

工作台里的几个关键区域：

- Transcript 输入区：用于批量发送示例输入
- 增量图舞台：展示 renderer 当前图状态
- 事件流：展示每一次 update 的意图类型和延迟
- 指标区：展示 `E2E P95`、`Intent Acc`、`Flicker`、`Mental Map`
- 状态区：展示实时评测快照和 pipeline 摘要

### 4.3 使用样本浏览与双模型对比

打开 `/app/samples` 后，可以对单个样本做静态对比。

建议使用顺序：

1. 选择数据集版本
2. 选择 split
3. 搜索并点击一个 sample
4. 在左右两栏分别填写 predictor 的 `provider`、`model` 和 `options`
5. 点击“运行双模型对比”
6. 等待状态从 `queued/running` 变成 `succeeded/failed`
7. 查看参考 Mermaid、双模型预测结果、compile 状态和离线指标

说明：

- 每次对比都会创建一个 `run_job`
- 前端通过 `SSE` 订阅运行状态
- 运行产物会写入 `var/artifacts/runs/<run_id>/`

### 4.4 创建用户研究任务并发放 participant code

打开 `/app/reports` 后，在“用户研究配置”页签中完成：

1. 填写任务标题和说明
2. 如有需要，选择数据集版本、split 和 sample
3. 填写三种系统条件输出：
   `manual`、`heuristic`、`model_system`
4. 点击“创建任务”
5. 在右侧选择刚创建的任务
6. 填写 participant id
7. 选择条件
8. 点击“创建 Participant Session”

创建完成后，页面会显示：

- `participant_code`
- 对应打开链接 `/study/<participant_code>`

### 4.5 导出实验和研究数据

在 `/app/reports` 的“导出”页签中，可以导出三类数据：

- `runs`
- `studies`
- `realtime`

每类都支持：

- `JSON`
- `CSV`
- `Markdown`

导出文件会保存到：

- `var/artifacts/reports/`

## 5. 参与者使用流程

参与者不需要管理员账号，只需要 `participant code`。

### 5.1 进入任务页

参与者打开：

```text
http://127.0.0.1:3000/study/<participantCode>
```

进入后系统会自动：

- 加载任务说明
- 加载输入材料
- 加载系统初稿
- 自动开始记录本次 session

### 5.2 完成任务

参与者在任务页中需要完成：

1. 阅读左侧材料区
2. 查看系统初稿
3. 在编辑区修改或重写最终 Mermaid
4. 观察实时预览
5. 完成问卷评分
6. 点击“提交最终答案”

系统会自动处理：

- 草稿自动保存
- 开始时间和活跃时间记录
- submit 事件记录
- 问卷保存
- compile 状态记录
- 若有参考图，则执行自动评分

### 5.3 提交后会发生什么

提交后，系统会保存：

- `final_output`
- `compile_success`
- `auto_metrics`
- `duration_seconds`
- `survey_response`
- `study_session` 报告

## 6. 状态与数据说明

### 6.1 任务运行状态

长任务统一使用以下状态：

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

### 6.2 数据持久化位置

平台中的权威状态在服务端：

- PostgreSQL：会话、任务、报告、导出索引
- `var/artifacts/`：运行产物、导出文件、报告文件

浏览器本地只保存少量轻状态：

- 最近打开的实时 session
- study 草稿缓存
- 一些筛选条件

### 6.3 关键 ID

排查问题时最重要的几个 ID：

- `session_id`：实时会话
- `run_id`：样本对比或 benchmark 运行
- `task_id`：研究任务
- `participant_code`：参与者入口码
- `report_id`：报告归档

## 7. 常见问题

### 7.1 登录后仍然提示未认证

可能原因：

- API 没启动
- 前端的 `NEXT_PUBLIC_API_BASE_URL` 指向错了
- 浏览器没收到管理员 cookie

建议检查：

- `http://127.0.0.1:8000/api/health`
- `http://127.0.0.1:8000/docs`
- 浏览器 DevTools 中 `/api/v1/auth/me` 的响应状态

### 7.2 样本对比一直停在 `queued`

通常是 worker 没启动。

检查：

```bash
source .venv-platform/bin/activate
pnpm api:worker
```

### 7.3 导出按钮可以点，但没有数据

可能原因：

- 当前数据库里还没有对应类型的记录
- 你还没有创建 run / study / realtime session

建议先完成一轮实际操作，再导出。

### 7.4 Mermaid 预览报错

可能原因：

- Mermaid 语法错误
- 节点/边定义不完整
- 条件分支写法不合法

建议先在编辑器里缩小到最小可运行版本，再逐步补全。

### 7.5 participant code 打不开

可能原因：

- code 输入错误
- 对应 session 未创建

管理员可在 `/app/reports` 中重新查看或重新发放 code。

## 8. 推荐演示顺序

如果你是第一次向别人演示这个平台，建议按下面顺序：

1. 打开首页，讲平台结构
2. 登录管理员工作台
3. 在 `/app/realtime` 做一次 transcript 实时演示
4. 在 `/app/samples` 做一次双模型样本比较
5. 在 `/app/reports` 创建一个研究任务并发放 participant code
6. 打开 `/study/<participantCode>` 模拟参与者完成任务
7. 回到 `/app/reports` 导出 JSON / CSV / Markdown

## 9. 维护者建议

如果你准备继续开发这套平台，建议优先关注：

- `apps/web/`：正式前端
- `apps/api/`：正式后端
- `packages/contracts/`：共享 DTO
- `packages/ui/`：统一设计系统
- `docs/project/FORMAL_PLATFORM_RUNBOOK_ZH.md`：运行手册

当前平台已经具备：

- 前端类型检查通过
- 前端 lint 通过
- 前端 production build 通过
- 后端 pytest 通过

如果要继续增强，优先级建议是：

1. 前端 E2E
2. 更多 API integration tests
3. benchmark suite 的真实运行配置页
4. 更完整的首页叙事和版本说明联动
