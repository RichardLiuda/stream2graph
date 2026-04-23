# `prepare_gate_sft_dataset.py` 文件说明

对应源码：[prepare_gate_sft_dataset.py](/e:/Desktop/stream2graph/tools/incremental_finetune/prepare_gate_sft_dataset.py)

## 1. 这份文件在整条链里的位置

这份脚本位于增量微调主线的最前面，负责把 benchmark 样本转成 `gate` 专用的监督式微调数据。

如果把整条链压成一句话，它负责的是：

`RuntimeSample -> 多条 gate 判断题 -> train / validation / test JSONL`

也就是说，它并不训练模型，也不评测模型，而是在做“出题”工作。  
它把原来一条复杂的增量样本，拆成很多条小题，每一条题都在问：

“对话已经听到这里了，现在该不该推进到下一阶段？”

## 2. 这份文件主要解决什么问题

`gate` 模型不是画图模型，而是一个“时机判断器”。  
它要学会的是：

- 当前应该继续等待，还是应该触发更新
- 如果触发，目标应该是哪一个阶段
- 为什么做出这个判断

所以这份文件要解决的核心问题，不是“把原始数据保存成 JSONL”这么简单，而是：

**如何把 benchmark 中关于“阶段边界何时到来”的 gold 规律，转换成大量可训练的、格式统一的 gate 决策题。**

更具体地说，它要同时解决三件事：

第一，把一条样本沿着 turn 时间轴展开。  
第二，在每一个 turn 前缀上，根据 gold boundary 生成 oracle 决策。  
第三，把这些 oracle 决策包装成 Qwen 可直接学习的 chat-format 样本。

所以你可以把这份文件理解成：

**把“阶段触发真值”翻译成“可用于微调的判断题题库”。**

### 2.1 参数默认值总览

这份脚本暴露给命令行的参数并不多，但每个参数都直接影响导出的题量和上下文范围。按源码里的 `parse_args()`，默认值如下：

- `--run-root`
  - 默认值：`data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean`
  - 含义：增量 benchmark 根目录，从这里读取 `RuntimeSample`
- `--output-dir`
  - 默认值：无，必填
  - 含义：导出的 gate SFT 数据目录
- `--max-train-samples`
  - 默认值：`0`
  - 含义：`train` split 最多读取多少条 sample；`0` 表示不设上限
- `--max-validation-samples`
  - 默认值：`0`
  - 含义：`validation` split 最多读取多少条 sample；`0` 表示不设上限
- `--max-test-samples`
  - 默认值：`0`
  - 含义：`test` split 最多读取多少条 sample；`0` 表示不设上限
- `--recent-turn-limit`
  - 默认值：`8`
  - 含义：写入 gate `user` 题目卡时，最近对话窗口最多保留 8 个 turn

如果你只从“实验规模”和“题目难度”两个角度去记，这里最关键的默认值就是：

- 数据源默认指向官方增量 benchmark 根目录
- 三个 split 默认都不裁样本
- gate 默认只看最近 `8` 个 turn

### 2.2 代码内部固定设置

除了命令行参数，这份脚本还有一些没有暴露成 CLI、但会直接影响输出样本形态的固定设置：

- `current_stage_index` 起始固定为 `0`
  - 表示所有样本都从“尚未完成任何阶段”的状态开始展开
- 枚举 turn 时固定使用 `enumerate(sample.turns, start=1)`
  - 也就是按 1-based 的 turn 计数来构造前缀题
- `_target_payload(...)` 中固定写入 `confidence = 1.0`
  - 说明当前 gate SFT 目标把 oracle 决策当作完全可信监督
- split 处理顺序固定为：`train -> validation -> test`
  - 这会影响导出日志和 manifest 中的统计顺序
- manifest 中固定写入：
  - `target_model = "Qwen/Qwen3.5-4B"`
  - `recent_turn_limit = args.recent_turn_limit`
  - 这说明作者默认把这份题库视为 `Qwen3.5-4B gate` 的训练数据
- `run_root` 最终会走公共层的默认回退：
  - `DEFAULT_INCREMENTAL_FINETUNE_RUN_ROOT`
  - `DEFAULT_INCREMENTAL_RUN_ROOT`
  - 当前两者实际都指向同一个公开增量 benchmark 目录

## 3. 整体执行流程

这份脚本的主流程集中在 `main()` 和 `build_rows(...)` 中，顺序大致如下：

1. 通过 `parse_args()` 读取 benchmark 根目录、输出目录、每个 split 的样本上限，以及 `recent_turn_limit`。
2. 用 `SplitLimit(...)` 把 `train / validation / test` 三种 split 的样本上限整理成统一对象。
3. 依次处理 `train`、`validation`、`test` 三个 split。
4. 对每个 split 调用 `build_rows(...)`。
5. `build_rows(...)` 内部先通过 `iter_samples(...)` 逐条读取 `RuntimeSample`。
6. 对每个 sample，从 `current_stage_index = 0` 开始，按 turn 顺序逐步展开。
7. 每到一个新 turn，都截取当前 `observed_turns = sample.turns[:turn_index]`。
8. 计算 `next_stage_index = current_stage_index + 1`，判断是否还有下一阶段。
9. 如果所有阶段都已完成，就生成一条 `WAIT + target_stage_index=None` 的样本。
10. 如果还有下一阶段，就查 `sample.boundary_by_stage(next_stage_index)`。
11. 如果当前 turn 已经达到该阶段 boundary 的 `end_turn`，就生成一条 `EMIT_UPDATE` 样本。
12. 否则生成一条 `WAIT` 样本，并说明正在等待该阶段边界。
13. 通过 `gate_messages(...)` 生成 `system + user` 两段消息。
14. 通过 `_target_payload(...)` 生成 assistant 标准答案 JSON。
15. 把 `messages` 和 `metadata` 打包成一条训练 row。
16. 如果当前 row 的 oracle action 是 `EMIT_UPDATE`，就同步推进 `current_stage_index`。
17. 当前 split 的所有 rows 生成后，调用 `write_dataset_rows(...)` 写出 `train.jsonl / validation.jsonl / test.jsonl`。
18. 所有 split 完成后，构造 `manifest`，再调用 `write_manifest(...)` 写出 `manifest.json`。

这说明它的职责非常明确：既做“按时间轴拆题”，也做“oracle 打标签”，还做“chat-format 落盘”。

## 4. 辅助函数流程说明

如果把本文件中出现的辅助函数按调用顺序串起来看，可以更快理解主流程是怎么被托住的。

### 4.1 `parse_args()`

- 读取脚本运行参数
- 统一控制 benchmark 路径、输出路径、split 截断规模、最近 turn 限制
- 服务于后面的 `main()`

它虽然简单，但决定了这份脚本的“输入范围”和“导出规模”。

### 4.2 `_target_payload(action, target_stage_index, reason)`

- 把 oracle gate 决策组装成 assistant JSON
- 固定输出 `action / target_stage_index / reason / confidence`
- 保证训练目标格式稳定

这一步的作用是把“内部判断结果”转成“模型要学会输出的样子”。

### 4.3 `build_rows(run_root, split, max_samples, recent_turn_limit)`

- 这是整份文件最核心的函数
- 负责真正把 `RuntimeSample` 展开成多条 gate 判断题
- 内部维护 `current_stage_index`
- 对每个 turn 前缀生成一条 chat-format row

可以说，整份文件 80% 的核心逻辑都在这里。

### 4.4 `iter_samples(...)`（来自 `common.py`）

- 虽然不定义在本文件里，但它是主流程真正的样本提供者
- 负责从增量 benchmark 目录中读取指定 split 的 `RuntimeSample`
- 为 `build_rows(...)` 提供统一迭代接口

### 4.5 `gate_messages(...)`（来自 `common.py`）

- 用统一模板生成 gate 训练题的 `system + user` 部分
- 保证训练时 prompt 和运行时 prompt 风格一致
- 输入包含 sample、current_stage_index、observed_turns、recent_turn_limit

这一步非常重要，因为它让数据准备和推理时的输入格式保持联通。

### 4.6 `write_dataset_rows(...)` 与 `write_manifest(...)`（来自 `common.py`）

- 分别负责写出 JSONL 数据和 manifest
- 把主流程生成的内存对象真正落成文件
- 保留训练数据规模和配置说明

## 5. 输入是什么

它的输入不是原始 Mermaid 字符串，而是已经构造好的增量 benchmark 数据，具体通过：

- `iter_samples(run_root, split, ...)`

读取。

这些样本必须已经具备：

- `sample.turns`
- `sample.stage_boundaries`
- `sample.total_stages`

否则它没法回答“当前该不该更新”这种题。

## 6. 输出是什么

它最终会在 `output-dir` 下写出：

- `train.jsonl`
- `validation.jsonl`
- `test.jsonl`
- `manifest.json`

每条 JSONL 记录都是一条标准 chat-format SFT 样本，可直接送入 [train_qwen3_lora.py](/e:/Desktop/stream2graph/tools/finetune/train_qwen3_lora.py) 训练。

## 7. 这份文件和上下游怎么衔接

它的上游是：

- 增量 benchmark 样本构建链
- `RuntimeSample`

它的下游是：

- [train_qwen3_lora.py](/e:/Desktop/stream2graph/tools/finetune/train_qwen3_lora.py)

整条局部链路可以写成：

`benchmark -> prepare_gate_sft_dataset.py -> gate SFT JSONL -> train_qwen3_lora.py`

## 8. 这份文件最值得学习的地方

这份脚本最值得学习的是：

- 如何把“连续时间轴上的判断任务”自动展开成大量训练题
- 如何把 gold boundary 转成监督标签
- 如何复用运行时 prompt 模板，避免训练/推理输入漂移
- 如何把输出目标钉成稳定的 JSON 结构

## 9. 一句话总结

这份文件的作用，就是把增量 benchmark 中“阶段何时触发”的真值规律，自动转写成 gate 可学习的监督式微调题库。
