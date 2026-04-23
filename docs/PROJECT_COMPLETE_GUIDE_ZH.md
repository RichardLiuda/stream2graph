# Stream2Graph 完整项目文档

> 版本：2026-04-05
> 目标：为项目成员、评审者和潜在合作者提供一份覆盖架构、功能、创新性、实验结果和部署的全景文档。

---

## 目录

1. [项目概述](#1-项目概述)
2. [核心问题定义](#2-核心问题定义)
3. [系统架构](#3-系统架构)
4. [后端功能详解](#4-后端功能详解)
5. [前端功能详解](#5-前端功能详解)
6. [数据集构建](#6-数据集构建)
7. [核心算法](#7-核心算法)
8. [评测体系与实验结果](#8-评测体系与实验结果)
9. [创新性分析](#9-创新性分析)
10. [实用性与商业价值](#10-实用性与商业价值)
11. [快速部署指南](#11-快速部署指南)
12. [开发指南](#12-开发指南)

---

## 1 项目概述

### 1.1 一句话介绍

**Stream2Graph** 是一个能将多轮协作对话实时转换为结构化图表（Mermaid）的研究型交互系统。

### 1.2 项目定位

这不普通的"文本生成图表"工具。Stream2Graph 研究的核心问题是：

> 当多人通过对话逐步讨论一个系统架构或流程时，系统如何判断**何时**该更新图表、**更新什么内容**，并以**稳定可控**的方式把新语义外化到共享图结构中？

这涉及到三个层面的问题：
- **时机判断**：当前信息是否足以触发图更新？
- **内容规划**：新增的图结构应该是什么？
- **状态稳定**：如何在更新时不破坏用户已建立的心理地图？

### 1.3 目标会议

ICMI 2026（International Conference on Multimodal Interaction），定位为"交互式外部表征构建（Interactive External Representation Building）"任务。

### 1.4 技术栈总览

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12 + FastAPI + SQLAlchemy 2 + PostgreSQL 16 |
| 前端 | Next.js 15 + React 19 + TypeScript + TailwindCSS + XState |
| AI 层 | 多模型接入（OpenAI 兼容协议）：Claude, GPT, Gemini, Kimi, Qwen, MiniMax |
| 数据库 | PostgreSQL 16 + Alembic 迁移 |
| 部署 | Docker Compose（PostgreSQL）+ 原生进程管理 |
| 语音 | 讯飞 RTASR（流式 ASR）+ 讯飞声纹识别 |
| 图表渲染 | Mermaid 11.5.0 |

---

## 2 核心问题定义

### 2.1 形式化定义

给定一条多轮对话样本，系统按时间顺序逐轮观察对话内容，并在任意轮次决定是否需要触发图更新：

- **WAIT**：当前信息不足，暂不更新
- **EMIT_UPDATE**：信息充分，将当前图推进到下一阶段
- **SWITCH_CANVAS**：对话已转向新主题，切换新画布

形式化地，设对话轮次序列为 `T = {t_1, t_2, ..., t_n}`，阶段集合为 `S = {s_1, s_2, ..., s_m}`。系统在第 `k` 轮看到前缀 `T_<=k` 时，需要基于当前图状态 `G_k` 决定是否更新。

### 2.2 与传统 Text-to-Diagram 的区别

| 维度 | 传统方法 | Stream2Graph |
|---|---|---|
| 输入 | 完整文本一次性输入 | 多轮对话流式到达 |
| 输出 | 一次性最终图 | 逐步增量更新 |
| 状态管理 | 无（每轮独立生成） | 维护持续演化图状态 |
| 更新时机 | 不适用 | 核心决策之一 |
| 稳定性 | 不适用 | 关键指标（flicker, mental map） |
| 评估 | 最终结构匹配 | 过程指标 + 最终指标 |

---

## 3 系统架构

### 3.1 整体架构

```
  +------------------+     +------------------+     +------------------+
  |   浏览器前端       |     |   API 后端        |     |   外部 LLM API    |
  |   (Next.js 15)   |<--->|   (FastAPI)      |<--->|   (OpenAI兼容)    |
  +------------------+     +------------------+     +------------------+
         |                          |                        |
         |                          v                        |
         |               +------------------+                |
         |               |   PostgreSQL 16  |                |
         |               |   (Docker)       |                |
         |               +------------------+                |
         |                                                   |
  +------------------+     +------------------+     +------------------+
  |   讯飞 RTASR     |     |   mmdc 编译检查   |     |   讯飞声纹 API    |
  |   (WebSocket)    |     |   (CLI)           |     |   (REST)         |
  +------------------+     +------------------+     +------------------+
```

### 3.2 目录结构

```
stream2graph/
  apps/
    api/                    # FastAPI 后端
      app/
        main.py             # 应用入口、CORS、路由挂载
        config.py           # Pydantic 配置（环境变量解析）
        models.py           # SQLAlchemy ORM 模型（16 张表）
        schemas.py          # Pydantic 请求/响应模型
        db.py               # 数据库引擎和会话
        security.py         # 密码哈希、会话编码
        worker.py           # 独立后台 Worker（轮询任务队列）
        routers/            # API 路由
          auth.py           # 管理员认证
          catalog.py        # 数据集/样本/运行时配置
          realtime.py       # 实时会话核心接口
          voiceprints.py    # 声纹管理
          runs.py           # 批量评测任务
          studies.py        # 用户研究
          reports.py        # 实验报告
        services/           # 业务逻辑
          realtime_ai.py            # LLM 图表生成 + 语音转文字
          realtime_coordination.py  # 核心编排引擎 (~119KB)
          runtime_options.py        # Gate/Planner/STT 配置管理
          runtime_sessions.py       # 会话生命周期管理
          realtime_transcript.py    # 转录文本处理
          voiceprints.py    # 讯飞声纹集成
          xfyun_asr.py      # 讯飞流式 ASR
    web/                    # Next.js 前端
      app/                  # 页面路由
        page.tsx            # 首页
        login/page.tsx      # 登录页
        app/realtime/page.tsx       # 实时工作台
        app/samples/page.tsx        # 样本对比
        app/reports/page.tsx        # 报告管理
        app/settings/page.tsx       # 平台设置
        study/[code]/page.tsx       # 用户研究工作台
      components/           # UI 组件
        realtime-studio.tsx # 实时工作台主组件 (~188KB)
        mermaid-card.tsx    # Mermaid 渲染 + 拖拽重排
        platform-settings.tsx # 设置面板 (~66KB)
    audio-helper/           # 系统音频采集服务
  tools/
    eval/                   # 评测框架
    mermaid_prompting.py    # Mermaid 提示词构建
    incremental_dataset/    # 数据集渲染与管理
  versions/                 # 数据集版本
    v3_2026-02-27_latest_9k_cscw/   # 当前主数据集
  docs/                     # 项目文档
  reports/                  # 实验报告输出
```

### 3.3 数据库模型（16 张表）

| 表名 | 用途 |
|---|---|
| `admin_users` | 管理员认证 |
| `platform_settings` | 平台配置（JSON KV 存储，Gate/Planner/STT 配置） |
| `dataset_versions` | 数据集版本注册 |
| `run_jobs` | 后台任务队列（样本对比、批量评测） |
| `run_artifacts` | 任务输出产物 |
| `realtime_sessions` | 实时会话（含 pipeline 状态和评估结果） |
| `realtime_chunks` | 会话内的转录片段 |
| `realtime_events` | Pipeline 更新事件 |
| `realtime_snapshots` | 会话历史快照 |
| `voiceprint_groups` | 声纹分组 |
| `voiceprint_features` | 个人声纹特征 |
| `study_tasks` | 研究任务定义 |
| `study_sessions` | 参与者研究会话 |
| `study_events` | 研究事件日志 |
| `study_submissions` | 最终提交 |
| `survey_responses` | 问卷回答 |

---

## 4 后端功能详解

### 4.1 API 路由总览

所有接口前缀：`/api/v1`

#### 认证模块 `/auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 管理员登录（Cookie 会话） |
| POST | `/auth/logout` | 退出登录 |
| GET | `/auth/me` | 获取当前管理员身份 |

#### 数据目录 `/catalog`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/catalog/runtime-options` | 获取 Gate/Planner/STT 配置 |
| PUT | `/catalog/runtime-options/admin` | 保存运行时配置 |
| POST | `/catalog/runtime-options/admin/probe-models` | 探测可用模型 |
| POST | `/catalog/runtime-options/admin/test-connection` | 测试连接 |
| GET | `/catalog/datasets` | 列出数据集版本 |
| GET | `/catalog/datasets/{slug}/samples` | 分页获取样本 |
| GET | `/catalog/datasets/{slug}/samples/{sample_id}` | 样本详情 |

#### 实时会话 `/realtime`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/realtime/sessions` | 列出会话 |
| POST | `/realtime/sessions` | 创建会话 |
| POST | `/realtime/sessions/{id}/chunks` | 添加转录片段 |
| POST | `/realtime/sessions/{id}/chunks/batch` | 批量添加片段 |
| POST | `/realtime/sessions/{id}/audio/transcriptions` | 音频转录 |
| POST | `/realtime/sessions/{id}/snapshot` | 强制快照 |
| POST | `/realtime/sessions/{id}/flush` | 刷新缓冲并处理 |
| POST | `/realtime/sessions/{id}/diagram-relayout` | 节点拖拽重排 |
| POST | `/realtime/sessions/{id}/close` | 关闭会话 |
| GET | `/realtime/sessions/{id}/transcript/download` | 下载转录文本 |
| POST | `/realtime/sessions/detect-diagram-type` | 自动检测图表类型 |

#### 声纹管理 `/voiceprints`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/voiceprints/stt-profiles/{id}/features` | 列出声纹特征 |
| POST | `/voiceprints/stt-profiles/{id}/features` | 注册声纹 |
| DELETE | `/voiceprints/stt-profiles/{id}/features/{id}` | 删除声纹 |
| POST | `/voiceprints/stt-profiles/{id}/group/sync` | 同步远程分组 |

#### 任务运行 `/runs`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runs` | 列出任务 |
| POST | `/runs/sample-compare` | 创建样本对比任务 |
| POST | `/runs/benchmark-suite` | 创建批量评测任务 |
| GET | `/runs/{id}` | 任务状态 |
| GET | `/runs/stream/events` | SSE 事件流 |

#### 用户研究 `/studies`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/studies/tasks` | 列出研究任务 |
| POST | `/studies/tasks/{id}/sessions` | 创建研究会话 |
| GET | `/studies/participant/{code}` | 获取参与者会话 |
| POST | `/studies/participant/{code}/events` | 记录事件 |
| POST | `/studies/participant/{code}/autosave` | 自动保存 |
| POST | `/studies/participant/{code}/submit` | 最终提交 |
| POST | `/studies/participant/{code}/survey` | 保存问卷 |

#### 报告 `/reports`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/reports` | 列出报告 |
| GET | `/reports/{id}` | 报告详情 |
| GET | `/reports/exports/download` | 导出数据 |

#### 健康检查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务健康状态 |

### 4.2 核心引擎：CoordinationRuntimeSession

这是整个系统的大脑，约 119KB 代码，实现了：

#### Gate-Planner 双层架构

```
对话片段 ──→ [Gate 小模型] ──→ WAIT / EMIT_UPDATE / SWITCH_CANVAS
                    │
              如果是 EMIT_UPDATE
                    ↓
           [Planner 大模型] ──→ delta_ops + target_graph_ir
                    │
                    ↓
        [IncrementalGraphRenderer] ──→ 更新图状态 + 稳定性指标
                    │
                    ↓
          [render_preview_mermaid] ──→ Mermaid 代码
```

**Gate（门控模型）**：
- 使用轻量模型（如 Qwen3.5-4B）
- 决定"是否该更新"
- 三个动作：WAIT、EMIT_UPDATE、SWITCH_CANVAS
- 避免每个词都调用大模型，节省成本和延迟

**Planner（规划模型）**：
- 使用大模型（如 Qwen3.5-27B）
- 决定"更新什么内容"
- 返回增量操作：add_node、add_edge、add_group
- 可选返回完整的 GraphIR 和目标图结构

**确定性算法层**：
- 应用 delta_ops 到当前图状态
- 计算稳定性指标（flicker_index、mental_map_score）
- 将 GraphIR 渲染为 Mermaid 代码

### 4.3 Mermaid 生成与自动修复

#### 生成流程

1. 构建提示词（含对话文本、会话标题、图表类型）
2. 以 `temperature=0` 调用 LLM
3. 提取 Mermaid 候选（去除代码围栏、思考痕迹）
4. 规范化处理（修复裸 `--` 边、拆分链式语句、修复自环）
5. **编译检查**（通过配置的 `mmdc` 命令）
6. 如果编译失败：发送错误信息给 LLM 进行修复
7. 修复成功则用修复版本；失败则保留上一次成功状态

#### 修复机制详解

```
生成 Mermaid ──→ mmdc 编译检查
                     │
                成功? ──→ 发送给前端
                     │
                    失败
                     │
                     ↓
            构建修复 Prompt：
            - 编译器错误信息
            - 有问题的代码
            - 原始对话上下文
                     │
                     ↓
            LLM 修复 ──→ 再次编译检查
                     │
                成功? ──→ 用修复版
                     │
                    失败
                     │
                     ↓
              保留上次成功图 + 提示错误
```

### 4.4 语音处理链路

系统支持三种音频输入模式：

1. **浏览器麦克风**：Web Speech API（Chrome/Edge）
2. **系统音频**：audio-helper 服务（端口 8765）+ faster_whisper
3. **讯飞 RTASR**：WebSocket 流式 ASR + 角色分离

#### 声纹识别

集成讯飞 ISV API：
- 创建声纹分组（按 STT 配置）
- 注册个人声纹特征（PCM → 特征向量）
- 盲识别（searchFea 返回 Top-K 匹配）
- 说话人解析：匹配度 ≥ 阈值（默认 0.75）则识别为已知说话人

### 4.5 多模型支持

后端通过 OpenAI 兼容协议接入多种模型，通过 `PlatformSetting` 中的 JSON 配置管理：

| 模型 | 接口类型 | 用途 |
|---|---|---|
| Claude Sonnet 4.5 | 第三方兼容网关 | Gate / Planner / 质量上界 |
| Kimi 2.5 (Moonshot) | 官方接口 | Gate / Planner |
| Gemini 3 Flash | Google 官方接口 | Gate / Planner |
| Qwen 3.5 系列 | DashScope 兼容 | Gate / Planner（微调版） |
| MiniMax 2.5 | MiniMax 兼容 | Gate / Planner |

---

## 5 前端功能详解

### 5.1 页面列表

| 路由 | 组件 | 说明 |
|---|---|---|
| `/` | home-page.tsx | 公开首页，项目展示 |
| `/login` | login-form.tsx | 管理员登录 |
| `/app/realtime` | realtime-studio.tsx | **核心页面**：实时对话成图工作台 |
| `/app/samples` | sample-compare-workbench.tsx | 数据集样本浏览与双模型对比 |
| `/app/reports` | reports-dashboard.tsx | 实验报告管理 |
| `/app/settings` | platform-settings.tsx | 平台设置（运行时配置、声纹管理） |
| `/study/[code]` | study-workbench.tsx | 参与者研究工作台 |

### 5.2 实时工作台（realtime-studio.tsx）

这是最大的组件（~188KB），提供：

- **多种输入模式**：
  - 浏览器麦克风（Web Speech API）
  - 手动文本输入
  - 系统音频采集（audio-helper）
  - 预设 Demo 数据

- **多画布支持**：对话转向时自动切换新画布，可在画布间浏览

- **Mermaid 渲染**：
  - 使用 mermaid@11.5.0
  - 支持 flowchart、sequence、state、class、ER、requirement 六种图
  - 自动错误修复与旧图保留
  - SVG 原生标签（避免 foreignObject 模糊）

- **节点拖拽重排**：
  - 拖拽节点后触发 Planner 重新组织图结构
  - 推断用户意图并更新图

- **Pan/Zoom 画布**：
  - 支持缩放 0.55x ~ 2.6x
  - 网格背景
  - 系统提示叠加层

- **状态管理**：使用 XState 状态机（realtime-machine.ts）

### 5.3 样本对比工作台

- 分页浏览数据集样本
- 选择两个模型对同一样本进行生成对比
- 查看结构指标（node_f1、edge_f1、line_f1 等）
- 查看 Mermaid 代码差异

### 5.4 平台设置

- **Gate 配置**：选择模型、调整提示词
- **Planner 配置**：选择模型、调整提示词
- **STT 配置**：语音识别提供商、模型、声纹设置
- **连接测试**：测试模型连接和可用模型探测
- **声纹管理**：注册/删除个人声纹特征

---

## 6 数据集构建

### 6.1 构建流程

数据集不是直接采集真实会议对话，而是通过"逆向工程 + 重生成"的方式构建：

```
收集 Mermaid 图（多种类型）
        ↓
规则引擎反向生成对话（Expert/Editor 风格）
        ↓
许可证清洗 + 编译验证
        ↓
大模型高质量重生成（Kimi K2.5）
        ↓
最终筛选：编译成功 + 有效许可证 + 4-120 轮对话
```

### 6.2 数据集版本

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-02-05 | 早期 8k 五阶段流水线 |
| v2 | 2026-02-08 | 许可证修复 + 高质量筛选 |
| v3 | 2026-02-27 | 9k CSCW 对话 + 实时成图算法 |

### 6.3 当前数据集

- **版本**：`release_v7_kimi_k25_fullregen_strict_20260313`
- **样本数**：4709
- **图类型**：flowchart、sequence、state、class、ER、requirement
- **划分**：train / validation / test
- **特征**：严格阶段边界、单调图演化、均衡类型分布

### 6.4 GraphIR 中间表示

使用 `GraphIR` 数据结构作为图表的中间表示：
- `nodes`：节点列表（id, label, parent）
- `edges`：边列表（source, target, label）
- `groups`：分组列表（id, label, parent）
- `styles`：样式指令（classDef, class, style, linkStyle）
- `metadata`：元数据（diagram_type, stage）

---

## 7 核心算法

### 7.1 增量渲染与稳定性控制

`IncrementalGraphRenderer` 跟踪以下指标：

| 指标 | 含义 |
|---|---|
| `flicker_index` | 相邻帧之间的变化程度 |
| `mental_map_score` | 用户能否保持对图的心理地图 |
| `mean_displacement` | 节点平均移动距离 |
| `p95_displacement` | 95 分位节点移动距离 |
| `unchanged_max_drift` | 未变更节点的最大漂移 |

### 7.2 多画布自动切换

当 Gate 判断对话已转向新主题时，返回 `SWITCH_CANVAS`：
- 创建新画布并初始化
- 保留旧画布供后续浏览
- 避免在已有图上无限叠加导致混乱

### 7.3 语言检测

`detect_dominant_dialogue_language()` 分析 CJK 与拉丁字符比例：
- 中文为主 → 要求节点标签使用中文
- 英文为主 → 要求节点标签使用英文
- 混合 → 保持原文语言

---

## 8 评测体系与实验结果

### 8.1 评测指标

#### 结构质量指标

| 指标 | 含义 |
|---|---|
| `normalized_exact_match` | 规范化后精确匹配 |
| `normalized_similarity` | 序列相似度 |
| `diagram_type_match` | 图表类型匹配 |
| `line_precision/recall/f1` | 行级多集合 PRF |
| `token_precision/recall/f1` | 标识符级 PRF |
| `node_precision/recall/f1` | 节点级 PRF |
| `edge_precision/recall/f1` | 边级 PRF |
| `label_precision/recall/f1` | 标签级 PRF |
| `compile_success` | Mermaid 编译成功率 |

#### 实时性能指标

| 指标 | 含义 |
|---|---|
| P50/P95 延迟 | 端到端延迟 |
| `flicker_index` | 闪烁指数 |
| `mental_map_score` | 心理地图保持率 |

### 8.2 通用模型 Baseline 结果

测试集：963 样本（test split）

| 模型 | 首轮失败 | 最终失败 | 平均延迟(ms) | 归一化相似度 | 行级 F1 | 边 F1 | 编译率 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Claude Sonnet 4.5** | 59 | 0 | 20,635 | **0.5013** | **0.4045** | **0.6666** | **0.3520** |
| Kimi 2.5 | 39 | 0 | 87,830 | 0.4953 | 0.3759 | 0.6597 | 0.3001 |
| **Gemini 3 Flash** | 0 | 0 | 26,323 | 0.4859 | 0.3676 | 0.6384 | 0.3323 |
| Qwen 3.5 Thinking Off | 0 | 0 | **6,681** | 0.4685 | 0.3742 | 0.6399 | 0.3032 |
| Qwen 3.5 Thinking On | 39 | 0 | 86,230 | 0.4464 | 0.3479 | 0.6267 | 0.2835 |
| MiniMax 2.5 | 3 | 0 | 22,253 | 0.3922 | 0.2828 | 0.5204 | 0.2690 |

**关键发现**：
- Claude Sonnet 4.5 是最终质量最强的模型
- Qwen 3.5 Thinking Off 速度最快、最稳定
- Gemini 3 Flash 综合最平衡（0 首轮失败 + 高质量）
- Qwen 3.5 Thinking On 反而不如 Off（思考模式在此任务上无收益）

### 8.3 2×2 消融实验

在 `public-clean` 验证集（312 样本）上：

| 配置 | 严格匹配 | 规范化匹配 | 语义 F1 |
|---|---:|---:|---:|
| Gate FT + Planner FT | **0.0865** | **0.0962** | **0.4567** |
| Gate Base + Planner FT | 0.0737 | 0.0865 | 0.4329 |
| Gate FT + Planner Base | 0.0321 | 0.0545 | 0.3622 |
| Gate Base + Planner Base | 0.0224 | 0.0513 | 0.3325 |

**核心发现**：
- Planner 微调是主要质量来源（+5.29pp 严格匹配）
- Gate 微调主要提升阶段控制稳定性和延迟
- 双微调 > 单微调 > 双基座，呈现清晰的互补性

### 8.4 最终组合结果（Test 集，公开干净）

采用 Qwen3.5-4B Gate FT + Qwen3.5-27B Planner FT：

- **严格最终匹配**：10.86%
- **规范化匹配**：11.18%
- **实体语义 F1**：0.4584
- 显著超过多种通用大模型基线

---

## 9 创新性分析

### 9.1 任务定义创新

将"协作对话 → 图构建"明确定义为**交互式外部表征构建**任务，区别于传统的一次性 text-to-diagram 任务。

### 9.2 架构创新

**Gate-Planner 双层异构分工**：
- 将"何时更新"和"更新什么"两个子问题解耦
- 小模型负责时机判断（效率）
- 大模型负责内容规划（质量）
- 确定性算法层负责状态一致性

### 9.3 数据集创新

从规则引擎冷启动 → 大模型高质量重生成，构建了一个具有严格阶段边界、单调图演化的研究型数据集。

### 9.4 评测创新

同时评估最终结构质量和过程稳定性，而非仅比较最终输出。

### 9.5 系统创新

完整的交互式平台支持：
- 实时对话成图
- 节点拖拽重排
- 多画布浏览
- 声纹说话人识别
- 用户研究工作台

---

## 10 实用性与商业价值

### 10.1 应用场景

1. **会议实时记录**：会议讨论时自动生成架构图/流程图
2. **教学辅助**：课堂讨论中逐步构建知识图谱
3. **需求分析**：产品讨论中实时产出系统架构图
4. **头脑风暴**：创意讨论中快速可视化概念关系
5. **技术文档**：技术讨论中同步产出 Mermaid 文档素材

### 10.2 商业优势

- **降低沟通成本**：讨论中实时产出可视化图表
- **减少信息丢失**：口头讨论不再依赖事后回忆整理
- **提升协作效率**：共享图状态作为讨论的"外部工作记忆"
- **可集成性**：Mermaid 格式可直接用于 Markdown、Notion、Confluence

### 10.3 技术壁垒

- Gate-Planner 双层架构设计
- 增量渲染稳定性控制
- 多模型评测框架
- 声纹说话人识别集成
- 大规模高质量数据集

---

## 11 快速部署指南

### 11.1 前置条件

- Node.js 20+
- Python 3.12
- pnpm
- Docker Desktop（用于 PostgreSQL）
- 系统已安装 `mmdc`（Mermaid CLI）

### 11.2 一键启动

```powershell
# 进入项目目录
cd E:\Desktop\stream2graph

# 启动所有服务（PostgreSQL + API + 前端 + Worker）
pnpm dev:up:win
```

### 11.3 常用命令

```powershell
# 停止所有服务
pnpm dev:down:win

# 查看服务状态
pnpm dev:status:win

# 重启所有服务
pnpm dev:restart:win
```

### 11.4 访问地址

| 服务 | 地址 |
|---|---|
| 前端 | http://127.0.0.1:3000 |
| API | http://127.0.0.1:8000 |
| API 文档 | http://127.0.0.1:8000/docs |
| 健康检查 | http://127.0.0.1:8000/api/health |

### 11.5 管理员账号

- 用户名：`admin`
- 密码：`admin123456`

### 11.6 环境变量

`.env` 文件中的关键配置：

```bash
# 数据库
DATABASE_URL=postgresql+psycopg://stream2graph:stream2graph@127.0.0.1:5432/stream2graph

# 管理员
S2G_ADMIN_USERNAME=admin
S2G_ADMIN_PASSWORD=admin123456

# Mermaid 编译检查（必须配置）
S2G_MERMAID_COMPILE_COMMAND=mmdc -i {input} -o {output}

# LLM 配置（JSON 数组）
S2G_GATE_PROFILES_JSON=[{"id":"qwen-gate","label":"Qwen Gate","endpoint":"...","models":["qwen3.5-4b"],...}]
S2G_PLANNER_PROFILES_JSON=[{"id":"qwen-planner","label":"Qwen Planner","endpoint":"...","models":["qwen3.5-27b"],...}]
```

---

## 12 开发指南

### 12.1 后端开发

```bash
# 单独启动 API（热重载）
pnpm api:dev

# 运行后端测试
pnpm api:test

# 运行数据库迁移
pnpm api:migrate
```

### 12.2 前端开发

```bash
# 单独启动前端
pnpm dev:web

# 构建生产版本
pnpm build:web
```

### 12.3 目录约定

- 后端代码在 `apps/api/app/`
- 前端代码在 `apps/web/`
- 共享组件在 `packages/`
- 工具脚本在 `tools/`
- 运行时产物在 `var/`

### 12.4 Git 协作

- 主分支：`master`
- 提交前请运行 `pnpm api:test` 和 `pnpm lint:web`
- 数据库迁移文件需提交到 `apps/api/alembic/versions/`
- 不要提交 `.env` 文件中的敏感信息

---

*本文档由项目成员维护，如有更新请同步到 `docs/` 目录。*
