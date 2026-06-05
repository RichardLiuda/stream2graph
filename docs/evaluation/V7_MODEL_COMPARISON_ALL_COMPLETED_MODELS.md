# V7 已完成模型总对比

## 范围与口径

本文统一比较当前已经完整跑完、并且已经整理出最终可用结果的 6 个模型：

- Kimi 2.5
- MiniMax 2.5
- Gemini 3 Flash
- Qwen 3.5 Thinking Off
- Qwen 3.5 Thinking On
- Claude Sonnet 4.5

统一比较口径如下：

- 数据集：`release_v7_kimi_k25_fullregen_strict_20260313`
- split：`test`
- 样本数：`963`
- 最终质量指标一律使用最终可用结果
- 对有 repair 的模型，质量分数来自 repair 后的 `merged` 结果
- `first_pass_failures` 表示第一次全量推理时失败的样本数
- `final_failures` 表示纳入最终对比表之后仍然失败的样本数
- 延迟统计基于最终结果中成功样本的 `latency_ms`

这份文档的核心目的是把三件事拆开讲清楚：

1. 模型本身的最终图质量谁更强。
2. 首轮跑完的稳定性谁更强。
3. 为了拿到最终结果，各模型需要付出多少 repair 成本。

## 一页结论

如果只看最终离线质量，当前最强的是 `Claude Sonnet 4.5`，它在 `normalized_similarity`、`line_f1`、`token_f1`、`node_f1`、`edge_f1` 和 `compile_success` 上都是第一。

如果看“质量上界但不太省心”，`Kimi 2.5` 仍然非常强，几乎所有结构指标都排在第二，而且 `label_f1` 仍然是六个模型里最高。

如果看综合平衡，`Gemini 3 Flash` 是最干净的一档：首轮 `0` 失败，不需要 repair，质量又明显高于 `MiniMax` 和 `Qwen on`，也和 `Qwen off`、`Kimi` 比较接近。

如果看速度和部署友好度，`Qwen 3.5 Thinking Off` 依然最有优势。它不仅首轮 `0` 失败，而且平均延迟和 P95 延迟都远低于其他模型。

最值得注意的是 `Qwen on vs Qwen off`：在这套 V7 任务上，`thinking on` 并没有带来更好的最终结果，反而更慢、首轮失败更多、最终质量也略低于 `thinking off`。这说明“把 thinking 打开”并不自动等于更适合这个任务。

## 运行与稳定性

| 模型 | 接口 / 配置 | Thinking 设置 | First Pass Failures | Final Failures | Mean Latency (ms) | P50 (ms) | P95 (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Kimi 2.5 | Moonshot 官方接口 | provider default | 39 | 0 | 87830.2 | 81340.4 | 165942.2 |
| MiniMax 2.5 | MiniMax 兼容接口 | provider default | 3 | 0 | 22253.0 | 16979.2 | 52131.9 |
| Gemini 3 Flash | Google 官方接口 | `thinking_level=high` | 0 | 0 | 26323.4 | 12939.7 | 83216.1 |
| Qwen 3.5 Thinking Off | DashScope 兼容接口 | `enable_thinking=false` | 0 | 0 | 6680.8 | 5068.7 | 17444.5 |
| Qwen 3.5 Thinking On | DashScope 兼容接口 | `enable_thinking=true` | 39 | 0 | 86229.8 | 83164.1 | 139926.1 |
| Claude Sonnet 4.5 | 第三方 Claude 兼容网关 | provider default | 59 | 0 | 20634.6 | 9255.0 | 76930.6 |

### 运行侧解读

`Qwen off` 是当前最省心的一档。它首轮 `0` 失败，而且速度断层领先，说明它非常适合做大规模批量实验、回归测试和成本敏感场景。

`Gemini 3 Flash` 也很稳。它虽然速度不如 `Qwen off`，但同样首轮 `0` 失败，而且质量明显更高，所以是很强的综合型候选。

`MiniMax 2.5` 属于工程友好的稳健型选手。它首轮只失败 `3` 条，repair 成本很低，说明 provider 稳定性不错。

`Kimi 2.5` 和 `Qwen on` 的共同问题是慢，而且首轮都失败了 `39` 条。区别在于，`Kimi` 至少把这种代价转化成了更高的最终质量，而 `Qwen on` 没有明显兑现这一点。

`Claude Sonnet 4.5` 的最终质量最强，但首轮失败高达 `59` 条，说明它当前更依赖 repair 和节流策略。它不是“不能用”，而是“要想跑得漂亮，需要平台把限流和失败补跑托住”。

## 最终离线质量

| 模型 | Exact Match | Type Match | Norm Sim | Line F1 | Token F1 | Node F1 | Edge F1 | Label F1 | Compile Success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Kimi 2.5 | 0.0187 | 0.6947 | 0.4953 | 0.3759 | 0.7575 | 0.7633 | 0.6597 | 0.5583 | 0.3001 |
| MiniMax 2.5 | 0.0093 | 0.5867 | 0.3922 | 0.2828 | 0.6107 | 0.6202 | 0.5204 | 0.4263 | 0.2690 |
| Gemini 3 Flash | 0.0166 | 0.7342 | 0.4859 | 0.3676 | 0.7484 | 0.7503 | 0.6384 | 0.5264 | 0.3323 |
| Qwen 3.5 Thinking Off | 0.0239 | 0.7404 | 0.4685 | 0.3742 | 0.7364 | 0.7461 | 0.6399 | 0.5149 | 0.3032 |
| Qwen 3.5 Thinking On | 0.0062 | 0.6968 | 0.4464 | 0.3479 | 0.7308 | 0.7363 | 0.6267 | 0.5219 | 0.2835 |
| Claude Sonnet 4.5 | 0.0239 | 0.7394 | 0.5013 | 0.4045 | 0.7618 | 0.7650 | 0.6666 | 0.5298 | 0.3520 |

### 质量侧解读

`Claude Sonnet 4.5` 是当前最强模型。它不仅整体相似度最高，结构行级匹配、节点、边、可编译率也都领先。这说明它在“理解对话后生成可执行 Mermaid”这件事上，整体最接近理想状态。

`Kimi 2.5` 非常接近 `Claude`，而且在 `label_f1` 上仍然是第一。这说明 Kimi 对图上语义标签的保真度最好，特别适合强调语义信息保留的分析。

`Gemini 3 Flash` 的位置很稳。它没有像 `Claude` 那样冲到第一，但在 `compile_success` 上仅次于 `Claude`，而且没有首轮失败，这让它在真实实验流程里非常有竞争力。

`Qwen off` 的表现其实比很多直觉更强。它在 `Type Match` 上是第一，在 `Line F1` 和 `Edge F1` 上也非常接近 `Kimi` 和 `Gemini`。这说明它很擅长快速抓住图的外轮廓和主要结构关系。

`Qwen on` 是这次最值得反思的一组结果。打开 thinking 之后，它没有超过 `Qwen off`，反而在 `Norm Sim`、`Line F1`、`Edge F1`、`Compile Success` 上都更低，运行代价却显著更高。

`MiniMax 2.5` 最适合被解读为“稳定基线”，而不是“质量冠军”。它不是不能做，而是在几乎所有关键质量指标上都明显落后于前五者。

## 关键维度冠军

| 维度 | 当前最佳模型 | 说明 |
| --- | --- | --- |
| 首轮稳定性 | Gemini 3 Flash / Qwen 3.5 Off | 两者首轮都是 `0` 失败 |
| 最终整体相似度 | Claude Sonnet 4.5 | `normalized_similarity=0.5013` |
| 行级结构质量 | Claude Sonnet 4.5 | `line_f1=0.4045` |
| 节点结构质量 | Claude Sonnet 4.5 | `node_f1=0.7650` |
| 边结构质量 | Claude Sonnet 4.5 | `edge_f1=0.6666` |
| 标签保真度 | Kimi 2.5 | `label_f1=0.5583` |
| 图类型判断 | Qwen 3.5 Off | `diagram_type_match=0.7404` |
| 可编译性 | Claude Sonnet 4.5 | `compile_success=0.3520` |
| 速度 | Qwen 3.5 Off | 平均与 P95 延迟都最低 |
| 最稳工程基线 | MiniMax 2.5 | 首轮失败低、repair 成本低 |

## Qwen Off 与 Qwen On 的直接对比

这组结果对后续实验设计非常重要。

| 模型 | First Pass Failures | Mean Latency (ms) | Norm Sim | Line F1 | Edge F1 | Compile Success |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen 3.5 Thinking Off | 0 | 6680.8 | 0.4685 | 0.3742 | 0.6399 | 0.3032 |
| Qwen 3.5 Thinking On | 39 | 86229.8 | 0.4464 | 0.3479 | 0.6267 | 0.2835 |

这个对比说明，在当前 prompt、当前 provider、当前任务分布上，`thinking on` 并没有带来收益，反而带来了三类负面效果：

- 首轮稳定性显著变差。
- 推理成本和等待时间显著变高。
- 最终结构质量还略有下降。

所以如果后续还继续评测 `Qwen 3.5`，默认主表应该优先保留 `thinking off`，而把 `thinking on` 放到消融或附录里。

## 分模型结论

### Claude Sonnet 4.5

当前最强的最终质量模型。它很适合当“质量上界”参考，但使用时必须配合节流和 failed-only repair，否则首轮失败会比较多。

### Kimi 2.5

最接近 Claude 的高质量模型，尤其在标签保真度上最好。缺点是慢，而且首轮失败明显多于稳健型模型。

### Gemini 3 Flash

综合最平衡。质量强、可编译率高、首轮 `0` 失败，非常适合做主力对照模型。

### Qwen 3.5 Thinking Off

速度最佳、部署最轻、首轮最稳之一。它非常适合做批量实验和低成本基线，而且质量并不弱。

### Qwen 3.5 Thinking On

已经通过两轮 repair 修到最终 `0` 失败，但结果表明 thinking on 在这套任务里并不划算，更适合放在消融结果里解释。

### MiniMax 2.5

稳定、便宜、repair 成本低，适合作为工程基线或保守对照，但不适合代表当前最强质量上限。

## 论文或汇报中的推荐写法

如果写论文主表，建议不要把所有信息压缩成一个总分，而是至少拆成两张表：

- 运行表：`first_pass_failures`、`final_failures`、`mean_latency_ms`、`p95_latency_ms`
- 质量表：`normalized_similarity`、`line_f1`、`edge_f1`、`compile_success`

这样能更清楚地说明：

1. `Claude` 和 `Kimi` 更像质量上界模型。
2. `Gemini 3 Flash` 是综合平衡最好的候选。
3. `Qwen off` 是最快、最稳、最适合大规模批量跑的方案。
4. `Qwen on` 这次并没有证明 thinking 对该任务有益。
5. `MiniMax` 更适合作为稳定工程基线，而不是最终质量冠军。

## Source of Truth

- Kimi 最终结果：`reports/evaluation/runs/openai_compatible/moonshot_kimi_k25_v7_test_full/repair_retry1`
- MiniMax 最终结果：`reports/evaluation/runs/anthropic/minimax_m25_v7_test_full/repair_retry1`
- Gemini 最终结果：`reports/evaluation/runs/google/gemini3flash_v7_test_full_retry1`
- Qwen off 最终结果：`reports/evaluation/runs/openai_compatible/qwen35plus_dashscope_v7_test_full_thinking_off`
- Qwen on 最终结果：`reports/evaluation/runs/openai_compatible/qwen35plus_dashscope_v7_test_full_thinking_on_retry3/repair_retry2`
- Claude 最终结果：`reports/evaluation/runs/openai_compatible/claude_sonnet45_v7_test_full/repair_retry2`
