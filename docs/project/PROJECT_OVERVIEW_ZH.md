## 1. 项目是什么

`Stream2Graph` 是一个围绕“多轮协作对话实时成图”构建的研究型系统。

它研究的问题不是普通的“文本生成 Mermaid”，而是：

- 如何从会议式、协作式、多轮对话中识别结构信息
- 如何将这些信息转成 Mermaid 图表代码
- 如何在实时交互过程中逐步更新图，而不是一次性离线生成
- 如何评估这种系统在结构质量、可编译性、实时性和可用性上的表现

因此，这个项目天然包含四个层面：

- 数据集
- 算法
- 系统
- 评测

## 2. 项目主线叙事

最合理的项目叙事是：

> 我们希望构建一个能够从多轮协作对话中实时生成结构化图表的系统。为此，我们构建了高质量数据集、设计了流式意图识别与增量渲染算法、搭建了统一评测平台，并将系统包装成可用于实验和用户研究的交互式网页工作台。

这条叙事很重要，因为它决定了项目的重点不是“某个模型 API 能不能出 Mermaid”，而是：

- 任务是否清晰
- 数据是否高质量
- 系统是否真的支持实时使用
- 评测是否严谨
- 用户研究是否能够支撑论文主张

## 3. 当前仓库架构

### 3.1 顶层目录

当前仓库中最重要的目录如下：

- [versions](E:/Desktop/stream2graph/versions)
  - 历史版本与主数据资产。
- [tools](E:/Desktop/stream2graph/tools)
  - 仓库级脚本、服务、训练、评测与运维工具。
- [frontend](E:/Desktop/stream2graph/frontend)
  - 现有前端 demo。
- [configs](E:/Desktop/stream2graph/configs)
  - 模型、评测、重生成等配置。
- [reports](E:/Desktop/stream2graph/reports)
  - 运行结果、实验报告和发布报告。
- [docs](E:/Desktop/stream2graph/docs)
  - 项目文档、评测文档、训练文档、运维文档。

### 3.2 版本演化

从版本历史看，项目经历了几次关键阶段：

- `v1_2026-02-05_legacy_8k_pipeline`
  - 早期 8k 五阶段流水线骨架。
- `v2_2026-02-08_real_100percent_license_fix`
  - 许可证修复与高质量筛选阶段。
- `v3_2026-02-27_latest_9k_cscw`
  - 9k 主线数据、CSCW 对话逆向工程、实时成图算法主线。

版本索引可见 [VERSION_INDEX.md](E:/Desktop/stream2graph/VERSION_INDEX.md#L1)。

## 4. 数据集是怎么来的

### 4.1 历史来源

项目的数据不是直接采集真实会议对话得到的，而是沿着以下方向逐步构建：

- 收集 Mermaid 图、流程图、架构图、状态图、时序图等结构化图表
- 从图反推出适合协作语境的对话
- 多次进行许可证清洗、编译验证、质量筛选和对话重生成

因此它是一个“程序化构建 + 后续高质量重生成”的研究型数据集。

### 4.2 规则引擎阶段

较早期的图到对话由规则引擎生成，核心代码在：

- [cscw_dialogue_engine.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/cscw_dialogue_engine.py#L527)
- [run_reverse_engineering_v2.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/run_reverse_engineering_v2.py#L57)

这套系统会：

- 解析 Mermaid 代码
- 提取节点、边、标签与图类型
- 基于角色模板生成 Expert / Editor 风格的多轮对话
- 控制轮次数与对话结构

这一步的价值在于冷启动和规模扩展，但它不是最终高质量版本。

### 4.3 高质量重生成阶段

后续项目又对数据进行了大模型重生成。当前最新完整版本是：

- [release_v6_kimi_k25_fullregen_20260312](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v6_kimi_k25_fullregen_20260312)

其构建报告在：

- [\_regen_build_report.json](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v6_kimi_k25_fullregen_20260312/_regen_build_report.json#L1)

当前关键数字：

- 总样本数：`8663`
- 成功重生成：`8651`
- fallback 保留旧对话：`12`
- parse 失败：`12`

这意味着当前 `V6` 已经是一个几乎全量高质量重生成版数据集。

## 5. 当前数据集规模与复杂度

`V6` 总量是 `8663`。在当前任务语境下，这已经不是小数据。

按之前统计，数据整体特点是：

- 对话轮数中等，但长尾很明显
- Mermaid 代码长度中等偏长
- 图类型丰富
- 存在不少复杂 flowchart、stateDiagram、architecture 和 sequence 样本

这也是为什么模型微调和通用模型 baseline 会有明显难度差异。

## 6. 核心算法链路

### 6.1 实时成图总流程

当前实时算法主链路是：

`ASR / transcript chunk -> 流式意图识别 -> 增量图操作 -> 增量渲染`

核心入口：

- [run_realtime_pipeline.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/run_realtime_pipeline.py#L62)

### 6.2 流式意图识别

核心文件：

- [streaming_intent_engine.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/streaming_intent_engine.py#L262)

这部分负责：

- 以 chunk 为单位接收 transcript
- 做在线分段
- 做启发式意图判断
- 根据置信度与语义新颖度动态调整 `wait-k`
- 输出增量图操作建议

它是实时系统的关键，不是简单地对整段文本做一次分类。

### 6.3 增量渲染与稳定性控制

核心文件：

- [incremental_renderer.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/incremental_renderer.py#L57)

这部分负责：

- 按 update 逐步追加节点与边
- 维护节点位置
- 控制局部松弛和结构稳定性
- 输出 `flicker_index`
- 输出 `mental_map_score`

也就是说，这个项目不只是“生成图”，而是“尽量稳定地实时更新图”。

### 6.4 实时评测

核心文件：

- [evaluate_realtime_pipeline.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/evaluate_realtime_pipeline.py#L45)

当前评测维度包括：

- 延迟
- flicker
- mental map
- 意图识别准确率

因此后续正式网页和用户研究，也必须把“实时稳定性”视为核心指标，而不是只看最终 Mermaid。

## 7. 当前原型系统

### 7.1 现有 API 原型

现有桥接服务在：

- [realtime_frontend_server.py](E:/Desktop/stream2graph/tools/realtime_frontend_server.py#L382)

它已经支持：

- 健康检查
- session 管理
- transcript chunk 接收
- flush / snapshot / close
- pipeline 运行
- realtime evaluation
- pretrain unified evaluation
- report save

### 7.2 现有前端 demo

现有 demo 在：

- [frontend/realtime_ui](E:/Desktop/stream2graph/frontend/realtime_ui)

它已经证明：

- 这条系统链路是可调用的
- 前端可以和后端实时交互
- 但当前只是研究 demo，不是正式产品

## 8. 统一评测平台

评测平台已经具备论文实验的基本骨架。核心入口包括：

- [run_eval_suite.py](E:/Desktop/stream2graph/tools/eval/run_eval_suite.py#L1)
- [run_unified_inference.py](E:/Desktop/stream2graph/tools/eval/run_unified_inference.py#L1)
- [run_offline_metrics.py](E:/Desktop/stream2graph/tools/eval/run_offline_metrics.py#L1)
- [run_realtime_metrics.py](E:/Desktop/stream2graph/tools/eval/run_realtime_metrics.py#L1)
- [build_benchmark_report.py](E:/Desktop/stream2graph/tools/eval/build_benchmark_report.py#L1)

当前已经支持：

- API baseline 推理
- 本地模型推理
- 离线结构指标
- Mermaid 编译验证
- 实时指标
- 汇总报告

## 9. 当前项目要解决的核心问题

从研究角度看，这个项目真正要回答的是：

- 通用大模型能否从协作对话稳定生成结构化图代码？
- 微调模型是否能显著提升图结构质量和可编译性？
- 实时增量成图系统是否比一次性离线生成更适合交互场景？
- 用户是否真的觉得这种系统有帮助？

这四个问题共同决定了后续论文和产品平台的方向。

## 10. 推荐的论文叙事

最合理的论文叙事不是：

- “我们训了个更好的 Mermaid 生成模型”

而是：

- “我们定义了一个面向协作对话的实时成图任务”
- “我们构建了高质量数据集”
- “我们提出了支持实时使用的算法和系统”
- “我们通过自动指标和用户研究验证它的效果”

这条叙事更适合 `ICMI 2026`，因为它同时覆盖：

- multimodal / dialogue task
- dataset contribution
- interactive system contribution
- evaluation contribution

## 11. 当前项目最值得强调的创新点

真正值得强调的创新性在于组合：

- 任务定义新
  - 从协作对话到图，而不是普通文本到图
- 数据资产新
  - 从规则引擎阶段走到高质量大模型重生成版 `V6`
- 系统目标新
  - 强调实时成图和稳定性，而不只是最终结果
- 评测方式完整
  - 包含结构指标、编译验证、实时指标和未来用户研究

单看某一项都未必足够强，但组合起来是有研究竞争力的。

## 12. 当前项目的现实状态

项目现在已经有：

- 完整数据集 `V6`
- 实时算法原型
- 原型服务端
- demo 前端
- 多模型评测平台
- 至少一个通用模型正式 baseline 结果

例如，`Qwen3.5-Plus` 在 `V6 test` 上当前结果显示：

- `node_f1 = 0.7424`
- `edge_f1 = 0.6360`
- `compile_success = 0.3233`

这说明通用模型并非没有能力，但距离“稳定可用的图代码系统”仍有明显差距。这个差距正是后续微调模型、系统策略和论文贡献的空间。

## 13. 对新同学的最重要提醒

如果你是新加入的前后端同学，你首先要理解：

- 这不是一个普通网页项目
- 这也不是一个普通模型推理项目
- 它是一个研究系统

所以你要做的网页平台，必须支撑：

- 真实研究 demo
- 真实用户研究
- 真实实验记录
- 真实算法接入

如果只做成一个漂亮但空心的演示页，那对这个项目价值很有限。
