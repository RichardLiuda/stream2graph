# V7 已完成模型对比：Kimi 2.5 / MiniMax 2.5 / Gemini 3 Flash / Qwen 3.5 Thinking Off

## 范围与口径

本文比较当前已经完整跑完并产出最终可用结果的 4 个模型：

- Kimi 2.5
- MiniMax 2.5
- Gemini 3 Flash
- Qwen 3.5 Thinking Off

统一比较口径如下：

- 数据集：`release_v7_kimi_k25_fullregen_strict_20260313`
- split：`test`
- 样本数：`963`
- Kimi 与 MiniMax 采用修补后的最终 merged 结果
- Gemini 与 Qwen off 采用一次正式 full run 的最终结果
- `first_pass_failure` 表示第一次全量跑时的推理失败数
- `final_failure` 表示纳入最终结果表之后仍然失败的样本数
- 延迟统计基于最终成功样本的 `latency_ms`

这份对比要强调两件事：

1. 不能只看单一质量分数，要同时看可用性、延迟和修补成本。
2. Kimi 和 MiniMax 的最终质量分数已经是修补后的最终口径，因此讨论时要把“首轮稳定性”和“最终质量”分开。

## 一页结论

如果只看最终图质量，`Kimi 2.5` 是当前最强模型，几乎所有核心结构指标都是第一。

如果看综合平衡，`Gemini 3 Flash` 是最均衡的模型：首轮 `0` 失败、质量接近 Kimi，而且 `compile_success` 还是四者中最高。

如果看速度和运行成本，`Qwen 3.5 Thinking Off` 最有优势。它的平均延迟明显最低，首轮也没有失败，而且 `diagram_type_match` 是四者最高。

`MiniMax 2.5` 更适合作为稳定基线。它的首轮失败很少，修补成本低，但离线质量明显落后于另外三者。

## 运行与稳定性对比

| 模型 | Provider / 接口 | Thinking 设置 | 首轮失败数 | 最终失败数 | 平均延迟(ms) | P50(ms) | P95(ms) | 运行侧解读 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Kimi 2.5 | Moonshot 官方接口 | provider default | 39 | 0 | 87830.2 | 81340.4 | 165242.0 | 质量最强，但首轮稳定性最差，且延迟最高 |
| MiniMax 2.5 | MiniMax Anthropic 兼容接口 | provider default | 3 | 0 | 22253.0 | 16979.2 | 51558.1 | 首轮很稳，修补成本低，工程上最像稳健基线 |
| Gemini 3 Flash | Google 官方接口 | `thinking_level=high` | 0 | 0 | 26323.4 | 12939.7 | 83111.3 | 首轮稳定性最好之一，质量和可编译性都很强 |
| Qwen 3.5 Thinking Off | DashScope 兼容接口 | `enable_thinking=false` | 0 | 0 | 6680.8 | 5068.7 | 17156.0 | 速度显著最好，首轮无失败，部署友好度很高 |

### 运行侧怎么读

`Kimi 2.5` 的问题不是“模型不会做”，而是第一次全量高并发跑的时候更容易出现请求层超时。它最后可以通过 failed-only repair 修到 `0` 失败，但这说明它对调度、重试、超时和并发参数更敏感。

`MiniMax 2.5` 的运行侧特征非常清楚：第一次只失败 `3` 条，说明它的 provider 稳定性和请求完成率都不错。对于需要频繁重复实验的场景，它的运维成本会更低。

`Gemini 3 Flash` 和 `Qwen off` 这次都实现了首轮 `0` 失败。其中 Gemini 的延迟不算低，但它至少不需要额外 repair；Qwen 则是在“速度”和“首轮可用性”两个维度同时表现很好。

## 离线质量对比

| 模型 | Exact Match | Type Match | Norm Sim | Line F1 | Token F1 | Node F1 | Edge F1 | Label F1 | Compile Success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Kimi 2.5 | 0.0187 | 0.6947 | 0.4953 | 0.3759 | 0.7575 | 0.7633 | 0.6597 | 0.5583 | 0.3001 |
| MiniMax 2.5 | 0.0093 | 0.5867 | 0.3922 | 0.2828 | 0.6107 | 0.6202 | 0.5204 | 0.4263 | 0.2690 |
| Gemini 3 Flash | 0.0166 | 0.7342 | 0.4859 | 0.3676 | 0.7484 | 0.7503 | 0.6384 | 0.5264 | 0.3323 |
| Qwen 3.5 Thinking Off | 0.0239 | 0.7404 | 0.4685 | 0.3742 | 0.7364 | 0.7461 | 0.6399 | 0.5149 | 0.3032 |

### 质量侧怎么读

`Kimi 2.5` 在 `normalized_similarity`、`line_f1`、`token_f1`、`node_f1`、`edge_f1`、`label_f1` 这 6 个核心质量指标上都是第一。这说明它不只是“输出更像 Mermaid”，而是在图的语义结构、节点关系和标签保真度上都更接近参考答案。

`Gemini 3 Flash` 的最大亮点是 `compile_success=0.3323`，这是四者中最高的。也就是说，虽然它在绝大多数结构分上略低于 Kimi，但它更容易生成真正能被 Mermaid 编译器接受的结果。对于最终系统落地来说，这一点非常重要。

`Qwen 3.5 Thinking Off` 的表现很有意思。它的 `diagram_type_match=0.7404` 是四者最高，`line_f1=0.3742` 也几乎追平 Kimi，说明它对“图的大轮廓”和“图类型判断”其实很强。但它在 `normalized_similarity`、`label_f1` 和 `compile_success` 上仍落后于 Gemini 与 Kimi，说明它更像是一个高效率、强轮廓建模的选手，而不是最强的终局质量模型。

`MiniMax 2.5` 则比较明显地落在第四位。它并不是不能完成任务，而是几乎所有结构指标都显著低于另外三者，尤其是 `normalized_similarity`、`line_f1`、`node_f1`、`edge_f1` 和 `label_f1`。这使它更适合做稳健基线，而不是当前最有竞争力的质量上界。

## 分模型详细解读

### Kimi 2.5

Kimi 2.5 的结论可以概括为：`最终质量第一，但获取这份质量的代价最高。`

它在所有核心结构指标上都领先，尤其是：

- `normalized_similarity=0.4953`
- `edge_f1=0.6597`
- `label_f1=0.5583`

这三个指标放在一起看，说明 Kimi 对“图中关系怎么连”“边上的文字怎么保留”“最终整体结构有多像参考图”都有明显优势。

但它的缺点同样突出：

- 首轮失败 `39` 条
- 平均延迟 `87830.2 ms`
- P95 延迟 `165242.0 ms`

所以 Kimi 更像是“质量上界模型”。如果目标是论文主结果里的最好质量，它非常有价值；但如果目标是便宜、快速、可以反复多轮实验的工程基线，它的成本偏高。

### MiniMax 2.5

MiniMax 2.5 的核心定位不是最强质量，而是稳定基线。

它的优点是：

- 首轮只失败 `3` 条
- failed-only repair 成本很低
- 平均延迟只有 `22253.0 ms`

这意味着它在大规模批量测试时，整体实验摩擦会比 Kimi 小很多。

但它的质量短板也很明确：

- `normalized_similarity=0.3922`
- `line_f1=0.2828`
- `edge_f1=0.5204`
- `compile_success=0.2690`

这些数值和其余三者相比有比较明显的差距。因此 MiniMax 最适合扮演“稳定、可重复、可控”的工程基线，而不是当前最好的最终模型。

### Gemini 3 Flash

Gemini 3 Flash 的特点是：`综合平衡最好。`

它的运行侧表现很干净：

- 首轮 `0` 失败
- 最终 `0` 失败
- 不需要额外 repair

质量侧也相当强：

- `normalized_similarity=0.4859`
- `edge_f1=0.6384`
- `compile_success=0.3323`

Gemini 与 Kimi 的关系不是“完全同一类型的第一第二”，而更像是：

- Kimi 更偏向最终语义结构质量
- Gemini 更偏向稳定输出可编译 Mermaid

如果把质量、稳定性和后处理成本一起看，Gemini 3 Flash 很可能是目前四者里最均衡的一档。

### Qwen 3.5 Thinking Off

Qwen off 的特点是：`速度最好，而且质量并不差。`

它在运行侧的优势最明显：

- 首轮 `0` 失败
- 平均延迟 `6680.8 ms`
- P95 延迟 `17156.0 ms`

这是四者里最轻快的一条链路。

质量上它也不是简单意义上的“便宜但差”，因为：

- `diagram_type_match=0.7404` 是第一
- `line_f1=0.3742` 非常接近 Kimi
- `edge_f1=0.6399` 也和 Gemini 接近

但它的问题在于终局质量仍然略逊：

- `normalized_similarity` 低于 Kimi 与 Gemini
- `label_f1` 低于 Kimi 与 Gemini
- `compile_success` 低于 Gemini

所以 Qwen off 更适合“快速、大批量、低成本”的评测或产品化 baseline，而不是当前最强的最终质量方案。

## 谁在什么维度上最强

| 维度 | 当前最佳模型 | 说明 |
| --- | --- | --- |
| 首轮稳定性 | Gemini 3 Flash / Qwen off | 两者都是首轮 `0` 失败 |
| 最终语义相似度 | Kimi 2.5 | `normalized_similarity` 第一 |
| 文本行级结构质量 | Kimi 2.5 | `line_f1` 略高于 Qwen off |
| 节点与边结构质量 | Kimi 2.5 | `node_f1`、`edge_f1` 都是第一 |
| 标签保真度 | Kimi 2.5 | `label_f1` 第一 |
| 图类型判断 | Qwen off | `diagram_type_match` 第一 |
| Mermaid 可编译性 | Gemini 3 Flash | `compile_success` 第一 |
| 速度 | Qwen off | 平均延迟和 P95 都最优 |
| 稳健基线价值 | MiniMax 2.5 | 首轮失败低、修补成本低 |

## 对论文或汇报的建议写法

如果要写论文主表，建议不要只给一个总分，而是至少拆成两张表：

- 运行侧：首轮失败数、最终失败数、平均延迟、P95 延迟
- 质量侧：`normalized_similarity`、`line_f1`、`edge_f1`、`compile_success`

这样才能把几个关键事实同时讲清楚：

1. `Kimi 2.5` 是当前质量上界。
2. `Gemini 3 Flash` 是当前最均衡的模型，尤其在可编译性上领先。
3. `Qwen off` 的速度优势非常明显，且整体质量并不弱。
4. `MiniMax 2.5` 更适合作为稳定工程基线，而不是最终质量冠军。

如果只保留一句总括，可以写成：

> Kimi 2.5 achieved the strongest overall structural fidelity, Gemini 3 Flash provided the best balance between robustness and compilability, Qwen 3.5 with thinking disabled offered the fastest inference while maintaining competitive structure quality, and MiniMax 2.5 served as a stable engineering baseline with lower output fidelity.

## 结果解释上的注意事项

有三点需要特别避免混淆：

第一，Kimi 和 MiniMax 的最终结果来自 repair 后的 merged 口径，因此文中不能把它们的最终质量直接当作“首轮即可得到的质量”。

第二，`compile_success` 不等于“模型理解得最好”，它反映的是生成结果是否足够符合 Mermaid 编译器要求。因此 Gemini 在这个维度领先，说明它的输出更接近可直接渲染的系统目标。

第三，Qwen 当前比较的是 `thinking off` 版本，因此这个结果代表的是“关闭 thinking 后的 Qwen 运行与质量特征”，不能自动外推到 `thinking on`。

## 源文件

- Kimi 最终报告：`reports/evaluation/runs/openai_compatible/moonshot_kimi_k25_v7_test_full/repair_retry1/report/benchmark_report.json`
- Kimi 最终 summary：`reports/evaluation/runs/openai_compatible/moonshot_kimi_k25_v7_test_full/repair_retry1/offline/offline_metrics.summary.json`
- MiniMax 最终报告：`reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair_retry1/report/benchmark_report.json`
- MiniMax 最终 summary：`reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair_retry1/offline/offline_metrics.summary.json`
- Gemini 最终报告：`reports/evaluation/runs/google/gemini3flash_v7_test_full_retry1/report/benchmark_report.json`
- Gemini 最终 summary：`reports/evaluation/runs/google/gemini3flash_v7_test_full_retry1/offline/offline_metrics.summary.json`
- Qwen off 最终报告：`reports/evaluation/runs/openai_compatible/qwen35plus_dashscope_v7_test_full_thinking_off/report/benchmark_report.json`
- Qwen off 最终 summary：`reports/evaluation/runs/openai_compatible/qwen35plus_dashscope_v7_test_full_thinking_off/offline/offline_metrics.summary.json`
