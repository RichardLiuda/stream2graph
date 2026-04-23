# `train_qwen3_lora.py` 文件说明

对应源码：[train_qwen3_lora.py](/e:/Desktop/stream2graph/tools/finetune/train_qwen3_lora.py)

## 1. 这份文件在整条链里的位置

这份脚本是整条微调主线的训练发动机。  
前面的数据准备脚本负责“出题”，这份脚本负责“带模型刷题”。

它本身不是 gate 专用，也不是 planner 专用，而是一个通用 QLoRA trainer。只要你给它：

- 一份 chat-format JSONL 数据集
- 一个 base model
- 一套训练配置

它就能完成 LoRA 微调。

所以它在链路中的位置是：

`SFT JSONL -> tokenize -> QLoRA train -> final_adapter`

## 2. 这份文件主要解决什么问题

这份文件要解决的，不只是“怎么调用 Trainer 训练一下”。

它真正解决的是下面这些工程问题：

第一，如何把 chat-format 的 `system / user / assistant` 样本，转成适合因果语言模型训练的 token 序列。  
第二，如何只让 assistant 目标 JSON 参与 loss，而不让 prompt 部分参与监督。  
第三，如何在有限显存下对 Qwen3.5 这种模型做 4-bit QLoRA 微调。  
第四，如何把不同训练任务都统一到一个可配置、可复用的训练器里。  
第五，如何把训练结果保存成 adapter，方便后续 benchmark 和消融实验直接复用。

所以你可以把这份文件理解成：

**一个把“项目专用 SFT 数据”稳定转换成“项目专用 LoRA adapter”的通用训练管道。**

### 2.1 参数默认值总览

这份训练脚本的参数是五份文档里最多的，因为它既控制数据、又控制模型、还控制 Trainer 行为。按源码里的 `parse_args()`，默认值如下：

- 通用入口
  - `--config = ""`
  - 含义：默认不额外读取 JSON 配置文件；如果提供，就用配置文件覆盖下面这些默认值

- 模型与数据路径
  - `--model-name-or-path = "Qwen/Qwen3.5-4B"`
  - `--dataset-dir = "data/finetune/incremental_gate_sft_local_smoke"`
  - `--output-dir = "artifacts/finetune/qwen35_4b_incremental_gate_local_smoke"`
  - `--logging-dir = "reports/finetune/tensorboard/qwen35_4b_incremental_gate_local_smoke"`
  - `--offload-dir = "artifacts/finetune/offload/qwen35_4b_incremental_gate_local_smoke"`

- 序列与 batch
  - `--max-seq-length = 1024`
  - `--per-device-train-batch-size = 1`
  - `--per-device-eval-batch-size = 1`
  - `--gradient-accumulation-steps = 8`

- 优化超参数
  - `--learning-rate = 2e-4`
  - `--weight-decay = 0.0`
  - `--warmup-ratio = 0.03`
  - `--num-train-epochs = 1.0`
  - `--max-steps = 200`

- 日志、验证与保存
  - `--logging-steps = 5`
  - `--eval-steps = 20`
  - `--save-steps = 20`
  - `--save-total-limit = 2`
  - `--seed = 42`

- LoRA 参数
  - `--lora-r = 8`
  - `--lora-alpha = 16`
  - `--lora-dropout = 0.05`
  - `--target-modules = "q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj"`

- 推理/装载资源
  - `--gpu-memory-limit-mib = 24000`
  - `--cpu-memory-limit-gib = 64`
  - `--attn-implementation = "sdpa"`

如果只从“最影响训练结果的几项值”去记，这个脚本的默认训练节奏是：

- 学习率 `2e-4`
- 训练轮数 `1.0`
- 每卡 batch `1`
- 梯度累积 `8`
- 最大步数 `200`
- 最大序列长度 `1024`

这也是为什么我一直强调：脚本默认值本质上更像 **gate 本地 smoke 训练预设**，而不是你最终云端正式训练的主配置。

### 2.2 代码内部固定设置

除了命令行参数，这份训练器里还有很多没有暴露成 CLI、但会直接影响训练行为的固定设置：

- tokenizer 固定设置
  - `AutoTokenizer.from_pretrained(..., use_fast=False)`
  - 如果 `pad_token` 为空，固定回退到 `eos_token`
  - `padding_side = "right"`

- chat 渲染固定策略
  - `render_chat(...)` 默认尝试 `enable_thinking=False`
  - 如果 tokenizer 版本不支持该参数，再自动回退
  - 这说明训练 prompt 默认尽量关闭 thinking 模式

- 量化固定设置
  - `load_in_4bit = True`
  - `bnb_4bit_quant_type = "nf4"`
  - `bnb_4bit_use_double_quant = True`
  - `bnb_4bit_compute_dtype = compute_dtype()`
  - 这是当前 QLoRA 路线的关键固定配置

- 模型加载固定策略
  - `low_cpu_mem_usage = True`
  - `offload_state_dict = True`
  - CUDA 可用时固定 `device_map = "auto"`
  - `model.config.use_cache = False`

- LoRA 固定设置
  - `bias = "none"`
  - `task_type = "CAUSAL_LM"`

- Trainer 固定设置
  - `evaluation_strategy = "steps"`
  - `save_strategy = "steps"`
  - `optim = "paged_adamw_8bit"`
  - `lr_scheduler_type = "cosine"`
  - `gradient_checkpointing = True`
  - `report_to = ["tensorboard"]`
  - `remove_unused_columns = False`
  - `dataloader_num_workers = 0`
  - `save_safetensors = True`
  - `disable_tqdm = False`
  - `logging_first_step = True`

- loss 掩码固定策略
  - `labels = [-100] * prompt_len + input_ids[prompt_len:]`
  - 这表示 prompt 永远不计 loss，只有 assistant 目标参与监督

你如果要真正读懂这份文件，最值得同时记住的就是这两层：

- 上层参数默认值决定“实验怎么配”
- 下层固定设置决定“训练器按什么制度运行”

## 3. 整体执行流程

这份脚本的主流程集中在 `main()` 中，顺序大致如下：

1. 通过 `parse_args()` 读取命令行参数；如果传了 `--config`，先读取 JSON 配置覆盖默认值。
2. 调用 `set_seed(...)` 固定随机种子，保证训练更可复现。
3. 打印整份训练配置，方便日志审计。
4. 如果 CUDA 可用，开启 TF32 并打印当前 GPU 信息。
5. 解析并创建 `dataset_dir`、`output_dir`、`logging_dir`。
6. 调用 `build_tokenizer(...)` 加载 tokenizer，并处理 pad token。
7. 调用 `load_jsonl_dataset(...)` 读入 `train / validation / test` JSONL。
8. 对训练集调用 `tokenize_dataset(...)`，把 chat-format 样本转成：
   - `input_ids`
   - `attention_mask`
   - `labels`
9. 对验证集也做同样的 token 化。
10. 计算并打印：
    - `effective_batch_size`
    - `approx_steps_per_epoch`
    - `approx_total_steps`
11. 调用 `build_model(args)`：
    - 构造 4-bit 量化配置
    - 加载 base model
    - 准备 k-bit training
    - 注入 LoRA adapter
12. 把当前解析后的参数写入 `resolved_config.json`。
13. 构造 `TrainingArguments(...)`。
14. 用 `Trainer(...)` 组装训练器，并注入 `SupervisedDataCollator(tokenizer)`。
15. 调用 `trainer.train()` 正式开始训练。
16. 训练完成后，保存：
    - `final_adapter`
    - tokenizer
    - trainer state

这说明它的职责非常明确：既做“数据到 token”的转换，也做“模型装配”，还做“训练与保存”。

## 4. 辅助函数流程说明

如果把这些辅助函数按调用顺序串起来看，可以很快理解它们怎样一起托住主流程。

### 4.1 `repo_root()` 与 `resolve_path(raw)`

- `repo_root()`：定位仓库根目录
- `resolve_path(raw)`：把相对路径统一解析到仓库根目录下

这两个函数的作用是让整份脚本对 config 文件里的相对路径更友好。

### 4.2 `parse_args()`

- 先定义一套默认训练参数
- 再支持 `--config` JSON 覆盖默认值
- 最终返回完整训练配置

这是整份脚本“可复用、可切换任务”的关键入口。

### 4.3 `render_chat(tokenizer, messages, add_generation_prompt)`

- 把 `messages` 渲染成 Qwen 期望的 chat template 文本
- 尽量关闭 thinking
- 对不同 tokenizer 版本做兼容

这一步决定训练时模型实际看到的 prompt 长什么样。

### 4.4 `compute_dtype()`

- 判断当前硬件更适合 `bf16` 还是 `fp16`
- 为量化加载和训练参数服务

### 4.5 `load_jsonl_dataset(dataset_dir)`

- 从 `dataset_dir` 下读取：
  - `train.jsonl`
  - `validation.jsonl`
  - `test.jsonl`
- 组装成 Hugging Face DatasetDict

### 4.6 `build_tokenizer(model_name_or_path)`

- 从 base model 加载 tokenizer
- 补齐 pad token
- 固定右侧 padding

### 4.7 `tokenize_dataset(dataset, tokenizer, max_seq_length)`

- 这是整份文件最核心的辅助函数
- 对每条 chat-format 样本：
  - 把 `messages[:-1]` 视作 prompt
  - 把 `messages` 视作 full sequence
  - 分别渲染、tokenize
  - 构造 `labels = [-100] * prompt_len + answer_tokens`
- 最后过滤掉没有有效监督 token 的样本

这一函数决定了：

**这个项目训练到底在对哪些 token 打分。**

### 4.8 `SupervisedDataCollator`

- 负责 batch 级别的 padding
- 重新构造 batch 内 labels
- 确保 padding 区域仍然是 `-100`

这一层保证了单样本 supervision 规则在 batch 维度不被破坏。

### 4.9 `build_model(args)`

- 构造 `BitsAndBytesConfig`
- 准备 offload 目录
- 加载 `AutoModelForCausalLM`
- 通过 `prepare_model_for_kbit_training(...)` 转成适合 k-bit 训练的模型
- 构造 `LoraConfig`
- 用 `get_peft_model(...)` 挂上 LoRA

这一函数就是整份文件里 QLoRA 路线的核心实现。

## 5. 输入是什么

输入主要有两类。

第一类是训练配置，包括：

- model path
- dataset dir
- output dir
- batch size
- learning rate
- LoRA 参数
- 显存预算

第二类是 SFT 数据目录，包括：

- `train.jsonl`
- `validation.jsonl`
- 可选 `test.jsonl`

并且每条样本都必须符合：

- `messages`
- assistant 在最后一条

## 6. 输出是什么

输出目录里最重要的是：

- `final_adapter/`
- `resolved_config.json`
- trainer checkpoints / state
- tensorboard 日志

其中核心产物是：

- `final_adapter`

这就是后续本地推理、benchmark、消融实验要加载的微调结果。

## 7. 这份文件和上下游怎么衔接

它的上游通常是：

- [prepare_gate_sft_dataset.py](/e:/Desktop/stream2graph/tools/incremental_finetune/prepare_gate_sft_dataset.py)
- [prepare_planner_sft_dataset.py](/e:/Desktop/stream2graph/tools/incremental_finetune/prepare_planner_sft_dataset.py)

它的下游通常是：

- 本地 LocalHF 推理
- [run_incremental_benchmark.py](/e:/Desktop/stream2graph/tools/eval/run_incremental_benchmark.py)
- [run_incremental_qwen35_ablation_eval.py](/e:/Desktop/stream2graph/tools/finetune/run_incremental_qwen35_ablation_eval.py)

整条局部链路可以写成：

`SFT 数据准备 -> train_qwen3_lora.py -> final_adapter -> benchmark / ablation`

## 8. 这份文件最值得学习的地方

这份脚本最值得学习的是：

- 如何把 config 驱动和训练逻辑彻底分开
- 如何把 chat-format 样本转成只监督 assistant 的训练目标
- 如何把 4-bit QLoRA 的关键步骤写成一个干净、可复用的训练器
- 如何把训练产物稳定保存为 adapter

## 9. 一句话总结

这份文件的作用，就是把你们项目导出的 chat-format SFT 数据，真正训练成可用于本地推理和 benchmark 评测的 QLoRA adapter。
