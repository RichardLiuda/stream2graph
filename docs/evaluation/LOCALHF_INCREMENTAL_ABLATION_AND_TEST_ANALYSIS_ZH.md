# LocalHF 增量系统消融与全量测试中文深度分析

## 数据来源与口径

本文档基于当前工作区中的以下结果目录进行分析：

- 4 组 `validation` 消融：
  - `incremental_localhf_qwen35_gateft_plannerft_validation_public_clean`
  - `incremental_localhf_qwen35_gateft_plannerbase_validation_public_clean`
  - `incremental_localhf_qwen35_gatebase_plannerft_validation_public_clean`
  - `incremental_localhf_qwen35_gatebase_plannerbase_validation_public_clean`
- 1 组最终组合 `test_full_public_clean`：
  - `incremental_localhf_qwen35_27b_planner_qwen35_4b_gate_test_full_public_clean`
- 现有工作区中的通用强基线：
  - Claude Sonnet 4.5
  - Gemini 3 Flash
  - GPT-5.4
  - MiniMax M2.7
  - Moonshot K2.5
  - Qwen3.5-Plus
  - Qwen3.5-Plus (thinking)
  - Qwen3.5-27B

注意：Gemini 的 `public_clean_official` 原始目录在当前工作区里是失效跑次，因此这里统一采用有效的 `incremental_gemini3flash_google_siliconflow_qwen35_4b_gate_test_full_public_clean_rerun2_official`。

所有汇总表、派生表和 SVG 图表已经生成到：

- [数据表目录](../../artifacts/evaluation/localhf_incremental_analysis/data)
- [图表目录](../../artifacts/evaluation/localhf_incremental_analysis/charts)

---

## 一、2x2 消融实验的核心结论

### 1. 总体判断

这组 `2 x 2` 消融是比较理想的，原因不在于“所有数字都高”，而在于模式非常干净、几乎没有反直觉反转：

- `planner` 微调一旦开启，严格匹配和语义质量稳定上升。
- `gate` 微调一旦开启，阶段完成率和 gate 时延稳定改善。
- `双微调` 在整体质量上最优。
- `双基座` 在整体质量上最弱。

这种结果对于论文特别有价值，因为它支持一个清楚、可验证、可解释的模块分工假设，而不是“拼装系统碰巧有效”。

### 2. 整体数值对比

4 组消融的顶层结果见：

- [ablation_overall.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_overall.csv)
- [Ablation Overall Quality](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_quality_overall.svg)
- [Ablation Overall Latency (sec)](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_latency_overall_sec.svg)

从总体结果看：

- `gateft_plannerft` 是最优组合：
  - `final_matches_reference = 0.0865`
  - `canonicalized_match = 0.0962`
  - `entity_semantic_f1 = 0.4567`
- `gatebase_plannerbase` 是最弱组合：
  - `final_matches_reference = 0.0224`
  - `canonicalized_match = 0.0513`
  - `entity_semantic_f1 = 0.3325`

如果把 strict exact match 换算成条数，更直观：

- `双微调`：约 `27 / 312`
- `只调大模型`：约 `23 / 312`
- `只调小模型`：约 `10 / 312`
- `双基座`：约 `7 / 312`

对应数据见 [ablation_count_estimates.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_count_estimates.csv)。

### 3. 主效应拆解：谁在贡献什么

主效应表见：

- [ablation_main_effects.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_main_effects.csv)
- [Ablation Main Effects on Quality](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_main_effects_quality.svg)
- [Ablation Main Effects on Latency (sec)](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_main_effects_latency_sec.svg)

#### 3.1 Planner 微调是主要的质量来源

在对 gate 取平均后，`planner FT` 相比 `planner base` 的主效应为：

- `final_matches_reference` 提升 `+5.29` 个百分点
- `canonicalized_match` 提升 `+3.68` 个百分点
- `entity_semantic_f1` 提升 `+0.1088`

这说明大模型微调不是“小修小补”，而是决定系统最终质量上限的主要因素。

更具体地说，planner 微调主要提升的是：

- 节点语义
- 分组语义
- 挂载关系语义
- 最终严格一致性

这非常符合 `planner` 在系统中的角色定义：它不是决定“要不要更新”，而是决定“这次更新的内容到底对不对”。

#### 3.2 Gate 微调是主要的稳定性来源

在对 planner 取平均后，`gate FT` 相比 `gate base` 的主效应为：

- `completed_all_stages` 提升 `+0.64` 个百分点
- `stage_coverage_rate` 提升约 `+0.0046`
- `gate_latency_mean_ms` 降低约 `1.20s`

同时，gate 微调也带来小幅正向质量收益：

- `final_matches_reference` 提升 `+1.12` 个百分点
- `entity_semantic_f1` 提升 `+0.0155`

这说明小模型微调不是完全不影响质量，但它的核心价值更偏向：

- 让更新触发时机更稳定
- 让阶段推进更充分
- 让 gate 本身更高效

#### 3.3 一个很适合写进论文的结论

这组消融最适合支撑下面这句论文结论：

> 小模型微调主要提升增量阶段控制的稳定性与效率，而大模型微调主要提升最终图结构与语义保真度；两者具有明显的非对称互补性。

这句话比“两个模块都有效”更强，也更容易过审，因为它不仅说有效，还说清楚了有效的方向。

### 4. 交互作用与边界

这组 2x2 结果里还有一个很重要的点：`双微调` 是最优，但 `只调大模型` 明显强于 `只调小模型`。

这意味着：

- 如果只能保留一项微调，应该优先保留 `planner FT`
- 如果追求最强论文主结果，应该保留 `双微调`
- 如果追求更低推理成本，可以把 `只调大模型` 视为高性价比备选

这在论文里可以自然写成 `quality-latency trade-off`，而不是把所有配置都硬塞进主表里。

### 5. 为什么 `edge_semantic_f1` 四组完全一样

四组消融里 `edge_semantic_f1` 都是 `0.6218`，这很异常但不一定是坏事。更安全的解读是：

- 当前 `edge_semantic_f1` 对这组 ablation 的变化不够敏感
- 或者当前图结构评估中，差异主要体现在节点、分组、挂载，而不是边

论文写作时不建议把 `edge_semantic_f1` 作为主结论指标，避免 reviewer 追问“为什么四组完全一样”。更推荐在主文里使用：

- `final_matches_reference`
- `canonicalized_match`
- `entity_semantic_f1`
- `completed_all_stages`
- `total_model_latency_ms`

---

## 二、按图类型的消融分析

图类型热力图见：

- [Ablation by Diagram Type: Final Match](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_final_match_heatmap.svg)
- [Ablation by Diagram Type: Entity F1](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_entity_f1_heatmap.svg)
- [Ablation by Diagram Type: Planner Latency (sec)](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_planner_latency_sec_heatmap.svg)

### 1. `flowchart` 几乎完全由 planner 微调驱动

这是最干净、最有说服力的类型级证据：

- 两个 `planner FT` 设置都是 `0.1923`
- 两个 `planner base` 设置都是 `0.0`

这类结果非常适合在论文中作为“模块作用机制”的案例型证据。

### 2. `mindmap` 同时受益于两种微调

`mindmap` 的 strict match 从 `0.0943` 一路抬到 `0.1887`，说明：

- planner 微调是主因
- gate 微调还能进一步把结果往上推一截

这种类型最能体现“互补”。

### 3. `architecture` 和 `sequence` 也能看出分工

- `sequence` 对 planner 微调也比较敏感
- `architecture` 在 strict exact match 上能看到一定 gate 作用

所以你们的方法不是只在最容易的图类上有效，而是在多个图类上都呈现出一致趋势。

### 4. `ER` 和 `StateDiagram` 是最自然的 limitation

四组设置中，这两类 strict match 都还是 `0.0`。这不意味着论文会被否，反而意味着你们应该在正文里主动承认：

- 该任务总体仍然很难
- 现阶段方法主要推进了 `mindmap / flowchart / architecture / sequence`
- `ER` 和 `StateDiagram` 仍然是未解决的主要难点

这样的写法会显著提升论文可信度。

---

## 三、最终组合与通用强基线的全量测试对比

总表与图见：

- [test_overall.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_overall.csv)
- [test_rankings.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_rankings.csv)
- [test_gain_vs_best_baseline.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_gain_vs_best_baseline.csv)
- [Full Test Topline Quality](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_topline_quality.svg)
- [Full Test Topline Latency (sec)](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_topline_latency_sec.svg)
- [Full Test: Final Match Ranking](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_final_match_rank.svg)
- [Full Test: Entity F1 Ranking](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_entity_f1_rank.svg)

### 1. 最终结论：最终组合已经显著超过通用先进大模型

最终 LocalHF 组合在 `test_full_public_clean` 上达到：

- `final_matches_reference = 0.1086`
- `canonicalized_match = 0.1118`
- `entity_semantic_f1 = 0.4584`

对比当前工作区里最强的通用基线：

- best baseline `final_match = 0.0415`
- best baseline `canonicalized = 0.0479`
- best baseline `entity_f1 = 0.2990`

也就是说：

- strict exact match 提升 `+0.0671`
- canonicalized match 提升 `+0.0639`
- entity F1 提升 `+0.1594`

如果换成相对提升：

- strict exact match 约 `+161.7%`
- canonicalized match 约 `+133.4%`
- entity F1 约 `+53.3%`

这不是边缘提升，而是量级上的跃升。

### 2. 严格匹配条数更直观

在 `313` 条 full test 样本上：

- LocalHF 最终组合 strict exact match 约 `34 / 313`
- 最强基线 strict exact match 约 `13 / 313`

也就是说，最终组合大致比最强通用基线多命中 `21` 条样本。对于这种高难任务，这个差距是很有说服力的。

### 3. 最终组合赢在什么地方

#### 3.1 赢在 strict / canonicalized 两个最硬的指标

这两个指标最适合撑论文主结论，因为它们比“语义接近”更难，也更不容易被 reviewer 质疑。

#### 3.2 赢在节点、分组和挂载语义

最终 LocalHF 组合在以下指标上都是当前工作区第一：

- `node_semantic_f1 = 0.6714`
- `group_semantic_f1 = 0.8797`
- `attachment_semantic_f1 = 0.7444`
- `entity_semantic_f1 = 0.4584`

尤其 `node_semantic_f1` 相对最强基线提升约 `58.1%`，这说明增量 graph generation 的主要难点确实更多集中在“对象语义与结构组织”，而不仅仅是画出边。

#### 3.3 赢在 gate 延迟

最终组合的 `gate_latency_mean_ms = 2129.79`，是所有对比系统中最低的。

这意味着：

- 你们不是简单把整个系统都做慢了才换来效果
- 真正的成本集中在 planner，而不是触发控制层

这个点对 rebuttal 很重要，因为它能帮助你们解释“为什么系统分层是合理的”。

### 4. 最终组合没有赢在哪

#### 4.1 不是最快的整体系统

从 `total_model_latency_ms` 看，最终组合明显慢于：

- `Qwen3.5-Plus`
- `Qwen3.5-27B`
- `GPT-5.4`

所以主文中不应该把你们包装成“质量和速度都第一”。更稳妥的说法是：

> 我们的方法在牺牲部分 planner 推理时延的前提下，显著提升了增量图生成的严格一致性与语义保真度。

#### 4.2 Planner 是主要成本来源

最终组合的 `planner_latency_mean_ms = 24300.95`，远高于一些商业基线。这个 trade-off 要主动写，不要让 reviewer 替你指出来。

### 5. Full test 的图类型分析

图类型对比见：

- [Full Test by Diagram Type: Final Match](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_by_type_final_match_heatmap.svg)
- [Full Test by Diagram Type: Entity F1](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_by_type_entity_f1_heatmap.svg)
- [test_by_type_final_match.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_by_type_final_match.csv)
- [test_by_type_entity_f1.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_by_type_entity_f1.csv)

关键观察：

- `architecture`：最终组合是当前对比系统里唯一 strict exact match 大于 0 的方法
- `flowchart`：最终组合 `0.2115`，而工作区中所有通用基线都是 `0.0`
- `mindmap`：最终组合 `0.3774`，显著高于最佳通用基线 `0.2453`
- `sequence`：最终组合 `0.0392`，基线在当前工作区里全部 `0.0`
- `ER` 与 `StateDiagram`：strict exact match 仍然是 `0.0`

更重要的是，即使在 strict match 仍然没有突破的类型上，最终组合的语义质量依然领先：

- `ER entity_f1 = 0.4698`
- `StateDiagram entity_f1 = 0.3876`

这让你们可以在论文里非常自然地写：

> 虽然某些高难图类上 strict exact match 仍未取得突破，但我们的方法已经能在这些类别上显著提升结构语义保真度。

---

## 四、质量-时延权衡该怎么写

建议把这篇论文里的效率叙事写成“权衡”而不是“全面领先”。

参考图：

- [Full Test: Final Match vs Total Latency](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_quality_latency_scatter_final_match.svg)
- [Full Test: Entity F1 vs Total Latency](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_quality_latency_scatter_entity_f1.svg)
- [test_pareto_frontier.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_pareto_frontier.csv)

比较稳的表述方式是：

- 如果目标是最低成本批量跑数，`Qwen3.5-Plus` 和 `Qwen3.5-27B` 更快。
- 如果目标是增量 graph generation 的严格正确性和语义质量，Stream2Graph local 明显更强。
- 因此，本文方法建立的是一个新的任务特定质量上限，而不是单纯的通用低延迟方案。

这套说法比“我们全面优于所有模型”更可信，也更安全。

---

## 五、论文写作指导

### 1. 贡献点怎么定

我建议把贡献点压缩成 3 条，不要太散：

1. 我们提出了一个面向对话驱动增量图生成的 benchmark 与评测协议。
2. 我们提出了一个 staged gate-planner 增量生成框架。
3. 我们通过 2x2 消融和 full test 对比表明，小模型微调主要提升阶段控制稳定性，大模型微调主要提升最终图结构与语义保真度，联合微调取得最佳结果。

### 2. 主文结果怎么排

建议顺序：

1. 任务定义
2. Benchmark 与数据集分析
3. 方法
4. 实验设置
5. 主结果
6. 消融实验
7. 误差分析与讨论

不要把消融放在主结果前面。主结果先回答“你们到底强不强”，消融再回答“为什么强”。

### 3. 主文最值得放的表

#### 主表 1：最终组合 vs 通用强基线

推荐只放：

- `completed_all_stages`
- `final_matches_reference`
- `canonicalized_match`
- `entity_semantic_f1`
- `total_model_latency_ms`

这是信息密度最高、最不容易让读者迷路的一组指标。

#### 主表 2：2x2 消融

推荐放：

- `completed_all_stages`
- `final_matches_reference`
- `canonicalized_match`
- `entity_semantic_f1`
- `gate_latency_mean_ms`
- `total_model_latency_ms`

这样就能同时体现模块分工和效率代价。

### 4. 主文最值得放的图

我建议优先考虑这几张：

1. [Ablation Overall Quality](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_quality_overall.svg)  
   用于消融小节，直观展示四组质量层级。

2. [Ablation Main Effects on Quality](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_main_effects_quality.svg)  
   用于强调 gate / planner 的非对称分工。

3. [Full Test: Final Match Ranking](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_final_match_rank.svg)  
   用于主结果，最直接。

4. [Full Test: Entity F1 Ranking](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_entity_f1_rank.svg)  
   用于补充语义层证据。

5. [Full Test: Final Match vs Total Latency](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_quality_latency_scatter_final_match.svg)  
   用于讨论质量-时延权衡。

6. [Full Test by Diagram Type: Final Match](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_by_type_final_match_heatmap.svg)  
   用于附录或正文一角，说明收益不是单一图类支撑出来的。

### 5. 可以直接拿去改写成论文的文字骨架

#### 消融实验段落骨架

> 为分析两个微调模块的作用，我们在 validation split 上进行了一个 2x2 消融实验，分别考察 gate 模型与 planner 模型是否使用任务特定微调。结果表明，两类微调具有明显的非对称互补性。具体而言，planner 微调主要提升最终图的严格一致性与语义保真度，而 gate 微调主要改善阶段完成率、覆盖率及 gate 推理效率。联合微调在所有质量指标上取得最佳结果，说明二者在增量图生成中承担着不同但互补的功能。

#### 主结果段落骨架

> 在 public-clean full test split 上，我们的最终 LocalHF staged incremental system 显著超过多种先进通用大模型基线。在 strict exact match、canonicalized match 与 entity semantic F1 等关键指标上，本文方法均取得当前最优结果。尤其是在 flowchart、mindmap、architecture 与 sequence 等图类上，我们的方法展现出明显优势。这表明，针对增量图生成任务进行结构化系统设计与任务特定微调，能够显著提升最终图结构与语义保真度。

#### 局限性段落骨架

> 尽管本文方法在多个图类上取得显著提升，但任务仍远未被完全解决。特别是在 ER 与 StateDiagram 上，strict exact match 仍然较低，说明这些图类中的结构约束与语义映射仍然具有明显挑战。此外，planner 微调带来了较高的推理时延，未来工作可进一步探索更高效的路由、蒸馏或结构约束解码策略。

### 6. 哪些地方最容易被 reviewer 追问

你在正文里最好主动回答这几件事：

- 为什么这是一个真实且重要的任务，而不是人为构造的 benchmark
- 为什么 staged gate-planner 分解是必要的，而不是工程复杂化
- `entity_semantic_f1` 的定义是什么，为什么它和其他指标一起有意义
- 为什么 Gemini 采用 rerun2 结果而不是原始 public-clean run
- 为什么 `edge_semantic_f1` 在多组实验里几乎不变

这些点如果主动写，rebuttal 压力会小很多。

---

## 六、你现在最应该做的几件事

1. 把主结果表和消融表先固定下来  
先别继续扩指标，把主叙事收紧。

2. 对 full test 的最终组合做一次 paired significance  
尤其是 strict exact match 和 entity F1，相比最强 baseline 很值得做显著性检验。

3. 在论文中把 `ER` 和 `StateDiagram` 的失败模式单独分析  
这会让论文可信度明显提高。

4. 明确 `entity_semantic_f1` 的公式与解释  
最好加 1 个小例子。

5. 保留质量-时延 trade-off 的诚实表述  
不要把论文写成“我们又快又准全都赢”，那样反而容易被抓漏洞。

---

## 七、产物索引

### 数据表

- [ablation_overall.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_overall.csv)
- [ablation_main_effects.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_main_effects.csv)
- [ablation_count_estimates.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_count_estimates.csv)
- [ablation_by_type_final_match.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_by_type_final_match.csv)
- [ablation_by_type_entity_f1.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_by_type_entity_f1.csv)
- [ablation_by_type_planner_latency_sec.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/ablation_by_type_planner_latency_sec.csv)
- [test_overall.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_overall.csv)
- [test_rankings.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_rankings.csv)
- [test_gain_vs_best_baseline.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_gain_vs_best_baseline.csv)
- [test_pareto_frontier.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_pareto_frontier.csv)
- [test_by_type_final_match.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_by_type_final_match.csv)
- [test_by_type_entity_f1.csv](../../artifacts/evaluation/localhf_incremental_analysis/data/test_by_type_entity_f1.csv)

### 图表

- [ablation_quality_overall.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_quality_overall.svg)
- [ablation_latency_overall_sec.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_latency_overall_sec.svg)
- [ablation_main_effects_quality.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_main_effects_quality.svg)
- [ablation_main_effects_latency_sec.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_main_effects_latency_sec.svg)
- [ablation_by_type_final_match_heatmap.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_final_match_heatmap.svg)
- [ablation_by_type_entity_f1_heatmap.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_entity_f1_heatmap.svg)
- [ablation_by_type_planner_latency_sec_heatmap.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/ablation_by_type_planner_latency_sec_heatmap.svg)
- [test_final_match_rank.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_final_match_rank.svg)
- [test_entity_f1_rank.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_entity_f1_rank.svg)
- [test_topline_quality.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_topline_quality.svg)
- [test_topline_latency_sec.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_topline_latency_sec.svg)
- [test_quality_latency_scatter_final_match.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_quality_latency_scatter_final_match.svg)
- [test_quality_latency_scatter_entity_f1.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_quality_latency_scatter_entity_f1.svg)
- [test_by_type_final_match_heatmap.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_by_type_final_match_heatmap.svg)
- [test_by_type_entity_f1_heatmap.svg](../../artifacts/evaluation/localhf_incremental_analysis/charts/test_by_type_entity_f1_heatmap.svg)
