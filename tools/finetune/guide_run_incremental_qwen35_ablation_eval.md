# `run_incremental_qwen35_ablation_eval.py` 文件说明

对应源码：[run_incremental_qwen35_ablation_eval.py](/e:/Desktop/stream2graph/tools/finetune/run_incremental_qwen35_ablation_eval.py)

## 1. 这份文件在整条链里的位置

这份脚本位于“训练完成之后、benchmark 测试之前的批量实验调度层”。  
它不负责训练 adapter，也不直接做推理，而是负责：

**自动生成并运行四组合后微调消融实验。**

也就是说，它研究的是：

- gate 微调有没有贡献
- planner 微调有没有贡献
- 双微调是否显著优于只微调其中一个

## 2. 这份文件主要解决什么问题

在你这个项目里，可训练的核心部件有两个：

- `gate`
- `planner`

如果只报告“最终组合最好”，别人自然会追问：

- 到底是 gate 微调起作用，还是 planner 微调起作用？
- 两者是不是有一个其实不值得训？
- 双微调到底是不是必要？

这份脚本要解决的，就是如何把这个问题做成一个标准、干净、可复现的 2x2 因子实验：

- 因子 A：gate 是否挂 FT adapter
- 因子 B：planner 是否挂 FT adapter

最终组合成四组：

- `gateft_plannerft`
- `gateft_plannerbase`
- `gatebase_plannerft`
- `gatebase_plannerbase`

更重要的是，它还要保证：

- 四组实验除了 adapter 是否存在外，其余变量尽量不变
- 每一组都能自动生成 benchmark 配置
- 每一组都能顺序跑完完整 benchmark

所以这份文件本质上是在解决：

**如何把“模型微调贡献拆解”变成一个工程上可执行、变量控制干净的自动化实验。**

### 2.1 参数默认值总览

这份脚本的参数设计非常像“实验总控台”，默认值本身就已经体现了作者对四组合消融的推荐运行方案。按源码里的 `parse_args()`，默认值如下：

- 数据与输出
  - `--run-root = "data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean"`
  - `--split = "validation"`，可选：`validation / test`
  - `--max-samples = 0`
  - `--output-root = "reports/evaluation/runs/incremental_system"`
  - `--config-output-dir = "reports/evaluation/generated_configs/incremental_qwen35_ablation"`

- base model 路径
  - `--gate-model = "artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-4B"`
  - `--planner-model = "artifacts/model_cache/qwen35_incremental/Qwen__Qwen3.5-27B"`

- FT adapter 路径
  - `--gate-adapter = "artifacts/finetune/qwen35_4b_incremental_gate_cloud_autodl/final_adapter"`
  - `--planner-adapter = "artifacts/finetune/qwen35_27b_incremental_planner_cloud_autodl/final_adapter"`

- 调度与超时
  - `--max-concurrency = 1`
  - `--timeout-sec = 240`

- 资源预算
  - `--gate-gpu-memory-mib = 16000`
  - `--planner-gpu-memory-mib = 78000`
  - `--gate-cpu-memory-gib = 64`
  - `--planner-cpu-memory-gib = 96`

- 生成长度与推理细节
  - `--gate-max-new-tokens = 512`
  - `--planner-max-new-tokens = 2048`
  - `--attn-implementation = "sdpa"`
  - `--enable-thinking` 默认关闭
  - `--dry-run` 默认关闭

从默认值可以直接看出当前官方消融口径：

- 默认先跑 `validation`，不是直接跑全量 `test`
- gate 与 planner 始终共用同一套 base 模型目录
- FT/base 差异默认由 adapter 路径控制
- planner 的资源预算远高于 gate
- planner 的最大生成长度也远高于 gate

### 2.2 代码内部固定设置

这份脚本最重要的不是 CLI 参数，而是那些把实验“钉成干净 2x2 设计”的内部固定设置：

- `_experiment_rows(...)` 固定只生成四组实验：
  - `gateft_plannerft`
  - `gateft_plannerbase`
  - `gatebase_plannerft`
  - `gatebase_plannerbase`
  - 这说明实验设计在代码里是明确钉死的四宫格结构

- `_local_hf_extra(...)` 固定写入：
  - `use_4bit = True`
  - 也就是说四组实验都默认走同一套 4-bit LocalHF 推理路线

- gate / planner 在 benchmark config 里固定设为：
  - `gate_kind = "local_hf"`
  - `planner_kind = "local_hf"`
  - 所以这份消融实验不比较 provider，只比较 adapter 开关

- benchmark 配置里的通用生成参数固定为：
  - `temperature = 0.0`
  - `max_retries = 1`
  - `retry_backoff_sec = 3.0`
  - `gate_request_interval_sec = 0.0`
  - `planner_request_interval_sec = 0.0`
  - 这说明消融实验默认追求“固定、可控、少随机性”

- API key 注入字段固定为：
  - `gate_api_key_env = "OPENAI_API_KEY"`
  - `planner_api_key_env = "OPENAI_API_KEY"`
  - 即便本实验走 LocalHF，这层字段也保持和 benchmark 总入口兼容

- thinking 策略固定为：
  - gate 一律 `enable_thinking = False`
  - planner 才跟随 `--enable-thinking`
  - 这非常符合作者的任务判断：gate 应保持短、稳、克制；planner 才可能考虑更重的思维模式

- FT/base 的真正开关不是换 base model，而是：
  - `adapter_path` 是否为空字符串
  - 这是整个 2x2 消融最核心的变量控制点

## 3. 整体执行流程

这份脚本的主流程集中在 `main()` 中，顺序大致如下：

1. 通过 `parse_args()` 读取 benchmark 数据路径、split、输出目录、base model 路径、adapter 路径，以及推理资源限制。
2. 创建 `config_output_dir`，用于存放自动生成的四份 benchmark 配置。
3. 调用 `_experiment_rows(args)` 构造四组实验定义。
4. 为每组实验调用 `_assert_required_paths(...)`，确认非空 adapter 路径确实存在。
5. 基于实验名和 split 构造当前 run 的 `run_name`。
6. 为当前实验生成 benchmark 配置 `config_payload`，其中：
   - `gate_kind = "local_hf"`
   - `planner_kind = "local_hf"`
   - base model 路径固定
   - FT/base 差异通过 `adapter_path` 是否为空来表达
7. 调用 `_local_hf_extra(...)` 生成：
   - `gate_extra_body_json`
   - `planner_extra_body_json`
8. 把当前实验的 benchmark 配置写到 `config_output_dir/{run_name}.json`。
9. 四组实验配置全部生成后，打印一个 JSON 摘要，列出：
   - config 数量
   - 各 config 路径
   - 当前是否 dry-run
10. 如果启用了 `--dry-run`，脚本到这里结束。
11. 如果不是 dry-run，则依次对四份 config 执行：
    - `python tools/eval/run_incremental_benchmark.py --config <config_path>`
12. 每组 benchmark 跑完之后打印 start/done 日志，最终形成四个完整的结果目录。

这说明它的职责非常明确：既做“实验组合生成”，也做“配置写盘”，还做“顺序调度 benchmark 执行”。

## 4. 辅助函数流程说明

### 4.1 `parse_args()`

- 负责读取四组合消融实验所需的全部参数
- 包括：
  - benchmark 路径
  - split
  - 输出目录
  - base model 路径
  - gate/planner adapter 路径
  - GPU/CPU 内存限制
  - max_new_tokens
  - attention implementation
  - `--dry-run`

它定义了这份脚本的实验空间。

### 4.2 `_local_hf_extra(...)`

- 把 LocalHF 推理器所需的附加参数打包成 JSON 字符串
- 字段包括：
  - `use_4bit`
  - `max_new_tokens`
  - `gpu_memory_limit_mib`
  - `cpu_memory_limit_gib`
  - `attn_implementation`
  - `enable_thinking`
  - 可选 `adapter_path`

这是后面 FT/base 切换的关键封装层。

### 4.3 `_experiment_rows(args)`

- 生成四组实验定义
- 唯一核心变化是：
  - `gate_adapter` 是否为空
  - `planner_adapter` 是否为空

这一函数把实验设计从“概念”变成“可执行组合表”。

### 4.4 `_assert_required_paths(experiment)`

- 检查当前实验中所有非空 adapter 路径是否真实存在
- 避免实验半路才因路径错误崩掉

### 4.5 `resolve_path(...)` / `slugify(...)` / `write_json(...)`（来自 `tools.eval.common`）

- `resolve_path(...)`：统一解析仓库内外路径
- `slugify(...)`：生成稳定、适合目录名的 run name
- `write_json(...)`：把 benchmark 配置写盘

## 5. 输入是什么

输入不是训练数据，而是“后微调实验配置”，包括：

- benchmark 数据路径
- base gate/planner 模型路径
- gate/planner adapter 路径
- split
- 输出目录
- 显存/内存预算
- 生成长度与推理参数

它面对的是：

**模型已经训完，现在要系统比较不同 adapter 组合的表现。**

## 6. 输出是什么

输出主要有两层。

第一层：

- 四份 benchmark 配置 JSON

第二层：

- 四个完整 benchmark run 结果目录

这些结果目录最终会包含：

- inference 结果
- metrics 结果
- details
- configs

## 7. 这份文件和上下游怎么衔接

它的上游通常是：

- [train_qwen3_lora.py](/e:/Desktop/stream2graph/tools/finetune/train_qwen3_lora.py) 产出的 `final_adapter`

它的下游是：

- [run_incremental_benchmark.py](/e:/Desktop/stream2graph/tools/eval/run_incremental_benchmark.py)

整条局部链路可以写成：

`final_adapter -> run_incremental_qwen35_ablation_eval.py -> 四组 benchmark config -> 四次完整 benchmark`

## 8. 这份文件最值得学习的地方

这份脚本最值得学习的是：

- 如何把消融实验设计成标准的 2x2 因子实验
- 如何让“是否挂 adapter”成为唯一核心变量
- 如何把复杂实验先写成配置，再顺序执行
- 如何把大实验脚本写成调度器，而不是把所有细节堆进一个文件

## 9. 一句话总结

这份文件的作用，就是把 gate 与 planner 的微调 adapter 做成四组合后微调消融实验，并把这四组配置依次送入完整 benchmark 进行评测。
