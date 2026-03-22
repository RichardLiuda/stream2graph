#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    Trainer,
    TrainingArguments,
    set_seed,
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_path(raw: str) -> Path:
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    return repo_root() / candidate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="QLoRA fine-tuning entrypoint for Qwen3.5 on incremental Stream2Graph.")
    parser.add_argument("--config", type=str, default="")
    parser.add_argument("--model-name-or-path", type=str, default="Qwen/Qwen3.5-4B")
    parser.add_argument("--dataset-dir", type=str, default="data/finetune/incremental_gate_sft_local_smoke")
    parser.add_argument("--output-dir", type=str, default="artifacts/finetune/qwen35_4b_incremental_gate_local_smoke")
    parser.add_argument("--logging-dir", type=str, default="reports/finetune/tensorboard/qwen35_4b_incremental_gate_local_smoke")
    parser.add_argument("--offload-dir", type=str, default="artifacts/finetune/offload/qwen35_4b_incremental_gate_local_smoke")
    parser.add_argument("--max-seq-length", type=int, default=1024)
    parser.add_argument("--per-device-train-batch-size", type=int, default=1)
    parser.add_argument("--per-device-eval-batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--weight-decay", type=float, default=0.0)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--num-train-epochs", type=float, default=1.0)
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument("--logging-steps", type=int, default=5)
    parser.add_argument("--eval-steps", type=int, default=20)
    parser.add_argument("--save-steps", type=int, default=20)
    parser.add_argument("--save-total-limit", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=int, default=16)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument(
        "--target-modules",
        type=str,
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
    )
    parser.add_argument("--gpu-memory-limit-mib", type=int, default=24000)
    parser.add_argument("--cpu-memory-limit-gib", type=int, default=64)
    parser.add_argument("--attn-implementation", type=str, default="sdpa")

    pre_args, _ = parser.parse_known_args()
    if pre_args.config:
        config_payload = json.loads(resolve_path(pre_args.config).read_text(encoding="utf-8"))
        parser.set_defaults(**config_payload)
    return parser.parse_args()


def render_chat(tokenizer: AutoTokenizer, messages: list[dict[str, str]], add_generation_prompt: bool) -> str:
    try:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=add_generation_prompt,
            enable_thinking=False,
        )
    except TypeError:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=add_generation_prompt,
        )


def compute_dtype() -> torch.dtype:
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


def load_jsonl_dataset(dataset_dir: Path):
    files = {
        "train": str(dataset_dir / "train.jsonl"),
        "validation": str(dataset_dir / "validation.jsonl"),
        "test": str(dataset_dir / "test.jsonl"),
    }
    data_files = {name: path for name, path in files.items() if Path(path).exists()}
    return load_dataset("json", data_files=data_files)


def build_tokenizer(model_name_or_path: str) -> AutoTokenizer:
    tokenizer = AutoTokenizer.from_pretrained(model_name_or_path, use_fast=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"
    return tokenizer


def tokenize_dataset(dataset, tokenizer: AutoTokenizer, max_seq_length: int):
    def tokenize_record(record: dict[str, Any]) -> dict[str, Any]:
        prompt_messages = record["messages"][:-1]
        full_messages = record["messages"]
        prompt_text = render_chat(tokenizer, prompt_messages, add_generation_prompt=True)
        full_text = render_chat(tokenizer, full_messages, add_generation_prompt=False)

        prompt_tokens = tokenizer(
            prompt_text,
            truncation=True,
            max_length=max_seq_length,
            add_special_tokens=False,
        )
        full_tokens = tokenizer(
            full_text,
            truncation=True,
            max_length=max_seq_length,
            add_special_tokens=False,
        )

        input_ids = full_tokens["input_ids"]
        prompt_len = min(len(prompt_tokens["input_ids"]), len(input_ids))
        labels = [-100] * prompt_len + input_ids[prompt_len:]
        valid = any(label != -100 for label in labels)

        return {
            "input_ids": input_ids,
            "attention_mask": full_tokens["attention_mask"],
            "labels": labels,
            "valid": valid,
        }

    tokenized = dataset.map(
        tokenize_record,
        remove_columns=dataset.column_names,
        desc="Tokenizing dataset",
    )
    return tokenized.filter(lambda row: row["valid"]).remove_columns(["valid"])


class SupervisedDataCollator:
    def __init__(self, tokenizer: AutoTokenizer) -> None:
        self.tokenizer = tokenizer

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, torch.Tensor]:
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
        labels = torch.full(batch["input_ids"].shape, -100, dtype=torch.long)
        for row_idx, feature in enumerate(features):
            label_tensor = torch.tensor(feature["labels"], dtype=torch.long)
            labels[row_idx, : label_tensor.shape[0]] = label_tensor
        batch["labels"] = labels
        return batch


def build_model(args: argparse.Namespace) -> AutoModelForCausalLM:
    dtype = compute_dtype()
    quant_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=dtype,
    )
    offload_dir = resolve_path(args.offload_dir)
    offload_dir.mkdir(parents=True, exist_ok=True)

    model_kwargs: dict[str, Any] = {
        "quantization_config": quant_config,
        "torch_dtype": dtype,
        "low_cpu_mem_usage": True,
        "offload_folder": str(offload_dir),
        "offload_state_dict": True,
    }

    if args.attn_implementation:
        model_kwargs["attn_implementation"] = args.attn_implementation

    if torch.cuda.is_available():
        model_kwargs["device_map"] = "auto"
        model_kwargs["max_memory"] = {
            0: f"{args.gpu_memory_limit_mib}MiB",
            "cpu": f"{args.cpu_memory_limit_gib}GiB",
        }

    model = AutoModelForCausalLM.from_pretrained(args.model_name_or_path, **model_kwargs)
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)

    target_modules = [item.strip() for item in args.target_modules.split(",") if item.strip()]
    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    return model


def main() -> None:
    args = parse_args()
    set_seed(args.seed)
    print("Starting Qwen3 LoRA training run", flush=True)
    print(json.dumps(vars(args), ensure_ascii=False, indent=2), flush=True)

    if torch.cuda.is_available():
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        print(f"CUDA available: {torch.cuda.get_device_name(0)}", flush=True)

    dataset_dir = resolve_path(args.dataset_dir)
    output_dir = resolve_path(args.output_dir)
    logging_dir = resolve_path(args.logging_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    logging_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = build_tokenizer(args.model_name_or_path)
    print(f"Tokenizer loaded from {args.model_name_or_path}", flush=True)
    dataset = load_jsonl_dataset(dataset_dir)
    train_dataset = tokenize_dataset(dataset["train"], tokenizer, args.max_seq_length)
    eval_dataset = tokenize_dataset(dataset["validation"], tokenizer, args.max_seq_length)
    print(
        f"Prepared tokenized datasets: train={len(train_dataset)} validation={len(eval_dataset)}",
        flush=True,
    )
    effective_batch_size = args.per_device_train_batch_size * args.gradient_accumulation_steps
    approx_steps_per_epoch = max(1, math.ceil(len(train_dataset) / effective_batch_size))
    if args.max_steps and args.max_steps > 0:
        approx_total_steps = args.max_steps
    else:
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

    model = build_model(args)
    print("Base model loaded and LoRA adapters attached", flush=True)

    resolved_config = {
        key: (str(value) if isinstance(value, Path) else value)
        for key, value in vars(args).items()
    }
    (output_dir / "resolved_config.json").write_text(
        json.dumps(resolved_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    training_args = TrainingArguments(
        output_dir=str(output_dir),
        logging_dir=str(logging_dir),
        per_device_train_batch_size=args.per_device_train_batch_size,
        per_device_eval_batch_size=args.per_device_eval_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        warmup_ratio=args.warmup_ratio,
        num_train_epochs=args.num_train_epochs,
        max_steps=args.max_steps,
        logging_steps=args.logging_steps,
        evaluation_strategy="steps",
        eval_steps=args.eval_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=args.save_total_limit,
        bf16=compute_dtype() == torch.bfloat16,
        fp16=compute_dtype() == torch.float16,
        optim="paged_adamw_8bit",
        lr_scheduler_type="cosine",
        report_to=["tensorboard"],
        gradient_checkpointing=True,
        remove_unused_columns=False,
        dataloader_num_workers=0,
        save_safetensors=True,
        seed=args.seed,
        data_seed=args.seed,
        disable_tqdm=False,
        logging_first_step=True,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=SupervisedDataCollator(tokenizer),
        tokenizer=tokenizer,
    )

    print("Trainer initialized, starting train()", flush=True)
    trainer.train()
    print("Training finished, saving adapter", flush=True)
    trainer.save_model(str(output_dir / "final_adapter"))
    tokenizer.save_pretrained(str(output_dir / "final_adapter"))
    trainer.save_state()
    print("Run complete", flush=True)


if __name__ == "__main__":
    main()
