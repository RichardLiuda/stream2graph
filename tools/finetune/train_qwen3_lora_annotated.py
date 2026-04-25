#!/usr/bin/env python3
# shebang：如果这个文件在支持 shebang 的环境里被直接执行，就使用 python3 运行。

from __future__ import annotations
# 推迟类型注解求值，避免前向引用在运行时出问题。

import argparse
# 用来解析命令行参数。

import json
# 用来读配置 JSON、写解析后的配置 JSON。

import math
# 用来计算近似 step 数，例如 ceil。

from pathlib import Path
# 现代 Python 路径处理工具。

from typing import Any
# 类型注解里会用到 Any。

import torch
# PyTorch：训练的核心深度学习框架。

from datasets import load_dataset
# Hugging Face datasets：用于把 JSONL 数据读成 Dataset 对象。

from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
# peft：LoRA/QLoRA 训练的核心库。
# - LoraConfig：定义 LoRA 参数
# - get_peft_model：把 LoRA 挂到 base model 上
# - prepare_model_for_kbit_training：让量化模型进入可训练状态

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
    set_seed,
)
# transformers：项目训练主力库。
# - AutoModelForCausalLM：加载因果语言模型
# - AutoTokenizer：加载 tokenizer
# - BitsAndBytesConfig：4-bit 量化配置
# - Trainer：训练器
# - TrainingArguments：训练参数容器
# - set_seed：固定随机种子


def repo_root() -> Path:
    # 找到仓库根目录。
    return Path(__file__).resolve().parents[2]


def resolve_path(raw: str) -> Path:
    # 把字符串路径解析成可用 Path。
    candidate = Path(raw)
    # 先包装成 Path。

    if candidate.is_absolute():
        # 如果本来就是绝对路径，直接返回。
        return candidate

    return repo_root() / candidate
    # 否则默认相对于仓库根目录解析。


def parse_args() -> argparse.Namespace:
    # 这个函数定义并解析训练脚本支持的参数。
    parser = argparse.ArgumentParser(description="QLoRA fine-tuning entrypoint for Qwen3.5 on incremental Stream2Graph.")
    # 创建参数解析器，并写上描述。

    parser.add_argument("--config", type=str, default="")
    # 可选配置文件路径。
    # 如果给了 JSON 配置文件，脚本会把里面的键值作为默认参数。

    parser.add_argument("--model-name-or-path", type=str, default="Qwen/Qwen3.5-4B")
    # 底座模型名称或本地路径。

    parser.add_argument("--dataset-dir", type=str, default="data/finetune/incremental_gate_sft_local_smoke")
    # 训练数据目录，默认是一个 gate 本地 smoke 数据目录。

    parser.add_argument("--output-dir", type=str, default="artifacts/finetune/qwen35_4b_incremental_gate_local_smoke")
    # 训练产物输出目录。

    parser.add_argument("--logging-dir", type=str, default="reports/finetune/tensorboard/qwen35_4b_incremental_gate_local_smoke")
    # TensorBoard 日志目录。

    parser.add_argument("--offload-dir", type=str, default="artifacts/finetune/offload/qwen35_4b_incremental_gate_local_smoke")
    # 模型 offload 目录。
    # 在显存不足时，部分权重/状态会临时放这里。

    parser.add_argument("--max-seq-length", type=int, default=1024)
    # 最大序列长度。
    # 超过这个 token 数的样本会被截断。

    parser.add_argument("--per-device-train-batch-size", type=int, default=1)
    # 每张设备（当前通常是一张卡）一次训练喂多少条样本。

    parser.add_argument("--per-device-eval-batch-size", type=int, default=1)
    # 每张设备一次评估喂多少条样本。

    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    # 梯度累积步数。
    # 用于在小 batch 下模拟更大的有效 batch。

    parser.add_argument("--learning-rate", type=float, default=2e-4)
    # 学习率。

    parser.add_argument("--weight-decay", type=float, default=0.0)
    # 权重衰减。

    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    # 预热比例。
    # 训练刚开始时，学习率会先逐渐升到目标值。

    parser.add_argument("--num-train-epochs", type=float, default=1.0)
    # 按数据集遍历轮数控制训练长度时，用这个参数。

    parser.add_argument("--max-steps", type=int, default=200)
    # 按 step 硬截训练长度时，用这个参数。
    # 如果 > 0，通常优先生效。

    parser.add_argument("--logging-steps", type=int, default=5)
    # 每多少 step 打一次日志。

    parser.add_argument("--eval-steps", type=int, default=20)
    # 每多少 step 做一次验证集评估。

    parser.add_argument("--save-steps", type=int, default=20)
    # 每多少 step 存一次 checkpoint。

    parser.add_argument("--save-total-limit", type=int, default=2)
    # 最多保留多少个 checkpoint。

    parser.add_argument("--seed", type=int, default=42)
    # 随机种子。

    parser.add_argument("--lora-r", type=int, default=8)
    # LoRA 的秩（rank）。

    parser.add_argument("--lora-alpha", type=int, default=16)
    # LoRA 的缩放参数 alpha。

    parser.add_argument("--lora-dropout", type=float, default=0.05)
    # LoRA 路径上的 dropout。

    parser.add_argument(
        "--target-modules",
        type=str,
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
    )
    # LoRA 要插入哪些模块。
    # 这里用逗号分隔字符串传入，后面再 split 成列表。

    parser.add_argument("--gpu-memory-limit-mib", type=int, default=24000)
    # GPU 内存上限，单位 MiB。
    # 给 device_map/max_memory 时会用到。

    parser.add_argument("--cpu-memory-limit-gib", type=int, default=64)
    # CPU 内存上限，单位 GiB。

    parser.add_argument("--attn-implementation", type=str, default="sdpa")
    # 注意力实现方式。
    # 比如 sdpa / flash attention 相关实现。

    pre_args, _ = parser.parse_known_args()
    # 先做一次预解析，只为了尽早读到 --config。

    if pre_args.config:
        # 如果用户传了配置文件，就先把配置文件加载进来。
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        # 解析配置 JSON。
        parser.set_defaults(**config_payload)
        # 用配置文件里的值覆盖 parser 默认值。

    return parser.parse_args()
    # 最终再完整解析一遍命令行，得到最终参数。


def render_chat(tokenizer: AutoTokenizer, messages: list[dict[str, str]], add_generation_prompt: bool) -> str:
    # 这个函数把 chat-format 的 messages 渲染成 tokenizer 所需的对话模板字符串。
    try:
        # 新版 tokenizer.apply_chat_template 可能支持 enable_thinking 参数。
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=add_generation_prompt,
            enable_thinking=False,
        )
    except TypeError:
        # 如果当前 tokenizer 版本不支持这个参数，就退回到兼容写法。
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=add_generation_prompt,
        )


def compute_dtype() -> torch.dtype:
    # 根据当前硬件能力决定训练/量化时的计算精度。
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        # 如果 GPU 可用且支持 bf16，就优先用 bf16。
        return torch.bfloat16

    return torch.float16
    # 否则退回到 fp16。


def load_jsonl_dataset(dataset_dir: Path):
    # 这个函数从 dataset_dir 读取 train/validation/test 三个 JSONL 文件。
    files = {
        "train": str(dataset_dir / "train.jsonl"),
        "validation": str(dataset_dir / "validation.jsonl"),
        "test": str(dataset_dir / "test.jsonl"),
    }
    # 先把理论上的三个文件路径都列出来。

    data_files = {name: path for name, path in files.items() if Path(path).exists()}
    # 只保留当前实际存在的文件。

    return load_dataset("json", data_files=data_files)
    # 用 Hugging Face datasets 直接把这些 JSONL 读成 DatasetDict。


def build_tokenizer(model_name_or_path: str) -> AutoTokenizer:
    # 这个函数负责加载 tokenizer，并做训练前的必要修正。
    tokenizer = AutoTokenizer.from_pretrained(model_name_or_path, use_fast=False)
    # 加载 tokenizer。
    # 这里明确 use_fast=False，避免某些 tokenizer 行为差异。

    if tokenizer.pad_token is None:
        # 有些 causal LM 没有单独的 pad token。
        tokenizer.pad_token = tokenizer.eos_token
        # 对这种模型，训练时通常用 eos token 充当 pad token。

    tokenizer.padding_side = "right"
    # 右侧 padding，更适合大多数因果语言模型训练。

    return tokenizer
    # 返回处理好的 tokenizer。


def tokenize_dataset(dataset, tokenizer: AutoTokenizer, max_seq_length: int):
    # 这个函数把原始 chat-format 样本，变成训练器真正可用的 token 张量字段。

    def tokenize_record(record: dict[str, Any]) -> dict[str, Any]:
        # 这是对单条样本的 token 化逻辑。
        prompt_messages = record["messages"][:-1]
        # prompt 部分 = system + user。

        full_messages = record["messages"]
        # full 部分 = system + user + assistant。

        prompt_text = render_chat(tokenizer, prompt_messages, add_generation_prompt=True)
        # 把 prompt 渲染成模型看到的对话文本。
        # add_generation_prompt=True 表示停在“该模型开始回答”的位置。

        full_text = render_chat(tokenizer, full_messages, add_generation_prompt=False)
        # 把完整对话渲染出来。
        # 这里 assistant 标准答案已经包含在内，所以不再额外加 generation prompt。

        prompt_tokens = tokenizer(
            prompt_text,
            truncation=True,
            max_length=max_seq_length,
            add_special_tokens=False,
        )
        # 单独 token 化 prompt，用来知道 prompt 长度。

        full_tokens = tokenizer(
            full_text,
            truncation=True,
            max_length=max_seq_length,
            add_special_tokens=False,
        )
        # token 化完整对话，用来得到真正训练输入。

        input_ids = full_tokens["input_ids"]
        # 训练输入 token 序列。

        prompt_len = min(len(prompt_tokens["input_ids"]), len(input_ids))
        # prompt 长度。
        # 用 min 是为了防止截断后 prompt 比 full 更长这种边界问题。

        labels = [-100] * prompt_len + input_ids[prompt_len:]
        # 这是这个项目里最关键的一行之一：
        # - prompt 区域全部设成 -100，不参与 loss
        # - assistant 答案区域用真实 token id，参与 loss

        valid = any(label != -100 for label in labels)
        # 如果整条样本被截断到连 assistant 都没剩下，那就视为无效样本。

        return {
            "input_ids": input_ids,
            # 输入 token 序列。

            "attention_mask": full_tokens["attention_mask"],
            # 注意力 mask。

            "labels": labels,
            # 监督目标。

            "valid": valid,
            # 记录这一条是否仍然有有效监督信号。
        }

    tokenized = dataset.map(
        tokenize_record,
        remove_columns=dataset.column_names,
        desc="Tokenizing dataset",
    )
    # 对整个 Dataset 做 map，把原始列替换成 token 化后的列。

    return tokenized.filter(lambda row: row["valid"]).remove_columns(["valid"])
    # 过滤掉无效样本，再删掉辅助字段 valid。


class SupervisedDataCollator:
    # 这个 DataCollator 专门用于 chat-format SFT。
    # 它会把不同长度样本 pad 成同一长度，并正确处理 labels。

    def __init__(self, tokenizer: AutoTokenizer) -> None:
        # 初始化时只需要记住 tokenizer。
        self.tokenizer = tokenizer

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, torch.Tensor]:
        # Trainer 每凑出一个 batch，就会调用这个 collator。
        batch = self.tokenizer.pad(
            [
                {
                    "input_ids": feature["input_ids"],
                    "attention_mask": feature["attention_mask"],
                }
                for feature in features
            ],
            padding=True,
            return_tensors="pt",
        )
        # 先对 input_ids 和 attention_mask 做标准 pad。

        labels = torch.full(batch["input_ids"].shape, -100, dtype=torch.long)
        # 先创建一个与 input_ids 同形状的 labels 张量，默认全是 -100。
        # 这样 pad 出来的区域天然不会参与 loss。

        for row_idx, feature in enumerate(features):
            # 再把每条样本自己的 labels 写回对应前缀位置。
            label_tensor = torch.tensor(feature["labels"], dtype=torch.long)
            labels[row_idx, : label_tensor.shape[0]] = label_tensor

        batch["labels"] = labels
        # 把 labels 填回 batch。

        return batch
        # 返回 Trainer 可直接消费的张量字典。


def build_model(args: argparse.Namespace) -> AutoModelForCausalLM:
    # 这个函数负责加载 base model，并挂上 LoRA。
    dtype = compute_dtype()
    # 先决定计算 dtype。

    quant_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=dtype,
    )
    # 这里明确使用 4-bit QLoRA：
    # - load_in_4bit=True：底座模型以 4bit 量化方式加载
    # - nf4：常用的量化类型
    # - double quant：进一步优化量化存储
    # - compute dtype：训练时的实际计算精度

    offload_dir = resolve_path(args.offload_dir)
    # 解析 offload 目录路径。

    offload_dir.mkdir(parents=True, exist_ok=True)
    # 确保 offload 目录存在。

    model_kwargs: dict[str, Any] = {
        "quantization_config": quant_config,
        # 告诉 transformers 用 4bit 量化加载模型。

        "torch_dtype": dtype,
        # 指定主要计算精度。

        "low_cpu_mem_usage": True,
        # 尽量降低 CPU 侧加载峰值内存。

        "offload_folder": str(offload_dir),
        # offload 目录位置。

        "offload_state_dict": True,
        # 允许把部分状态 offload 到磁盘。
    }

    if args.attn_implementation:
        # 如果配置了注意力实现方式，就透传给模型加载。
        model_kwargs["attn_implementation"] = args.attn_implementation

    if torch.cuda.is_available():
        # 如果当前能用 CUDA，就进一步配置自动 device map 和显存上限。
        model_kwargs["device_map"] = "auto"
        # 让 transformers 自动决定模块分配到哪。

        model_kwargs["max_memory"] = {
            0: f"{args.gpu_memory_limit_mib}MiB",
            "cpu": f"{args.cpu_memory_limit_gib}GiB",
        }
        # 明确 GPU/CPU 的内存预算。

    model = AutoModelForCausalLM.from_pretrained(args.model_name_or_path, **model_kwargs)
    # 真正加载底座模型。

    model.config.use_cache = False
    # 训练时通常关闭 KV cache，避免和梯度检查点冲突。

    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    # 让量化模型进入 k-bit 训练模式。
    # 同时启用 gradient checkpointing，以节省显存。

    target_modules = [item.strip() for item in args.target_modules.split(",") if item.strip()]
    # 把逗号分隔的 target_modules 字符串转成列表。

    lora_config = LoraConfig(
        r=args.lora_r,
        # LoRA rank。

        lora_alpha=args.lora_alpha,
        # LoRA 缩放参数。

        lora_dropout=args.lora_dropout,
        # LoRA dropout。

        target_modules=target_modules,
        # LoRA 注入的目标层。

        bias="none",
        # 不单独训练 bias。

        task_type="CAUSAL_LM",
        # 任务类型：因果语言模型。
    )

    model = get_peft_model(model, lora_config)
    # 真正把 LoRA adapter 挂到模型上。

    model.print_trainable_parameters()
    # 打印可训练参数规模，方便确认是否真的是 PEFT 小参数训练。

    return model
    # 返回“底座 + LoRA”后的可训练模型。


def main() -> None:
    # 脚本主入口。
    args = parse_args()
    # 解析参数。

    set_seed(args.seed)
    # 固定随机种子，尽量提高复现性。

    print("Starting Qwen3 LoRA training run", flush=True)
    # 打印训练开始提示。

    print(json.dumps(vars(args), ensure_ascii=False, indent=2), flush=True)
    # 把当前最终参数完整打印出来，便于日志审计。

    if torch.cuda.is_available():
        # 如果有 CUDA，就打开 TF32 优化。
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        print(f"CUDA available: {torch.cuda.get_device_name(0)}", flush=True)
        # 打印当前 GPU 名称。

    dataset_dir = resolve_path(args.dataset_dir)
    # 解析数据集目录。

    output_dir = resolve_path(args.output_dir)
    # 解析输出目录。

    logging_dir = resolve_path(args.logging_dir)
    # 解析 TensorBoard 日志目录。

    output_dir.mkdir(parents=True, exist_ok=True)
    # 确保输出目录存在。

    logging_dir.mkdir(parents=True, exist_ok=True)
    # 确保日志目录存在。

    tokenizer = build_tokenizer(args.model_name_or_path)
    # 加载并处理 tokenizer。

    print(f"Tokenizer loaded from {args.model_name_or_path}", flush=True)
    # 打印 tokenizer 加载信息。

    dataset = load_jsonl_dataset(dataset_dir)
    # 读取 train/validation/test JSONL。

    train_dataset = tokenize_dataset(dataset["train"], tokenizer, args.max_seq_length)
    # token 化训练集。

    eval_dataset = tokenize_dataset(dataset["validation"], tokenizer, args.max_seq_length)
    # token 化验证集。

    print(
        f"Prepared tokenized datasets: train={len(train_dataset)} validation={len(eval_dataset)}",
        flush=True,
    )
    # 打印 token 化后数据集规模。

    effective_batch_size = args.per_device_train_batch_size * args.gradient_accumulation_steps
    # 估算有效 batch 大小。

    approx_steps_per_epoch = max(1, math.ceil(len(train_dataset) / effective_batch_size))
    # 估算每个 epoch 大约多少个优化 step。

    if args.max_steps and args.max_steps > 0:
        # 如果显式给了 max_steps，就按它估总步数。
        approx_total_steps = args.max_steps
    else:
        # 否则按 epoch 数估算总步数。
        approx_total_steps = int(math.ceil(args.num_train_epochs * approx_steps_per_epoch))

    print(
        json.dumps(
            {
                "effective_batch_size": effective_batch_size,
                "approx_steps_per_epoch": approx_steps_per_epoch,
                "approx_total_steps": approx_total_steps,
            },
            ensure_ascii=False,
            indent=2,
        ),
        flush=True,
    )
    # 把训练规模估算打印出来，帮助理解当前配置到底意味着什么。

    model = build_model(args)
    # 加载底座模型并挂上 LoRA。

    print("Base model loaded and LoRA adapters attached", flush=True)
    # 打印模型准备完成提示。

    resolved_config = {
        key: (str(value) if isinstance(value, Path) else value)
        for key, value in vars(args).items()
    }
    # 把参数整理成可 JSON 序列化的版本。
    # 主要是把 Path 转成字符串。

    (output_dir / "resolved_config.json").write_text(
        json.dumps(resolved_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # 把最终实际生效的训练配置落盘。

    training_args = TrainingArguments(
        output_dir=str(output_dir),
        # checkpoint 输出目录。

        logging_dir=str(logging_dir),
        # TensorBoard 日志目录。

        per_device_train_batch_size=args.per_device_train_batch_size,
        # 单设备训练 batch。

        per_device_eval_batch_size=args.per_device_eval_batch_size,
        # 单设备评估 batch。

        gradient_accumulation_steps=args.gradient_accumulation_steps,
        # 梯度累积步数。

        learning_rate=args.learning_rate,
        # 学习率。

        weight_decay=args.weight_decay,
        # 权重衰减。

        warmup_ratio=args.warmup_ratio,
        # 学习率预热比例。

        num_train_epochs=args.num_train_epochs,
        # epoch 数。

        max_steps=args.max_steps,
        # 最大 step 数。

        logging_steps=args.logging_steps,
        # 日志频率。

        evaluation_strategy="steps",
        # 评估按 step 触发。

        eval_steps=args.eval_steps,
        # 每多少 step 评估一次。

        save_strategy="steps",
        # 保存也按 step 触发。

        save_steps=args.save_steps,
        # 每多少 step 保存一次。

        save_total_limit=args.save_total_limit,
        # 最多保留多少个 checkpoint。

        bf16=compute_dtype() == torch.bfloat16,
        # 如果当前计算 dtype 是 bf16，就启用 bf16 训练。

        fp16=compute_dtype() == torch.float16,
        # 如果当前计算 dtype 是 fp16，就启用 fp16 训练。

        optim="paged_adamw_8bit",
        # 优化器使用 paged_adamw_8bit，适合 QLoRA 显存场景。

        lr_scheduler_type="cosine",
        # 学习率调度器：cosine。

        report_to=["tensorboard"],
        # 把训练日志发到 TensorBoard。

        gradient_checkpointing=True,
        # 启用梯度检查点，省显存。

        remove_unused_columns=False,
        # 不删除 dataset 里未显式使用的列。
        # 对自定义 collator / map 结果更稳。

        dataloader_num_workers=0,
        # DataLoader worker 数量。
        # Windows / 某些环境下设 0 更稳。

        save_safetensors=True,
        # 采用 safetensors 格式保存。

        seed=args.seed,
        # 训练随机种子。

        data_seed=args.seed,
        # 数据随机种子。

        disable_tqdm=False,
        # 不禁用 tqdm 进度条。

        logging_first_step=True,
        # 第一个 step 就打印日志。
    )

    trainer = Trainer(
        model=model,
        # LoRA 后模型。

        args=training_args,
        # 训练参数。

        train_dataset=train_dataset,
        # 训练集。

        eval_dataset=eval_dataset,
        # 验证集。

        data_collator=SupervisedDataCollator(tokenizer),
        # 自定义 collator，确保 labels pad 正确。

        tokenizer=tokenizer,
        # 传 tokenizer 给 Trainer，便于保存和某些内部处理。
    )

    print("Trainer initialized, starting train()", flush=True)
    # 打印开始训练提示。

    trainer.train()
    # 真正开始训练。

    print("Training finished, saving adapter", flush=True)
    # 打印训练结束提示。

    trainer.save_model(str(output_dir / "final_adapter"))
    # 保存最终 adapter。
    # 对 LoRA/PEFT 场景来说，这里保存的是 adapter 权重，而不是整份 base model。

    tokenizer.save_pretrained(str(output_dir / "final_adapter"))
    # 把 tokenizer 也保存到同一个目录，便于后续直接加载使用。

    trainer.save_state()
    # 保存 Trainer 自己的训练状态信息。

    print("Run complete", flush=True)
    # 打印收尾提示。


if __name__ == "__main__":
    # 标准脚本入口。
    main()
