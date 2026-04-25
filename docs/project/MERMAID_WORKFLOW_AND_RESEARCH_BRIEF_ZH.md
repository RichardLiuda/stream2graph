# Stream2Graph Mermaid 显示工作流与魔改研究简报

## 1. 文档目的

这份文档用于向另一个 AI 或研究协作者说明：

- `Stream2Graph` 项目整体在做什么
- 当前项目中的 Mermaid 是如何生成、如何渲染、如何交互更新的
- 当前“多人观点碰撞图”的显示方式为什么会出现可读性问题
- 如果想支持“按人物平行线展开观点，并在人物之间牵出冲突/呼应关系”的视觉表达，应该优先研究哪些切入点
- 是否真的需要魔改 Mermaid 源码，还是可以先在上层语义和后处理层解决

这不是一份部署文档，也不是一份终端用户使用手册，而是一份面向研发和研究分析的技术背景材料。

## 2. 项目总体描述

`Stream2Graph` 是一个围绕“多轮协作对话实时成图”构建的研究型系统。

它研究的核心问题不是普通的“一次性把文本生成 Mermaid”，而是：

- 如何从会议式、协作式、多轮对话中提取结构信息
- 如何把这些结构信息表示为图结构，再转成 Mermaid
- 如何在实时交互过程中逐步更新图，而不是等对话结束后一次性离线生成
- 如何评估这种系统在结构质量、可编译性、延迟、稳定性和用户理解度上的表现

因此，项目天然包含四个层面：

- 数据集：围绕 Mermaid 图到协作对话的逆向构建与重生成
- 算法：实时意图识别、图结构更新、增量渲染
- 系统：正式平台、实时工作台、样本对比和用户研究流程
- 评测：离线 Mermaid 编译/结构评测 + 实时稳定性评测

更准确地说，`Stream2Graph` 的主线叙事是：

> 构建一个能够从多轮协作对话中实时生成结构化图表的系统。为此，项目建设了高质量数据集、设计了流式意图识别与增量图更新算法、搭建了统一评测平台，并将其包装为可用于实验与用户研究的网页工作台。

## 3. 当前仓库中的正式平台架构

目前仓库中的正式平台主要由以下部分组成：

- 前端：`apps/web`
- 后端 API：`apps/api`
- 共享类型：`packages/contracts`
- UI 组件：`packages/ui`

其中与当前问题最相关的是实时工作台和 Mermaid 渲染链路。

从职责上看，可以把平台粗略拆成四层：

1. 输入层
   - 接收 transcript、麦克风输入或其他实时文本来源
2. 语义/结构层
   - 根据对话内容维护当前图的结构化表示
3. Mermaid 表达层
   - 把结构化图转换为 Mermaid 文本
4. 前端显示层
   - 在浏览器里用 Mermaid 运行时把文本渲染成 SVG，并提供缩放、拖拽、导出等交互

## 4. 与 Mermaid 相关的当前工作流

### 4.1 总体链路

当前项目里的 Mermaid 工作流，不是“直接把一段 Mermaid 字符串送给前端显示”这么简单，而是：

`实时对话 / transcript -> GraphIR -> Mermaid 文本 -> Mermaid SVG -> 前端交互增强 -> 可选的拖拽反馈重规划`

这里最重要的一点是：

- 系统的核心真实状态其实是 `GraphIR`
- Mermaid 更像是这份图结构的一个可视化投影

这意味着当前系统不是“Mermaid-first”，而是“graph-IR-first”。

### 4.2 结构化图状态：GraphIR

在正式平台里，后端维护一份当前图的结构化状态，里面主要包含：

- `nodes`
- `edges`
- `groups`
- `styles`
- `diagram_type`

前端主舞台除了拿到 `mermaid_state` 之外，也会拿到 `graph_state.current_graph_ir`，说明前端并不是只依赖一段 Mermaid 文本，而是同时知道图的结构实体。

这点很关键，因为它意味着后续如果要做更强的“人物泳道”“观点轨道”“碰撞关系”，未必必须从 Mermaid 语法里硬编码，也可以先从 `GraphIR` 的语义扩展入手。

### 4.3 GraphIR 到 Mermaid 的转换

当前的 Mermaid 预览生成逻辑主要在：

- `tools/incremental_dataset/staging.py`

其 `render_preview_mermaid(graph_ir)` 会根据 `diagram_type` 分不同分支生成 Mermaid。

对于当前最相关的 `flowchart` 路径，现有策略是：

- 顶层统一生成 `graph TD`
- `group` 被生成为 `subgraph`
- `node` 被生成为普通方框节点
- `edge` 被生成为 `-->` 或带 label 的箭头
- `styles` 会被追加为 Mermaid style/class 指令

这意味着当前“人物”“角色”“发言分组”等概念，本质上只是作为 `subgraph` 分组出现，而不是强约束的“固定泳道”。

### 4.4 前端 Mermaid 渲染

前端渲染逻辑主要在：

- `apps/web/components/mermaid-card.tsx`

其工作方式大致是：

1. 接收 `code`
2. 先做一次 `normalizeMermaidForRender`
   - 提取 Mermaid 代码
   - 对 flowchart 语法做一定修补
   - 统一 header 形式
3. 初始化 Mermaid runtime
4. 调用 `mermaid.render(renderId, candidate)` 生成 SVG
5. 把 SVG 直接塞进 DOM

当前前端已经做过一部分“显示清晰度优化”，包括：

- `htmlLabels: false`
  - 使用 SVG 原生文本，减少 `foreignObject` 带来的模糊
- 更大的字体
- `text-rendering: geometricPrecision`
- 对线条做更锐利的矢量显示

换句话说，当前系统已经针对“Mermaid 放大后会糊”做过一轮优化。

### 4.5 前端交互增强并不等于 Mermaid 布局增强

项目当前还做了一个重要增强：支持拖拽图中的节点。

但是这里要特别注意：

- 拖拽不是简单地永久修改 SVG 坐标
- 当前实现会在前端测量节点和 group 的位置
- 用户拖动节点后，前端会生成一个带空间信息的 `drag_payload`
- 然后把这个 payload 发回后端
- 后端再调用 Planner，根据“拖到了哪里、离谁最近、落在哪个 group 里”等语义提示，重新产出新的 `GraphIR`
- 最后再重新生成 Mermaid，再重新渲染

所以这套机制本质上是：

`拖拽交互 -> 语义 relayout 请求 -> Planner 重构图结构 -> 重新生成 Mermaid`

而不是：

`拖拽交互 -> 直接修改 Mermaid 内部布局器坐标`

这说明当前系统虽然已经具备“交互式重排”能力，但它仍然没有真正改动 Mermaid 的布局算法。

## 5. 当前正式平台中的两条 Mermaid 来源链路

当前项目里实际上存在两条 Mermaid 生成链路。

### 5.1 LLM 直接生成 Mermaid

在某些场景下，系统会：

- 从 transcript 拼 prompt
- 调用 LLM 直接生成 Mermaid
- 对 Mermaid 做 normalize
- 可选做编译检查
- 如果编译失败，再做 repair

这条链路更像是“Mermaid 文本直出”的模式。

### 5.2 GraphIR 算法预览生成 Mermaid

在实时协作主链路里，更重要的是另一条路径：

- 系统维护当前 `GraphIR`
- 把 `GraphIR` 转成 `preview_mermaid`
- 把这个 Mermaid 作为前端显示内容

在这条链路里，Mermaid 更像“渲染中间层”，而不是核心真相来源。

这意味着：

- 如果只是想让图“更像多人讨论图”，优先调整 `GraphIR` 语义和 `GraphIR -> Mermaid` 映射，可能比直接改 Mermaid 内核更有效
- 只有当 Mermaid 的表达能力和布局能力都成为硬瓶颈时，魔改 Mermaid 源码才是下一步

## 6. 现有效果的结构性问题

当前用户提供的样例文件为：

- `/Users/richardliu/Downloads/研究演示会话_graph (1).svg`

从该 SVG 可以判断出目前的显示属于：

- Mermaid `flowchart`
- 左右两侧通过 `subgraph` 表示不同人物或立场
- 中间大量普通节点和跨分组箭头表达观点、论据、补充和关联

这种表达方式的问题不是“画不出来”，而是“画出来之后不够贴近多人观点碰撞的认知结构”。

具体来说，当前问题主要有：

### 6.1 人物只是分组，不是主轴

当前人物或角色只是 `subgraph`，它们只是给节点套了个框。

这导致：

- 人物本身不是布局主轴
- 观点不会天然沿着“这个人自己的线”持续展开
- 不同人物之间也不会形成稳定、平行、可追踪的视觉轨道

### 6.2 布局目标偏向一般图优化，而不是对话可读性优化

Mermaid flowchart 的布局器更偏向一般图排版，它关注的是：

- 节点和边的全局排布
- 层级方向
- 一定程度上的交叉控制

但它不天然理解以下语义：

- 说话人泳道
- 发言顺序
- 观点接续
- 反驳与呼应
- 多人讨论中的交错推进

因此，一旦跨人物关系变多，图就会被拉得很宽，并出现大量远距离长弧线。

### 6.3 “观点碰撞”被表示为普通图边，缺少专门视觉语法

当前系统中，支持、反驳、引申、补充、转折等关系，最终都还是普通边。

这使得：

- “谁在回应谁”不够直观
- “哪个观点是在同一人物线上延续”不够直观
- “两个阵营之间的冲突点”不够突出

也就是说，当前图在图论意义上是连通的，但在认知意义上并不够“像一场辩论或讨论”。

### 6.4 当前清晰度问题不只是像素/字体问题

前端已经处理过一部分清晰度问题，但用户真正感受到的“不清晰”，更大程度上来自：

- 视觉主轴不明确
- 边太长
- 跨组关系太多
- 缺少稳定的人物轨道
- 图的阅读顺序不自然

因此，“继续调大字体或加粗线条”不会从根本上解决问题。

## 7. 用户想要的目标表达方式

用户希望的方向可以概括为：

- 用平行线或平行泳道记录不同人物的观点推进
- 让每个人的观点沿自己的一条稳定轨迹展开
- 在这些人物轨道之间，显式牵出支持、反驳、回应、呼应等联系
- 能直观表达“多人之间的观点碰撞”和“观点交错推进”

更具体地说，理想视觉效果接近以下认知模型：

1. 人物是一级视觉锚点
2. 每个人物有自己的一条横向或纵向发言轨道
3. 同一个人的观点沿自身轨道顺序展开
4. 跨人物关系用专门的连接语法表示
5. 冲突关系、共识关系、补充关系在视觉上应能区分
6. 读者能够一眼看出：
   - 谁提出了什么
   - 谁回应了谁
   - 哪些观点形成正面对撞
   - 哪些观点只是补充或延展

## 8. 研究“是否魔改 Mermaid 源码”时的关键判断

研究时不要只问“Mermaid 能不能画”，而要问下面三个层次的问题。

### 8.1 第一层：当前问题是否可以通过上层语义建模解决

需要先判断：

- 现在的 `GraphIR` 是否已经能表达“人物泳道”“发言顺序”“观点串”“冲突关系类型”
- 如果不能，是否应该先扩展 `GraphIR`
- 如果 `GraphIR` 语义不够，直接魔改 Mermaid 只会把弱语义硬渲染出来，效果仍然不会理想

建议优先研究：

- 为 node 增加 `speaker_id / lane_id / turn_index / claim_thread_id / relation_type`
- 为 edge 增加更明确的语义，如：
  - `support`
  - `oppose`
  - `challenge`
  - `elaborate`
  - `redirect`
- 为 group 增加“人物泳道”而不是一般分组的语义

### 8.2 第二层：能否仅靠 Mermaid 上层表达逼近目标效果

需要判断 Mermaid 原生能力是否足够支撑目标视觉。

可研究的问题包括：

- `flowchart + subgraph` 是否能通过更严格的生成策略实现准泳道布局
- `sequenceDiagram` 是否更适合“人是主轴、关系是跨轴消息”的展示
- 是否可以混合使用某种 Mermaid 图类型来表达多人讨论
- 是否可以在生成 Mermaid 时人为插入锚点节点、隐形边、顺序约束节点，强行引导布局器更像平行人物线

如果这些方法可以逼近目标，可能无需改 Mermaid 内核。

### 8.3 第三层：Mermaid 原生布局器是否已经成为硬瓶颈

当且仅当出现以下情况时，才更有理由研究魔改 Mermaid 源码：

- 已经有了足够清晰的上层语义模型
- 已经尝试过通过 Mermaid DSL 和布局引导技巧实现目标
- 但 flowchart/sequence 的现有布局器仍无法稳定产出“人物平行线 + 跨线联系”的结构

这时再考虑：

- 魔改 Mermaid 的 flowchart 布局逻辑
- 给 Mermaid 增加“lane / swimlane / speaker-track”概念
- 增加一种新的图类型，专门表示多人讨论结构
- 或在 Mermaid 渲染完成后，对 SVG 进行二次布局重写

## 9. 更可能的改造路径排序

从工程风险和收益比来看，建议按以下顺序研究，而不是一上来就改 Mermaid 源码。

### 路径 A：先改语义层和生成层

目标：

- 明确人物、观点、轮次、关系类型
- 把当前“普通图结构”升级为“多人对话结构图”

收益：

- 风险最低
- 可复用于 Mermaid、Canvas、SVG 后处理等多种显示方式
- 不被 Mermaid 单一实现绑死

### 路径 B：在 Mermaid 语法层做“布局引导”

目标：

- 不改 Mermaid 内核
- 通过额外锚点、隐形边、顺序节点、lane 容器等策略逼 Mermaid 更接近目标布局

收益：

- 改动比魔改 Mermaid 小
- 可以快速试验

风险：

- 可能会变脆
- 对复杂图不一定稳定

### 路径 C：Mermaid 渲染后做 SVG 后处理

目标：

- 让 Mermaid 负责基础图元生成
- 再对 SVG 中节点和边的几何位置做二次排版

收益：

- 不用 fork Mermaid 源码
- 对前端控制力更大

风险：

- 需要自己维护几何和连线逻辑
- 复杂度会很快上升

### 路径 D：直接魔改 Mermaid 源码

目标：

- 从 Mermaid 内部支持人物泳道/平行线/跨线关系布局

收益：

- 如果做成，表达能力最彻底

风险：

- 维护成本最高
- 需要跟 Mermaid 上游版本持续对齐
- 需要深入理解其解析、AST、布局和 SVG 生成流程

## 10. 对 Mermaid 源码研究者最有价值的结论

如果把这份文档交给另一个 AI 或研究者，最重要的背景结论是：

1. 当前系统不是单纯的 Mermaid viewer，而是 `GraphIR-first` 的实时成图系统。
2. 当前多人讨论图之所以“不够清晰”，主要不是字体问题，而是表达模型仍然是 `flowchart + subgraph + 普通边`。
3. 当前前端虽然支持节点拖拽，但拖拽本质上是语义 relayout 请求，不是直接改 Mermaid 布局器。
4. 真正需要研究的是：
   - 当前 `GraphIR` 是否足够表达多人观点碰撞
   - 是否能通过更强的 Mermaid 生成策略模拟“人物平行线 + 跨线联系”
   - 如果不能，再判断 Mermaid 内核是否值得 fork / patch
5. 如果要魔改 Mermaid，目标不应该只是“渲染更好看”，而应该是：
   - 让 Mermaid 原生理解“人物轨道 / 泳道 / 讨论线”
   - 让布局结果优先服务于“对话可读性”而不是一般图排版

## 11. 建议另一个 AI 继续回答的问题

建议后续研究直接围绕下面这些问题展开：

1. 在不修改 Mermaid 源码的前提下，如何用 `flowchart` 或 `sequenceDiagram` 逼近“多人观点碰撞图”？
2. 当前 `GraphIR` 至少还缺哪些字段，才能表达“人物平行线 + 观点线程 + 关系类型”？
3. Mermaid 的哪一层最适合加“lane / swimlane / speaker-track”能力：
   - parser
   - graph model
   - layout
   - SVG renderer
4. 如果只做 SVG 后处理，如何最小代价地把现有 flowchart 变成更稳定的人物轨道图？
5. 从工程成本、维护成本和最终效果来看：
   - 上层语义扩展
   - Mermaid DSL 引导
   - SVG 二次布局
   - 直接 fork Mermaid
   哪条路线最值得先做原型验证？

## 12. 相关代码入口

与当前分析最相关的代码入口如下：

- `apps/web/components/mermaid-card.tsx`
  - Mermaid 渲染、归一化、清晰度设置、节点拖拽采样
- `apps/web/components/realtime-studio.tsx`
  - Mermaid 主舞台接入、relayout 请求发起
- `apps/api/app/services/realtime_coordination.py`
  - 实时图状态维护、拖拽后的 Planner relayout、GraphIR 更新
- `tools/incremental_dataset/staging.py`
  - `GraphIR -> Mermaid` 预览生成
- `apps/api/app/services/realtime_ai.py`
  - transcript -> Mermaid 的 LLM 直出链路

建议研究时优先把这些文件一起看，而不是只盯着 Mermaid 前端渲染组件。
