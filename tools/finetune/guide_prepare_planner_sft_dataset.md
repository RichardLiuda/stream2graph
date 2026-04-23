# `prepare_planner_sft_dataset.py` 文件说明

对应源码：[prepare_planner_sft_dataset.py](/e:/Desktop/stream2graph/tools/incremental_finetune/prepare_planner_sft_dataset.py)

## 1. 这份文件在整条链里的位置

这份脚本位于当前增量微调主线的数据准备阶段，专门负责 planner 的 SFT 数据导出。

如果 gate 数据脚本解决的是“什么时候更新”，那么这份 planner 数据脚本解决的是：

“一旦决定更新，这一轮具体应该往图里加什么。”

整条局部链路可以压成：

`RuntimeSample -> 多条阶段级 planner 题 -> planner SFT JSONL`

## 2. 这份文件主要解决什么问题

planner 的职责不是输出完整最终 Mermaid，而是输出一种“增量规划结果”。  
它要学会的核心输出包括：

- `target_stage_index`
- `delta_ops`
- `notes`
- 可选 `target_graph_ir`

所以这份脚本真正要解决的问题是：

**如何把 benchmark 中每个阶段的 gold 结构增量，转换成大量结构化、可监督、可直接给模型学习的 planner 训练题。**

更细一点说，它要同时解决四件事：

第一，确定当前阶段之前模型“理论上已经听到”的对话上下文。  
第二，把 gold `StageState` 转成 planner assistant 目标 JSON。  
第三，把每个阶段都单独变成一条训练题，而不是只在样本级别做一条题。  
第四，让训练输入格式尽量与运行时 planner prompt 对齐。

所以它并不是简单地“导出样本”，而是在做：

**阶段级增量规划题的自动出题与标准答案构造。**

### 2.1 参数默认值总览

这份脚本的命令行参数虽然和 gate 数据脚本长得相似，但默认值已经明显体现了 planner 任务更重、上下文更长的特点。按源码里的 `parse_args()`，默认值如下：

- `--run-root`
  - 默认值：`data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean`
  - 含义：planner SFT 的 benchmark 根目录
- `--output-dir`
  - 默认值：无，必填
  - 含义：导出的 planner SFT 数据目录
- `--max-train-samples`
  - 默认值：`0`
  - 含义：`train` split 不设样本上限
- `--max-validation-samples`
  - 默认值：`0`
  - 含义：`validation` split 不设样本上限
- `--max-test-samples`
  - 默认值：`0`
  - 含义：`test` split 不设样本上限
- `--recent-turn-limit`
  - 默认值：`24`
  - 含义：planner 题目卡里最多保留最近 `24` 个 turn
- `--omit-target-graph`
  - 默认值：关闭，也就是默认 **保留** `target_graph_ir`
  - 含义：如果打开这个开关，就只监督 `delta_ops / notes`，不再让 assistant 目标携带完整下一阶段图快照

这里最值得你对比 gate 去记的是：

- gate 默认最近窗口是 `8`
- planner 默认最近窗口是 `24`

这直接体现了作者的任务判断：

- gate 主要做轻量时机判断
- planner 需要更长的对话上下文来规划结构动作

### 2.2 代码内部固定设置

除了 CLI 参数外，这份脚本还有一些会显著影响 planner 训练题形态的固定设置：

- `current_stage_index` 固定从 `0` 开始
  - 也就是每条样本默认都从空白初始阶段往前推
- 每个 `StageState` 固定生成一条训练题
  - 这意味着监督粒度是“阶段级”，不是“整样本级”
- `observed_turns` 的优先裁切策略固定是：
  1. 优先用 `sample.boundary_by_stage(stage.stage_index)`
  2. 如果没有 boundary，再退回 `turn.stage_index <= 当前 stage`
  - 这保证 planner 看到的上下文尽量贴着 gold 阶段边界
- split 处理顺序固定为：`train -> validation -> test`
- manifest 中固定写入：
  - `target_model = "Qwen/Qwen3.5-27B"`
  - `recent_turn_limit = args.recent_turn_limit`
  - `omit_target_graph = args.omit_target_graph`
  - 这说明作者默认把这份题库视为 `Qwen3.5-27B planner` 的训练数据
- `_target_payload(...)` 的固定输出骨架是：
  - 必含 `target_stage_index`
  - 必含 `delta_ops`
  - 必含 `notes`
  - 可选 `target_graph_ir`
  - 也就是说 planner SFT 的 assistant 目标格式在代码里是严格钉死的

## 3. 整体执行流程

这份脚本的主流程集中在 `main()` 和 `build_rows(...)` 中，顺序大致如下：

1. 通过 `parse_args()` 读取 benchmark 根目录、输出目录、各 split 样本上限、最近 turn 限制，以及是否省略 `target_graph_ir`。
2. 用 `SplitLimit(...)` 整理 `train / validation / test` 三个 split 的样本上限。
3. 依次处理 `train`、`validation`、`test` 三个 split。
4. 对每个 split 调用 `build_rows(...)`。
5. `build_rows(...)` 通过 `iter_samples(...)` 逐条读取 `RuntimeSample`。
6. 对每个 sample，从 `current_stage_index = 0` 开始，按 `sample.stages` 顺序逐阶段往前走。
7. 对当前 stage，优先查 `sample.boundary_by_stage(stage.stage_index)`。
8. 如果有显式 boundary，就把所有 `turn_id <= boundary.end_turn` 的 turn 作为 `observed_turns`。
9. 如果没有 boundary，就退回到“所有 `turn.stage_index <= 当前 stage` 的 turn”。
10. 调用 `planner_messages(...)` 生成 `system + user` 两段消息。
11. 调用 `_target_payload(stage, omit_target_graph)` 生成 assistant 标准答案 JSON。
12. 把当前阶段的 messages 和 metadata 组装成一条 row。
13. 把 `current_stage_index` 更新为当前 `stage.stage_index`。
14. 当前 split 的所有 rows 生成后，调用 `write_dataset_rows(...)` 写出对应 JSONL。
15. 所有 split 处理结束后，构造 `manifest`，再调用 `write_manifest(...)` 写出 `manifest.json`。

这说明它的职责非常明确：既做“阶段切题”，也做“上下文裁切”，还做“目标 JSON 组装与落盘”。

## 4. 辅助函数流程说明

### 4.1 `parse_args()`

- 负责读取脚本运行参数
- 控制 benchmark 路径、输出目录、split 上限、最近上下文长度、是否保留完整 target graph
- 服务于 `main()`

其中 `omit-target-graph` 是一个很重要的开关，因为它能直接影响训练样本长度和监督难度。

### 4.2 `_target_payload(stage, omit_target_graph)`

- 把一个 gold `StageState` 转成 planner assistant 的标准 JSON
- 必含字段：
  - `target_stage_index`
  - `delta_ops`
  - `notes`
- 可选字段：
  - `target_graph_ir`

它的作用是把“阶段真值”翻译成“模型要学的输出格式”。

### 4.3 `build_rows(run_root, split, max_samples, recent_turn_limit, omit_target_graph)`

- 是整份文件的核心函数
- 负责按 stage 展开一条 sample
- 决定当前阶段的 `observed_turns`
- 构造 planner 专用训练 row

这一步体现了 planner 训练最核心的设计：**一阶段一题，而不是一整条样本一题。**

### 4.4 `iter_samples(...)`（来自 `common.py`）

- 提供统一的增量 benchmark 样本迭代接口
- 为 `build_rows(...)` 提供 sample 输入

### 4.5 `planner_messages(...)`（来自 `common.py`）

- 统一构造 planner 的 `system + user` prompt
- 让训练时题面和运行时 planner 输入尽量一致
- 输入包括：
  - sample
  - current_stage_index
  - next_stage_index
  - observed_turns
  - recent_turn_limit

### 4.6 `write_dataset_rows(...)` 与 `write_manifest(...)`（来自 `common.py`）

- 分别负责写出 JSONL 数据和 manifest
- 把主流程里生成的 row 真正落盘

## 5. 输入是什么

输入是增量 benchmark 中的 `RuntimeSample`，而不是原始 Mermaid 文本。

这些 sample 需要至少包含：

- `stages`
- `turns`
- `stage_boundaries`

因为 planner 数据准备同时依赖：

- gold 阶段结构真值
- 当前阶段之前已经可见的对话上下文

## 6. 输出是什么

输出目录中会写出：

- `train.jsonl`
- `validation.jsonl`
- `test.jsonl`
- `manifest.json`

其中每条 JSONL 记录都是一条 planner 专用 chat-format SFT 样本，assistant 内容是 `PlannerOutput` 风格 JSON，而不是最终 Mermaid。

## 7. 这份文件和上下游怎么衔接

它的上游是：

- 增量 benchmark / `RuntimeSample`

它的下游是：

- [train_qwen3_lora.py](/e:/Desktop/stream2graph/tools/finetune/train_qwen3_lora.py)

整条局部链路可以写成：

`benchmark -> prepare_planner_sft_dataset.py -> planner SFT JSONL -> train_qwen3_lora.py`

## 8. 这份文件最值得学习的地方

这份脚本最值得学习的是：

- 如何把一条复杂样本拆成多条阶段级监督题
- 如何让训练上下文严格对齐阶段边界
- 如何训练结构化规划输出，而不是自由文本
- 如何让训练 prompt 与运行时 prompt 保持一致

## 9. 一句话总结

这份文件的作用，就是把增量 benchmark 中每个 gold 阶段的规划真值，转写成 planner 可学习的阶段级监督数据集。
