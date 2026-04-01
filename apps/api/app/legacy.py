from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from app.config import get_settings


settings = get_settings()
REPO_ROOT = settings.repo_root
SCRIPTS_DIR = REPO_ROOT / "versions" / "v3_2026-02-27_latest_9k_cscw" / "scripts"
TOOLS_DIR = REPO_ROOT / "tools"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from asr_stream_adapter import ASRChunk  # noqa: E402
from evaluate_realtime_pipeline import evaluate_payload  # noqa: E402
from incremental_renderer import IncrementalGraphRenderer  # noqa: E402
from run_realtime_pipeline import run_realtime_pipeline  # noqa: E402
from streaming_intent_engine import EngineConfig  # noqa: E402
from tools.eval.dataset import load_evaluation_samples  # noqa: E402
from tools.eval.metrics import MermaidCompileChecker, score_prediction  # noqa: E402
from tools.eval.predictors import build_predictor  # noqa: E402


def run_sample_compare(
    *,
    dataset_dir: str,
    split_dir: str,
    split: str,
    sample_id: str,
    predictors: list[dict[str, Any]],
    compile_command: str = "",
) -> dict[str, Any]:
    samples = load_evaluation_samples(
        source_dir=dataset_dir,
        split_dir=split_dir,
        split=split,
        sample_ids={sample_id},
    )
    if not samples:
        raise ValueError(f"sample not found: {sample_id}")
    sample = samples[0]
    compile_checker = MermaidCompileChecker(compile_command) if compile_command else None

    rows: list[dict[str, Any]] = []
    for predictor_config in predictors:
        predictor = build_predictor(predictor_config)
        try:
            result = predictor.predict(sample)
        finally:
            predictor.close()
        metrics = score_prediction(
            reference_code=sample.reference_code,
            predicted_code=result.generated_code,
            declared_diagram_type=sample.diagram_type,
            compile_checker=compile_checker,
        )
        rows.append(
            {
                "provider": result.provider,
                "model_name": result.model_name,
                "generated_code": result.generated_code,
                "raw_output_text": result.raw_output_text,
                "latency_ms": result.latency_ms,
                "finish_reason": result.finish_reason,
                "usage": result.usage,
                "error": result.error,
                "metrics": metrics,
            }
        )

    return {
        "sample": {
            "sample_id": sample.sample_id,
            "split": sample.split,
            "diagram_type": sample.diagram_type,
            "dialogue_turns": sample.dialogue_turns,
            "source_path": sample.source_path,
            "reference_code": sample.reference_code,
            "prompt": sample.prompt,
            "metadata": sample.metadata,
        },
        "predictions": rows,
    }


def run_realtime_payload(
    chunks: list[dict[str, Any]],
    *,
    realtime: bool,
    time_scale: float,
    min_wait_k: int,
    base_wait_k: int,
    max_wait_k: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    asr_chunks = [
        ASRChunk(
            timestamp_ms=int(item["timestamp_ms"]),
            text=str(item["text"]),
            speaker=str(item.get("speaker", "user")),
            is_final=bool(item.get("is_final", True)),
            expected_intent=item.get("expected_intent"),
            metadata=item.get("metadata", {}) if isinstance(item.get("metadata"), dict) else {},
        )
        for item in chunks
    ]
    payload = run_realtime_pipeline(
        chunks=asr_chunks,
        realtime=realtime,
        time_scale=time_scale,
        max_chunks=0,
        config=EngineConfig(min_wait_k=min_wait_k, base_wait_k=base_wait_k, max_wait_k=max_wait_k),
    )
    evaluation = evaluate_payload(payload)
    return payload, evaluation


def write_json_artifact(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_markdown_artifact(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_temp_config(payload: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    config_path = output_dir / "config.json"
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return config_path


def run_eval_suite_subprocess(config_payload: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    config_path = write_temp_config(config_payload, output_dir)
    import subprocess

    command = [
        sys.executable,
        str(REPO_ROOT / "tools" / "eval" / "run_eval_suite.py"),
        "--config",
        str(config_path),
    ]
    started_at = time.time()
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        encoding="utf-8",
    )
    stdout_path = output_dir / "suite.stdout.log"
    stderr_path = output_dir / "suite.stderr.log"
    stdout_path.write_text(completed.stdout or "", encoding="utf-8")
    stderr_path.write_text(completed.stderr or "", encoding="utf-8")
    return {
        "command": command,
        "returncode": completed.returncode,
        "duration_seconds": round(time.time() - started_at, 3),
        "stdout_path": str(stdout_path),
        "stderr_path": str(stderr_path),
        "config_path": str(config_path),
    }


def maybe_compile_mermaid(code: str) -> dict[str, Any] | None:
    if not settings.mermaid_compile_command:
        return None
    checker = MermaidCompileChecker(settings.mermaid_compile_command)
    return checker.check(code)
