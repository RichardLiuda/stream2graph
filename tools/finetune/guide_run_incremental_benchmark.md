# `run_incremental_benchmark.py` 文件说明

对应源码：[run_incremental_benchmark.py](/e:/Desktop/stream2graph/tools/eval/run_incremental_benchmark.py)

## 1. 这份文件在整条链里的位置

这份脚本是“微调后测试”阶段的总入口。  
如果 `train_qwen3_lora.py` 负责产出 adapter，那么这份脚本负责：

**把某一组 gate/planner 推理配置真正送进完整 benchmark。**

它本身不直接做推理，也不直接做指标计算，而是把一次 benchmark run 明确拆成两段：

1. `inference`
2. `metrics`

所以它更像实验编排器，而不是模型本体。

## 2. 这份文件主要解决什么问题

训练结束之后，项目真正关心的不是“adapter 已经保存成功”，而是：

- 这组配置在 benchmark 上到底生成了什么结果？
- 最终质量指标是多少？
- 所有运行配置和结果能不能被完整留痕，方便复现？

这份文件要解决的，就是如何把一次 benchmark 实验拆成清晰、可复现、可审计的两阶段流程：

`推理生成结果 -> 指标计算与汇总`

所以它并不是一个“简单的启动脚本”，而是在解决：

**如何把实验配置、推理结果、指标结果三者组织成一个完整 benchmark run。**

### 2.1 参数默认值总览

这份脚本控制的是“测试怎么跑”，所以它的默认值本质上是一套 benchmark 运行预设。按源码里的 `parse_args()`，默认值如下：

- 配置与数据范围
  - `--config = ""`
  - `--run-root = "data/incremental_dataset/runs/incremental_open_balanced_v1_3360_public_clean"`
  - `--split = "test"`，可选：`train / validation / test / all`
  - `--max-samples = 0`
  - `--sample-ids-file = ""`
  - `--max-concurrency = 1`

- API keys 配置
  - `--api-keys-config = "configs/evaluation/model_benchmarks/api_keys.local.json"`

- gate 推理器参数
  - `--gate-kind = "oracle"`
  - `--gate-endpoint = ""`
  - `--gate-model = ""`
  - `--gate-api-key-env = "OPENAI_API_KEY"`
  - `--gate-api-key = ""`
  - `--gate-omit-temperature` 默认关闭
  - `--gate-extra-body-json = ""`

- planner 推理器参数
  - `--planner-kind = "oracle"`
  - `--planner-endpoint = ""`
  - `--planner-model = ""`
  - `--planner-api-key-env = "OPENAI_API_KEY"`
  - `--planner-api-key = ""`
  - `--planner-omit-temperature` 默认关闭
  - `--planner-extra-body-json = ""`

- 通用生成与调度参数
  - `--temperature = 0.0`
  - `--timeout-sec = 180`
  - `--max-retries = 5`
  - `--retry-backoff-sec = 3.0`
  - `--gate-request-interval-sec = None`
  - `--planner-request-interval-sec = None`
  - `--request-interval-sec = 0.0`
  - `--run-name = ""`
  - `--output-root = "reports/evaluation/runs/incremental_system"`

从默认值能直接读出作者的默认测试口径：

- 默认跑 `test` split
- 默认 gate/planner 都走 `oracle`
- 默认 temperature 为 `0.0`
- 默认单并发
- 默认超时 `180` 秒

也就是说，这个脚本的默认值是偏“稳定、可复现 benchmark”的，而不是偏高吞吐或随机探索。

### 2.2 代码内部固定设置

这份 benchmark 总入口虽然大部分行为来自参数，但仍然有一些关键固定制度：

- benchmark 一定拆成两个子阶段：
  - `inference`
  - `metrics`
  - 这不是可选设计，而是脚本结构本身的固定框架

- `inference_config` 里固定写入：
  - `resume = True`
  - 说明推理阶段默认支持断点续跑/续接已有结果

- 子配置文件名固定为：
  - `configs/incremental_inference.json`
  - `configs/incremental_metrics.json`

- gate/planner 的 API key 最终通过环境变量或显式字段注入
  - 其中默认环境变量名固定是 `OPENAI_API_KEY`
  - 这是一种统一密钥注入约定

- 输出目录骨架固定为：
  - `configs/`
  - `inference/`
  - `metrics/`
  - 说明每次 benchmark run 都会形成同样的可审计目录结构

- 这份脚本本身不直接做推理，也不直接做指标
  - 它固定调用两个下游脚本：
    - `tools/eval/run_incremental_inference.py`
    - `tools/eval/run_incremental_metrics.py`
  - 所以它的固定角色是“编排器”，不是“执行器”

## 3. 整体执行流程

这份脚本的主流程集中在 `main()` 中，顺序大致如下：

1. 通过 `parse_args()` 读取命令行参数；如果传了 `--config`，先用配置文件覆盖默认值。
2. 调用 `load_api_keys_config(...)` 读取 API keys 配置。
3. 根据 gate/planner 的模型名或种类，自动生成 `run_name`；如果用户显式给了 `--run-name`，则直接使用。
4. 基于 `output_root` 和 `run_name` 创建当前实验的目录结构：
   - `configs/`
   - `inference/`
   - `metrics/`
5. 从参数或 API key 配置中解析 gate/planner 各自的密钥，并写入 `child_env`。
6. 构造 `inference_config`，把推理阶段的全部配置打包成 JSON 对象。
7. 构造 `metrics_config`，把指标阶段需要的配置打包成 JSON 对象。
8. 调用 `write_json(...)` 把这两份配置分别写到：
   - `configs/incremental_inference.json`
   - `configs/incremental_metrics.json`
9. 调用 `_run_script(...)` 执行 `tools/eval/run_incremental_inference.py`。
10. 在推理成功后，再调用 `_run_script(...)` 执行 `tools/eval/run_incremental_metrics.py`。
11. 全部结束后打印 `Run root`，告诉调用方本次实验完整结果目录在哪里。

这说明它的职责非常明确：既做“配置拆分”，也做“目录组织”，还做“推理与指标阶段的顺序调度”。

## 4. 辅助函数流程说明

### 4.1 `parse_args()`

- 解析 benchmark run 的所有输入参数
- 支持 `--config` JSON 覆盖默认值
- 统一控制：
  - benchmark 数据范围
  - gate/planner 推理配置
  - timeout / retries / concurrency
  - 输出目录

### 4.2 `_run_script(script, config_path, env_overrides=None)`

- 拼装命令：
  - `python <script> --config <config_path>`
- 复制当前环境变量
- 注入额外 env，比如 API key
- 用 `subprocess.run(...)` 顺序执行子脚本

它的作用是让 benchmark 总入口保持“调度器”定位，而不是把推理和指标逻辑都写进一个文件。

### 4.3 `load_api_keys_config(...)`（来自 `tools.eval.common`）

- 负责读取 API key 配置文件
- 为 gate/planner 子进程准备密钥注入来源

### 4.4 `slugify(...)`（来自 `tools.eval.common`）

- 当用户没给 `run_name` 时，自动生成稳定、适合做目录名的 run 名称

### 4.5 `write_json(...)`（来自 `tools.eval.common`）

- 把 `inference_config` 和 `metrics_config` 安全写盘
- 为后续复现保留配置留痕

## 5. 输入是什么

这份脚本的输入不是训练数据，而是一次 benchmark 运行配置，包括：

- benchmark 数据根目录
- split
- gate 配置
- planner 配置
- API keys 配置
- timeout / retries / 并发数
- 输出目录

它面向的是“实验执行配置”，不是“模型训练配置”。

## 6. 输出是什么

它会在一次 run 目录下输出：

- `configs/`
- `inference/`
- `metrics/`

其中关键产物包括：

- `configs/incremental_inference.json`
- `configs/incremental_metrics.json`
- `inference/predictions.jsonl`
- metrics 汇总结果

## 7. 这份文件和上下游怎么衔接

它的上游通常是：

- 已训练好的 base model / adapter
- 或者 ablation 脚本自动生成的一份 config

它的下游是：

- [run_incremental_inference.py](/e:/Desktop/stream2graph/tools/eval/run_incremental_inference.py)
- [run_incremental_metrics.py](/e:/Desktop/stream2graph/tools/eval/run_incremental_metrics.py)

局部链路可以写成：

`训练产物 / ablation 配置 -> run_incremental_benchmark.py -> 推理结果 + 指标结果`

## 8. 这份文件最值得学习的地方

这份脚本最值得学习的是：

- 如何把一次复杂实验拆成 inference 和 metrics 两个子阶段
- 如何把子阶段配置显式写成 JSON 留痕
- 如何设计清晰的结果目录结构
- 如何让 benchmark 入口只做“编排”和“调度”

## 9. 一句话总结

这份文件的作用，就是把某一组 gate/planner 配置真正送入增量 benchmark，先跑推理，再跑指标，形成一次完整可复现的实验结果目录。
