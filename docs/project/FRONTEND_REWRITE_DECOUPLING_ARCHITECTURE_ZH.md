# Stream2Graph 前端重写与前后端解耦架构说明

## 1. 背景

当前仓库里已经形成了一套正式平台：

- 前端：`apps/web`
- 后端：`apps/api`
- 共享类型：`packages/contracts`
- UI 组件：`packages/ui`

团队现在的目标不是重写整个平台，而是：

- 保留现有后端逻辑、数据模型、实时服务能力
- 重写前端展示与交互层
- 在重写过程中降低前后端、页面与业务逻辑之间的耦合
- 为后续多前端形态预留空间，例如：
  - 新版 Web 前端
  - 面向研究的工作台
  - 更轻量的用户端界面

这意味着重构重点不在后端算法，而在：

- 协议层稳定化
- 前端应用层抽离
- 页面组件瘦身
- 旧前端实现与新前端实现解耦

---

## 1.1 我们已经讨论过的结论与踩坑

这一节专门总结目前已经真实发生过的问题，不是纯理论推演。

| 坑点 | 已经出现的表现 | 根因判断 | 对重写的要求 |
| --- | --- | --- | --- |
| 首页过于“研究工作台化” | 首页同时暴露 `Flush`、`快照`、`保存报告`、`关闭会话` 等能力 | 主流程与研究/调试能力没有分层 | 用户主流程与高级能力必须拆层 |
| `RealtimeStudio` 过大 | 一个组件覆盖会话、音频、STT、LLM、Mermaid、图、指标 | 页面承担了应用层职责 | 先拆应用层，再重写展示层 |
| Mermaid 渲染错误频发 | `Lexical error`、连接符不合法、多语句串在一行 | 模型输出、编译校验、前端渲染未统一治理 | Mermaid 必须当完整链路治理 |
| 默认图视图负担太高 | 纯网络图会“能看但难懂” | 信息架构没有围绕讨论理解设计 | 必须保留对话脊柱 + 稳定主图 + insight rail |
| 视觉复杂度高 | 按钮多、术语多、指标多 | 信息层级不清，不只是样式问题 | 页面按任务优先级组织信息 |
| 两套前端并存 | 讨论容易分叉，想法难统一落地 | 正式平台和静态原型同时演化 | 必须明确唯一正式前端入口 |
| contract 过宽 | `record(any)` / `dict[str, Any]` 太多 | 协议不是稳定的 view model | 先收紧 DTO，再重写页面 |

### 坑 1：首页和主界面一度过于“研究工作台化”

我们已经讨论并实际调整过首页操作区，暴露出的核心问题是：

- 主操作和次操作混在同一层
- `Flush`、`快照`、`保存报告` 这类系统/实验术语直接暴露给用户
- `关闭会话` 这类危险操作与主流程按钮抢视觉注意力

这说明：

- 前端重写不能只做视觉翻新
- 必须从信息架构上区分 `用户主流程` 和 `研究/调试能力`

### 坑 2：`RealtimeStudio` 已经成为“超大组件”

我们已经直接看到：

- 会话创建与恢复
- transcript 输入
- 音频采集
- STT 上传
- Mermaid 更新
- graph 展示
- timeline
- 指标
- notice / error

都堆在 [apps/web/components/realtime-studio.tsx](../../apps/web/components/realtime-studio.tsx) 里。

这导致：

- 任何用户向简化都会碰到底层流程代码
- 很难局部重写
- 很难将同一套业务能力复用到新的 UI

### 坑 3：Mermaid 渲染错误不是单点 bug，而是一整条链路的问题

我们已经遇到过 Mermaid 相关问题，包括：

- 一行里串了多条 Mermaid 语句
- 连接符不合法
- 生成模型输出与前端运行时版本不对齐

这次排查已经说明：

1. 不能只靠前端渲染时报错兜底
2. 不能只靠后处理 normalize 硬修
3. 必须从 prompt / rule 层就锁定 Mermaid 版本和语法子集

这也是为什么现在 Mermaid 相关能力必须被看成一条完整链路：

- 生成规则
- 编译校验
- 修复重试
- 前端渲染适配

### 坑 4：默认视图如果只是“自由网络图”，会让讨论越来越难读

我们已经讨论过，这个项目最关键的不是“图会长”，而是用户要持续看懂：

- 谁说了什么
- 这句话让图哪里变了
- 当前分歧和共识是什么

所以默认视图不能只是：

- force-directed network

而应该是：

- 对话脊柱
- 稳定主图
- insight rail

这意味着前端重写不只是组件拆分，还要保住我们已经达成的展示原则。

### 坑 5：视觉复杂度的根源其实是结构复杂度

我们已经多次收敛首页和工作台，得到的经验是：

- 问题不只是按钮多
- 更核心的是信息层级不清晰
- 技术信息、研究信息、用户任务混在一起

这说明新前端必须让：

- 默认界面只服务当前任务
- 高级能力进入菜单、抽屉、次级模式

### 坑 6：仓库里两套前端并存，容易让讨论和实现分叉

当前仓库里同时存在：

- 正式平台：`apps/web`
- 早期静态原型：`frontend/realtime_ui`

这已经造成过实际困扰：

- 设计讨论容易不知道是针对哪一套
- 某些想法在原型里有，在正式平台里没有
- 重写时容易把旧的实验型交互重新带回来

### 坑 7：看起来有 contract，但关键对象仍然太宽

目前我们已经有：

- 后端 schema：[apps/api/app/schemas.py](../../apps/api/app/schemas.py)
- 前端 contract：[packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

但大量关键对象仍然是：

- `record(any)`
- `dict[str, Any]`

这在重写阶段会直接变成坑：

- 新前端不知道哪些字段可依赖
- 页面只能“读经验”，不能“读协议”
- 后端调整字段时风险较高

---

## 1.2 一页式结论

| 维度 | 当前状态 | 可以保留 | 必须重做 |
| --- | --- | --- | --- |
| 后端服务 | FastAPI 平台化、模块边界基本成型 | `auth/catalog/realtime/runs/studies/reports` | 不建议重写业务服务 |
| 实时能力 | runtime session、Mermaid 生成、compile / repair 已具备 | 现有服务逻辑 | 不建议在前端重写阶段改核心链路 |
| UI primitive | `packages/ui` 已有基础组件 | 基础按钮、输入框、卡片等 | 页面层重新组织 |
| 页面结构 | 大组件驱动，流程与展示强耦合 | 局部组件可复用 | 页面和应用层必须分离 |
| 协议层 | 有 schema / contract，但关键对象太宽 | 名称与基本边界 | DTO 要收紧，且尽量单一来源 |
| 信息架构 | 已形成对话脊柱 + 主图 + insight rail 的方向 | 这套方向本身 | 不能退回到“单图大杂烩” |

---

## 2. 当前架构概览

### 2.1 后端层

当前后端是标准的 FastAPI 平台应用，入口和路由组织比较清晰：

- 应用入口：[apps/api/app/main.py](../../apps/api/app/main.py)
- 实时会话路由：[apps/api/app/routers/realtime.py](../../apps/api/app/routers/realtime.py)
- 运行会话服务：[apps/api/app/services/runtime_sessions.py](../../apps/api/app/services/runtime_sessions.py)
- Mermaid 生成服务：[apps/api/app/services/realtime_ai.py](../../apps/api/app/services/realtime_ai.py)
- 其他模块：
  - `catalog`
  - `runs`
  - `studies`
  - `reports`
  - `auth`

当前后端已经具备以下能力：

- 会话创建、chunk 写入、snapshot、flush、close
- 实时 transcript ingestion
- STT 调用
- Mermaid 生成、规范化、编译校验、自动修复
- 报告生成
- study 工作流
- 样本浏览与 benchmark run

结论：

- 后端已经不是“页面耦合脚本”，而是完整的平台 API
- 后端整体可以保留

### 2.2 前端层

当前正式前端位于 `apps/web`，技术栈为：

- Next.js
- React
- TanStack Query
- XState
- Mermaid
- 自定义 UI 组件包

当前主要问题不在技术选型，而在层次划分：

- 页面组件过大
- 页面直接承载业务流程控制
- API client 过于贴近当前页面写法
- 协议层不够强类型

其中最典型的例子是：

- [apps/web/components/realtime-studio.tsx](../../apps/web/components/realtime-studio.tsx)

这个组件同时承担了：

- 会话创建与恢复
- transcript 输入
- 音频采集与上传
- STT 状态同步
- LLM 状态同步
- Mermaid 展示
- 图视图切换
- 指标展示
- 用户通知与错误处理
- runtime preference 读写

这会使前端重写成本很高，因为业务逻辑、环境适配、界面层全混在一起。

这一点已经在我们之前做“用户向简化”时被反复验证过。

### 2.3 共享层

当前仓库已经有两层共享资产：

- 协议定义：[packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)
- 视觉组件：[packages/ui/src/index.ts](../../packages/ui/src/index.ts)

这是非常好的基础，但目前 `contracts` 还比较薄，很多关键数据仍然是：

- `z.record(z.any())`
- `dict[str, Any]`

这意味着“看起来有 contract”，但关键域模型还没有真正固定下来。

---

## 3. 当前主要耦合点

### 3.1 页面组件与应用逻辑耦合

问题：

- 页面 JSX 里直接处理状态机、副作用、音频、会话恢复、API 调用、异常处理

影响：

- 页面难拆
- 难测试
- 新前端难复用现有逻辑
- 任何用户向收敛都会牵扯到底层流程

### 3.2 前端与后端通过“宽松 payload”耦合

例如：

- `pipeline`
- `evaluation`
- `summary`

这些对象虽然能工作，但内部结构没有被严格收口，导致：

- 新前端必须理解旧 payload 的历史细节
- 后端修改字段时风险高
- 页面容易直接依赖内部实现
- Mermaid、graph、insight 等领域对象难以形成稳定边界

### 3.3 前端协议定义与后端 schema 不是单一来源

当前存在两份相似但独立的定义：

- 后端 Pydantic schema：[apps/api/app/schemas.py](../../apps/api/app/schemas.py)
- 前端 zod contract：[packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)

这会带来：

- 维护成本翻倍
- 类型漂移风险
- 新前端重写时仍然要人工对齐

### 3.4 前端 API client 与页面结构绑定过深

当前 API client 在：

- [apps/web/lib/api.ts](../../apps/web/lib/api.ts)

它已经具备基础功能，但还是“大平层”：

- 所有领域 API 都在一个文件里
- 返回值仍有大量宽类型
- 页面直接依赖 endpoint 粒度

### 3.5 仓库存在两套前端

除了正式平台 `apps/web`，仓库里还有：

- `frontend/realtime_ui`

这套静态原型仍然容易分散注意力，导致：

- 设计讨论不集中
- 功能可能重复演化
- 重写时边界不清

这不是理论风险，而是当前仓库结构已经带来的真实问题。

---

## 4. 解耦目标

重写前端时，建议把系统稳定在五层结构：

| 层级 | 目标职责 | 当前问题 | 重写后边界 |
| --- | --- | --- | --- |
| Domain / Service Layer | runtime session、Mermaid 生成、报告、study | 基本可用，不是主问题 | 后端内部实现可继续演进 |
| API Contract Layer | 稳定 DTO 与 API 响应 | payload 太宽、存在 `any` | 新前端只依赖 DTO，不依赖内部结构 |
| Frontend Data Access Layer | 按领域封装 API | 当前 `api.ts` 是大平层 | 拆成 `realtimeApi` 等模块 |
| Frontend Application Layer | 编排副作用、状态、采集、回放 | 逻辑目前混在页面里 | hooks / services / adapters 承担 |
| Presentation Layer | 纯展示与交互组合 | 页面组件过大 | 页面只负责布局与视图状态 |

### 4.1 Domain / Service Layer

保留现有 Python 服务逻辑：

- runtime session
- transcript ingestion
- Mermaid generation
- report generation
- study workflows

这一层不直接感知前端页面实现。

### 4.2 API Contract Layer

定义稳定的前后端 DTO。

重点不是把所有内部字段暴露出去，而是收敛成前端真正依赖的结构：

- `SessionSummary`
- `RealtimeSnapshot`
- `TranscriptUpdateResult`
- `MermaidState`
- `GraphState`
- `InsightState`
- `EvaluationState`
- `RunJob`
- `StudySession`

这一层应该成为“新前端唯一依赖的后端视图”。

### 4.3 Frontend Data Access Layer

将前端 API 调用从页面中抽出，按领域拆分：

- `authApi`
- `catalogApi`
- `realtimeApi`
- `runsApi`
- `studiesApi`
- `reportsApi`

页面和 feature 只依赖领域 API，不直接拼 endpoint。

### 4.4 Frontend Application Layer

将复杂流程抽为可复用的应用层逻辑：

- session orchestration
- replay / timeline control
- capture lifecycle
- audio helper bridge
- runtime preference persistence
- Mermaid render coordination

这一层可以是：

- hooks
- service objects
- state machine modules
- adapter modules

### 4.5 Presentation Layer

页面只负责展示和组合，不直接承担业务控制流。

例如 realtime 页应拆成：

- `SessionShell`
- `TranscriptPane`
- `TimelinePane`
- `GraphPane`
- `MermaidPane`
- `InsightPane`
- `ControlBar`

---

## 5. 推荐的目标目录结构

建议在 `apps/web` 内部重构为更明确的 feature 结构：

```text
apps/web/
  app/
    app/
      realtime/
      samples/
      reports/
      settings/
    study/
  features/
    realtime/
      api/
      model/
      hooks/
      components/
      adapters/
    studies/
      api/
      model/
      hooks/
      components/
    reports/
      api/
      model/
      components/
    samples/
      api/
      model/
      components/
  entities/
    session/
    diagram/
    mermaid/
    transcript/
    report/
  shared/
    api/
    contracts/
    config/
    hooks/
    lib/
    ui/
```

这里的原则是：

- `features` 放完整用户流程
- `entities` 放跨 feature 的核心业务对象
- `shared` 放基础设施

---

## 5.1 组件库策略

前端重写阶段增加一个明确约束：

- 页面组件优先复用 [React Bits](https://reactbits.dev/) 或其对应文档/代码资产
- 不要为常见的展示型组件、动效组件、版块组件重复手搓
- `packages/ui` 继续保留，但应收敛为“基础层”和“适配层”，而不是继续扩张成一整套自研展示组件库

这个约束的目的不是“完全依赖外部库”，而是减少以下成本：

- 为了重写 UI 又重新造一轮组件轮子
- 把大量时间花在通用展示组件而不是业务流程
- 团队后续维护过多自定义视觉组件

### 5.1.1 组件来源优先级

| 优先级 | 来源 | 适用范围 | 备注 |
| --- | --- | --- | --- |
| 1 | React Bits 现成组件/blocks/templates | 展示型、动效型、背景型、营销表达型组件 | 优先采用，减少手搓 |
| 2 | `packages/ui` 基础组件 | 按钮、输入框、表单控件、卡片、badge、section heading | 作为平台基础层 |
| 3 | 项目内 feature 组件 | 业务强相关、协议驱动、无法直接从外部复用的组件 | 仅在业务确实需要时新增 |
| 4 | 全新自研通用组件 | 通用展示组件 | 默认避免，除非前 3 层都不适合 |

### 5.1.2 适合优先从 React Bits 获取的组件类型

| 组件类别 | 示例用途 | 是否建议优先采用 React Bits |
| --- | --- | --- |
| Hero / 页面头图区块 | 项目首页、介绍页、study 入口 | 是 |
| Text animation | 标题强调、分段 reveal、状态文案动效 | 是 |
| 背景与氛围组件 | 渐变背景、orb、cursor、轻量 3D/视差 | 是 |
| 展示型卡片 / feature blocks | 功能介绍、how-it-works、结果说明 | 是 |
| 复杂 landing section | SaaS 风格页面、案例页、CTA 区块 | 是 |
| 业务强绑定工作台组件 | Transcript pane、Insight rail、Replay scrubber、Graph/Mermaid 工作区 | 否，应由项目自己实现 |
| 协议驱动组件 | `MermaidState`、`GraphState`、`InsightState` 的渲染器 | 否，应由项目自己实现 |

### 5.1.3 `packages/ui` 的收缩原则

| 保留在 `packages/ui` 的内容 | 不应继续放进 `packages/ui` 的内容 |
| --- | --- |
| Button, Input, Textarea, Card, Badge, StatCard 等基础 primitive | 大型 hero、动画展示组件、复杂 landing blocks |
| 样式 token、`cn()`、基础布局壳 | 业务页面级组件 |
| 少量跨前端共享的低层组件 | 仅为某一页面服务的特殊展示组件 |

### 5.1.4 React Bits 使用原则

| 原则 | 说明 |
| --- | --- |
| 先选合适现成块，再做业务适配 | 不先手写，再发现已有成熟实现 |
| 外部组件只负责视觉与动效，不直接承载业务状态 | 业务状态仍由 feature 层控制 |
| 将 React Bits 组件包在项目自己的适配层内 | 避免页面直接散落第三方实现细节 |
| 对高风险依赖做本地封装/复制，避免未来升级卡死 | 特别是动画与样式耦合较高的组件 |
| 平台工作台区域优先稳定、清晰、可追踪，不追求炫技 | React Bits 更适合首页、介绍页、辅助展示区，不是拿来替代核心业务 pane |

### 5.1.5 推荐的落地方式

| 场景 | 推荐方式 |
| --- | --- |
| 首页 / 营销型介绍页 | 直接优先选 React Bits blocks/templates |
| 平台壳层视觉增强 | 使用 React Bits 的背景、轻动效、标题动效 |
| 工作台外围说明区 | 可复用 React Bits 的 text/card/section 组件 |
| 核心工作区 | 只借鉴视觉表达，不直接照搬，核心仍由业务组件实现 |

---

## 6. 建议保留的后端边界

后端建议继续保留现有业务模块，不因前端重写而重写服务。

这背后的经验判断是：

- 当前主要问题不是后端服务能力缺失
- 而是前端页面层承担了过多不该承担的流程逻辑
- 同时协议层没有足够稳定

建议保留的模块边界：

- `auth`
- `catalog`
- `realtime`
- `runs`
- `studies`
- `reports`

这几层目前已经比较稳定，适合成为新前端的正式依赖面。

| 模块 | 当前职责 | 是否建议保留 | 重写期间要求 |
| --- | --- | --- | --- |
| `auth` | 登录、登出、管理员身份 | 保留 | 接口稳定，供平台壳鉴权 |
| `catalog` | 数据集、样本、runtime options | 保留 | 返回类型进一步收紧 |
| `realtime` | 会话、chunk、snapshot、flush、close、音频转写 | 保留 | 输出更清晰的 snapshot DTO |
| `runs` | benchmark/sample compare/job stream | 保留 | SSE 和 artifact 响应继续兼容 |
| `studies` | task、participant session、autosave、submit、survey | 保留 | session DTO 明确化 |
| `reports` | 报告列表、详情、导出 | 保留 | 报告摘要与详情层次明确 |

### 6.1 `realtime` 模块建议继续承担

- session create / restore / snapshot / flush / close
- chunk ingestion
- audio transcription
- Mermaid generation
- evaluation aggregation

### 6.2 `realtime` 模块不建议再承担

- 任何前端布局逻辑
- 任何具体的 UI 展示状态
- 页面级派生字段拼装

---

## 7. 协议层如何收口

这是前端重写时最关键的一步。

当前的问题不是 endpoint 不够，而是 payload 太宽。

这是我们已经踩过的坑：

- 接口“能用”不等于“适合重写”
- 只要 `pipeline` 还是一个大而散的对象，新前端就会继续绑定旧结构

### 7.1 建议的 realtime snapshot 结构

建议后端逐步收口为：

```json
{
  "session_id": "...",
  "pipeline": {
    "session": {},
    "transcript": {},
    "graph": {},
    "mermaid": {},
    "insights": {},
    "metrics": {}
  },
  "evaluation": {}
}
```

推荐拆分含义：

- `session`
  - title
  - status
  - current mode
- `transcript`
  - source chunks
  - speakers
  - selected focus
- `graph`
  - nodes
  - edges
  - layout metadata
  - provenance
- `mermaid`
  - code
  - normalized_code
  - compile_ok
  - error_message
  - mermaid_version
  - syntax_profile
- `insights`
  - contested_entities
  - consensus_entities
  - open_questions
  - next_prompts
- `metrics`
  - latency
  - flicker
  - mental map

### 7.1.1 建议的前端消费 DTO 表

| DTO | 关键字段 | 字段说明 | 新前端是否应直接消费 |
| --- | --- | --- | --- |
| `SessionSummary` | `session_id`, `title`, `status`, `created_at`, `updated_at` | 会话列表与顶部会话状态 | 是 |
| `TranscriptState` | `source_chunks`, `primary_speaker`, `speakers`, `focus_entities` | 左侧对话脊柱与定位 | 是 |
| `GraphState` | `nodes`, `edges`, `layout`, `provenance` | 中央主图与观点图 | 是 |
| `MermaidState` | `code`, `normalized_code`, `compile_ok`, `error_message`, `mermaid_version`, `syntax_profile` | Mermaid 主舞台与错误提示 | 是 |
| `InsightState` | `contested_entities`, `consensus_entities`, `open_questions`, `next_prompts` | 右侧 insight rail | 是 |
| `EvaluationState` | `latency`, `flicker`, `mental_map`, `intent_accuracy` | 评测与次级指标展示 | 是，但默认应次级展示 |
| `LegacyRuntimePayload` | 运行时内部产物 | 兼容/恢复用途 | 否 |

### 7.2 原则

- 前端只消费 DTO，不消费 runtime 内部结构
- 后端内部可继续使用 legacy runtime state
- 对外输出必须是稳定的 view model

---

## 8. Contract 单一来源建议

当前推荐方向是：

- 以后端 schema / OpenAPI 作为单一来源
- 前端 contract 和 typed client 尽量从后端 schema 自动生成

### 8.1 为什么要这样做

因为当前存在：

- Pydantic schema
- zod schema

这两套长期并行，重写后还会继续漂移。

### 8.2 推荐做法

可以采用以下任一策略：

#### 方案 A

后端维护 OpenAPI，前端通过生成工具生成：

- TypeScript types
- zod validators
- API client skeleton

#### 方案 B

保留 `packages/contracts`，但改成“生成产物”，不是手写源文件。

### 8.3 结论

无论具体工具怎么选，目标都应是：

- 后端 schema 为唯一源头
- 前端不再手工维护一套平行协议定义

### 8.4 当前 contract 薄弱点清单

| 位置 | 当前问题 | 风险 | 建议 |
| --- | --- | --- | --- |
| `apps/api/app/schemas.py` | `pipeline` / `evaluation` 仍过宽 | 前端依赖后端内部实现 | 将宽对象拆成明确子模型 |
| `packages/contracts/src/index.ts` | 与后端 schema 平行维护 | 漂移风险 | 改为生成产物或减少重复定义 |
| `apps/web/lib/api.ts` | 直接返回大量宽对象 | 页面“直接吃 payload” | 增加 feature 级 API + DTO mapper |

---

## 9. 前端重写时推荐拆出的应用层模块

### 9.1 Realtime Orchestrator

职责：

- session create / resume
- chunk send
- snapshot / flush / close
- server result merge

不负责：

- UI 布局
- Mermaid DOM 渲染

### 9.2 Capture Adapter Layer

职责：

- browser microphone
- system audio helper
- browser speech
- API STT bridge

目标：

- 让页面根本不关心音频采集细节

### 9.3 Mermaid Adapter

职责：

- Mermaid 渲染
- 渲染失败日志
- fallback 清洗
- compile 状态映射

这里必须被单独强调，因为我们已经验证过 Mermaid 问题不是孤立前端 bug，而是一条跨层链路问题。

### 9.4 Timeline / Replay Controller

职责：

- update scrubber
- snapshot jump
- replay mode state

### 9.5 Insight Mapper

职责：

- 将后端 `annotations` / `events` / `focus_entities`
  转成前端右栏所需的展示模型

### 9.6 应用层模块建议表

| 模块 | 输入 | 输出 | 不应该承担的职责 |
| --- | --- | --- | --- |
| `realtimeOrchestrator` | 用户动作、session id、API 响应 | 当前会话状态、snapshot、notice | 页面布局 |
| `captureAdapter` | 麦克风/系统音频环境 | transcript chunk / STT 请求 | 图展示逻辑 |
| `mermaidAdapter` | Mermaid code / normalized code | SVG、错误、日志 | 会话编排 |
| `timelineController` | events / snapshots | 当前 replay 游标、回放状态 | Mermaid 生成 |
| `insightMapper` | annotations / events / focus_entities | 右栏展示模型 | 网络请求 |
| `runtimePreferenceStore` | 本地偏好读写 | 统一配置状态 | 页面可视化 |

---

## 10. 页面层推荐拆法

以 realtime 为例，不建议继续只有一个 `RealtimeStudio`。

建议拆成：

- `RealtimePageContainer`
  - 只做 route 层拼装
- `RealtimeWorkspace`
  - 组合三个 pane
- `TranscriptPane`
  - 展示对话脊柱
- `CanvasPane`
  - Graph / Mermaid / Perspective / Replay
- `InsightPane`
  - 当前焦点 / 分歧共识 / 下一步建议
- `SessionControls`
  - 开始、发送、结束、更多操作
- `CaptureControls`
  - 与音频输入有关的控件

好处：

- 新版 UI 可以重做
- 业务流程不需要跟着重写
- 后续桌面端/移动端布局更容易复用

---

## 10.1 推荐页面与模块映射表

| 页面/区域 | 直接依赖的模块 | 允许依赖 | 不允许直接依赖 |
| --- | --- | --- | --- |
| `RealtimePageContainer` | `realtimeOrchestrator` | feature hooks | 低层音频 API、Mermaid 细节 |
| `TranscriptPane` | `TranscriptState` | UI components | 直接发网络请求 |
| `CanvasPane` | `GraphState`, `MermaidState` | `mermaidAdapter` | session 创建/关闭逻辑 |
| `InsightPane` | `InsightState` | `insightMapper` | 原始 runtime payload |
| `SessionControls` | orchestrator actions | session summary | Mermaid DOM 操作 |
| `CaptureControls` | `captureAdapter` | backend state | 评测指标计算 |

---

## 11. 关键接口文档

这一节记录当前建议保留的关键接口，以及新前端应如何看待它们。

### 11.1 Auth / Catalog / 基础能力接口

| Method | Path | 用途 | 关键请求字段 | 关键响应字段 | 前端备注 |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/v1/auth/login` | 管理员登录 | `username`, `password` | `username`, `display_name` | 平台壳登录入口 |
| `POST` | `/api/v1/auth/logout` | 登出 | 无 | `ok` | 前端应清理本地 session UI 状态 |
| `GET` | `/api/v1/auth/me` | 获取当前身份 | 无 | `username`, `display_name` | 用于壳层鉴权 |
| `GET` | `/api/v1/catalog/runtime-options` | 获取可用 LLM/STT runtime | 无 | `llm_profiles[]`, `stt_profiles[]` | 用户可选 runtime 展示 |
| `GET` | `/api/v1/catalog/runtime-options/admin` | 获取带敏感信息的 runtime 配置 | 无 | profile config 列表 | 仅管理端设置页 |
| `PUT` | `/api/v1/catalog/runtime-options/admin` | 保存 runtime 配置 | `llm_profiles`, `stt_profiles` | 保存后的完整配置 | 配置页使用 |
| `POST` | `/api/v1/catalog/runtime-options/admin/probe-models` | 远端模型探测 | `endpoint`, `provider_kind`, `api_key/api_key_env` | `ok`, `models_endpoint`, `models[]` | 管理功能 |
| `GET` | `/api/v1/catalog/datasets` | 数据集列表 | 无 | `slug`, `display_name`, `sample_count`, `is_default` 等 | 样本浏览和 study 配置依赖 |
| `GET` | `/api/v1/catalog/datasets/{slug}/splits` | 获取 split 信息 | `slug` | `split`, `count`, `example_ids[]` | 样本浏览依赖 |
| `GET` | `/api/v1/catalog/datasets/{slug}/samples` | 样本列表 | `split`, `search`, `offset`, `limit` | `sample_id`, `diagram_type`, `dialogue_turns` 等 | 建议封装分页对象 |
| `GET` | `/api/v1/catalog/datasets/{slug}/samples/{sample_id}` | 样本详情 | `split` | `sample_id`, `diagram_type`, `code`, `dialogue`, `metadata` | 样本对比页依赖 |

### 11.2 Realtime 核心接口

| Method | Path | 用途 | 关键请求字段 | 关键响应字段 | 新前端建议 |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/v1/realtime/sessions` | 会话列表 | 无 | `session_id`, `title`, `status`, `summary` | 做成 `SessionSummary[]` |
| `POST` | `/api/v1/realtime/sessions` | 创建实时会话 | `title`, `min_wait_k`, `base_wait_k`, `max_wait_k`, `llm_*`, `stt_*`, `diagram_mode`, `client_context` | `RealtimeSession` | 由 orchestrator 调用 |
| `GET` | `/api/v1/realtime/sessions/{session_id}` | 获取会话元数据 | `session_id` | `RealtimeSession` | 恢复会话时使用 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/chunks` | 写入 transcript chunk | `timestamp_ms`, `text`, `speaker`, `is_final`, `expected_intent`, `metadata` | `ok`, `session_id`, `emitted_events`, `pipeline`, `evaluation` | 实时主链路入口 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/audio/transcriptions` | 上传音频并转写 | `chunk_id`, `sample_rate`, `channel_count`, `pcm_s16le_base64`, `speaker`, `metadata` | `ok`, `text`, `provider`, `model`, `latency_ms`, `pipeline`, `evaluation` | capture adapter 使用 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/snapshot` | 拉取当前快照 | 无 | `RealtimeSnapshot` | replay / 恢复时使用 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/flush` | 强制整理当前状态 | 无 | `RealtimeSnapshot` | 应收为次级操作 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/close` | 结束会话 | 无 | `ok`, `session_id`, `closed` | 用户流程的“结束”动作 |
| `POST` | `/api/v1/realtime/sessions/{session_id}/report` | 生成报告 | 无 | `ok`, `report_id` | 不应占首页主操作位 |

### 11.3 Realtime 关键 payload 字段说明

#### `RealtimeSessionCreateRequest`

| 字段 | 类型 | 当前作用 | 重写建议 |
| --- | --- | --- | --- |
| `title` | `str` | 会话标题 | 保留 |
| `dataset_version_slug` | `str?` | 关联数据集版本 | 保留，可选 |
| `min_wait_k/base_wait_k/max_wait_k` | `int` | runtime 等待策略 | 保留给高级配置，不做首页主输入 |
| `llm_profile_id` / `llm_model` | `str?` | LLM runtime 选择 | 放到高级设置 |
| `stt_profile_id` / `stt_model` | `str?` | STT runtime 选择 | 放到高级设置 |
| `diagram_mode` | `str` | 当前图模式 | 前端可转成更清晰的 UI enum |
| `client_context` | `dict` | 浏览器、输入源、能力状态 | 建议前端封装后统一传递 |

#### `RealtimeChunkCreateRequest`

| 字段 | 类型 | 当前作用 | 重写建议 |
| --- | --- | --- | --- |
| `timestamp_ms` | `int?` | chunk 时间戳 | adapter 生成，页面不关心 |
| `text` | `str` | 发言文本 | 主字段 |
| `speaker` | `str` | 说话人 | 主字段 |
| `is_final` | `bool` | 是否最终文本 | 采集链路控制 |
| `expected_intent` | `str?` | 研究/评测用标签 | 用户端不默认暴露 |
| `metadata` | `dict` | capture mode / source / backend 信息 | 建议收紧为 typed metadata |

#### `RealtimeSnapshot`

| 字段 | 类型 | 当前状态 | 新前端建议 |
| --- | --- | --- | --- |
| `session_id` | `str` | 稳定 | 保留 |
| `pipeline` | `dict` | 过宽 | 拆成 `session/transcript/graph/mermaid/insights/metrics` |
| `evaluation` | `dict?` | 过宽 | 拆成 `EvaluationState` |

#### `MermaidState`

| 字段 | 类型 | 当前来源 | 新前端用途 |
| --- | --- | --- | --- |
| `code` | `str` | LLM 原始/回退结果 | 调试用，不一定默认展示 |
| `normalized_code` | `str` | 后端 normalize 后结果 | 渲染优先使用 |
| `compile_ok` | `bool?` | Mermaid 编译结果 | 控制提示状态 |
| `render_ok` | `bool` | 服务端渲染链路状态 | UI badge |
| `error_message` | `str?` | 生成/编译错误 | 用户友好提示 |
| `provider` / `model` | `str` | 运行时来源 | 高级信息 |
| `latency_ms` | `float` | 生成延迟 | 次级指标 |
| `mermaid_version` | `str` | 运行时版本 | 调试/兼容信息 |
| `syntax_profile` | `str` | Mermaid 语法子集 | 调试/兼容信息 |
| `repair_attempted` / `repair_succeeded` | `bool` | 自动修复链路状态 | 调试与观察用 |

### 11.4 Runs / Studies / Reports 接口

| Method | Path | 用途 | 关键请求字段 | 关键响应字段 | 前端备注 |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/v1/runs` | run 列表 | 无 | `RunJob[]` | 报告/实验页依赖 |
| `POST` | `/api/v1/runs/sample-compare` | 创建样本对比 run | `title`, `dataset_version_slug`, `split`, `sample_id`, `predictors[]` | `RunJob` | 样本对比页依赖 |
| `POST` | `/api/v1/runs/benchmark-suite` | 创建 benchmark run | `title`, `dataset_version_slug`, `split`, `config_json` | `RunJob` | 研究能力 |
| `GET` | `/api/v1/runs/{run_id}` | run 详情 | `run_id` | `RunJob` | 结果页依赖 |
| `GET` | `/api/v1/runs/{run_id}/artifacts` | run artifact 列表 | `run_id` | `RunArtifactSummary[]` | 下载入口 |
| `GET` | `/api/v1/runs/stream/events` | SSE 监听 run 更新 | `run_id` | `text/event-stream` | 前端应封装订阅 |
| `GET` | `/api/v1/studies/tasks` | task 列表 | 无 | `StudyTask[]` | 管理端使用 |
| `POST` | `/api/v1/studies/tasks` | 创建 task | `title`, `description`, `default_condition`, `system_outputs` 等 | `StudyTask` | 管理端配置 |
| `POST` | `/api/v1/studies/tasks/{task_id}/sessions` | 创建 participant session | `participant_id`, `study_condition`, `participant_code?` | `StudySession` | 管理端使用 |
| `GET` | `/api/v1/studies/participant/{participant_code}` | 参与者查看 session | `participant_code` | `StudySession` | 用户研究入口 |
| `POST` | `/api/v1/studies/participant/{participant_code}/start` | 开始 session | 无 | `StudySession` | participant flow |
| `POST` | `/api/v1/studies/participant/{participant_code}/autosave` | 自动保存草稿 | `draft_output`, `input_transcript?` | `StudySession` | 编辑器 autosave |
| `POST` | `/api/v1/studies/participant/{participant_code}/submit` | 提交结果 | `final_output`, `input_transcript?` | `StudySession` | participant flow |
| `POST` | `/api/v1/studies/participant/{participant_code}/survey` | 提交问卷 | `payload` | `SurveyResponse` | participant flow |
| `GET` | `/api/v1/reports` | 报告列表 | 无 | `ReportSummary[]` | 报告页依赖 |
| `GET` | `/api/v1/reports/{report_id}` | 报告详情 | `report_id` | `ReportDetail` | 报告详情页依赖 |
| `GET` | `/api/v1/reports/exports/download` | 导出 runs/studies/realtime | `target`, `fmt` | 文件下载 | 建议作为二级能力 |

### 11.5 重写期间的接口兼容策略

| 策略 | 说明 | 适用对象 |
| --- | --- | --- |
| 保留旧 endpoint | 避免后端被新前端阻塞 | 全部现有路由 |
| 宽 payload 双轨输出 | 新增明确 DTO，同时保留旧字段一段时间 | `RealtimeSnapshot.pipeline` |
| 前端先依赖 DTO mapper | 即便后端未完全收口，也先在前端统一映射 | `realtime/studies/reports` |
| 调试信息降级为次级面板 | 编译、latency、provider 等不默认占主界面 | `MermaidState`, `EvaluationState` |

---

## 12. 推荐迁移路径

### 阶段 1：冻结后端边界

目标：

- 确认哪些 endpoint 保留
- 确认哪些 payload 需要收口
- 不再继续扩张旧页面私有字段

输出：

- 一份 `API contract checklist`

如果这一步不做，前端重写会很容易再次掉进旧坑：

- 新前端刚开始搭，后端 payload 还在继续跟着旧页面长

### 阶段 2：收紧 DTO

目标：

- 将 `pipeline` 和 `evaluation` 拆成明确对象
- 降低 `any` / `dict[str, Any]`

输出：

- 稳定的前端消费 DTO

### 阶段 3：抽应用层

目标：

- 把 `apps/web/components/realtime-studio.tsx` 中的副作用抽出去

输出：

- `realtime` feature 内部 hooks / services / adapters

### 阶段 4：重写展示层

目标：

- 重新做页面结构和视觉交互
- 不改动核心后端逻辑

输出：

- 新版 realtime 页面
- 新版 samples / reports / studies 逐步迁移

### 阶段 5：下线旧前端

目标：

- 清理 `frontend/realtime_ui`
- 清理旧的页面私有协议依赖

---

## 13. 这次重写最应该优先做的事

如果资源有限，最值得优先做的是三件事：

### 13.1 先做 contract 收口

因为如果协议不稳，前端重写越快，返工越大。

这是当前最值得强调的一条教训。

### 13.2 先拆 realtime 应用层

因为 realtime 是当前最重、最复杂、最容易卡住重写的部分。

这不是抽象判断，而是现有 `RealtimeStudio` 已经明确暴露出来的现实问题。

### 13.3 保持后端 view model 稳定

后端内部可以继续演进，但给前端的对象一定要稳定。

否则 Mermaid、insight、timeline、session state 会继续纠缠在一起。

---

## 14. 一句话结论

这次前端重写不应该被理解为“重做一个页面”，而应该被理解为：

- 保留现有后端服务能力
- 固化前后端契约
- 抽离前端应用层
- 重建展示层

真正的解耦目标是：

- 后端不依赖前端页面实现
- 前端不依赖后端内部 runtime 细节
- 页面不依赖复杂副作用
- 新旧前端可以在一段时间内并存迁移

---

## 15. 推荐后续动作

建议团队下一步按下面顺序推进：

1. 先列一版正式的 realtime DTO 草案
2. 再拆 `apps/web` 的应用层和展示层
3. 再开始重写页面视觉与交互

如果需要继续细化，可以下一步补两份文档：

- `Realtime DTO 设计草案`
- `apps/web 重构目录与模块拆分清单`
