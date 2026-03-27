from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from tools.eval.common import normalize_whitespace, read_json, resolve_path
from tools.mermaid_prompting import MERMAID_GENERATION_SYSTEM_PROMPT, build_final_diagram_user_prompt


SYSTEM_PROMPT = MERMAID_GENERATION_SYSTEM_PROMPT

DEFAULT_SOURCE_DIR = (
    "versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228"
)
DEFAULT_SPLIT_DIR = (
    "versions/v3_2026-02-27_latest_9k_cscw/dataset/stream2graph_dataset/release_v3_20260228/splits"
)


@dataclass
class EvaluationSample:
    sample_id: str
    split: str
    diagram_type: str
    prompt: str
    reference_code: str
    source_path: str
    dialogue_turns: int
    metadata: dict
    raw_sample: dict


def load_split_ids(split_dir: Path) -> dict[str, list[str]]:
    split_map: dict[str, list[str]] = {}
    for split_name, file_name in (
        ("train", "train_ids.json"),
        ("validation", "validation_ids.json"),
        ("test", "test_ids.json"),
    ):
        payload = read_json(split_dir / file_name)
        split_map[split_name] = payload["ids"]
    return split_map


def render_dialogue(dialogue: Iterable[dict]) -> str:
    rendered: list[str] = []
    for turn in dialogue:
        turn_id = turn.get("turn_id", "?")
        role = turn.get("role", "Unknown")
        action = turn.get("action_type", "unknown")
        elements = turn.get("elements_involved") or []
        header = f"Turn {turn_id} | {role} | {action}"
        if elements:
            header += f" | elements: {', '.join(elements)}"
        body = normalize_whitespace(turn.get("utterance", ""))
        rendered.append(f"{header}\n{body}")
    return "\n\n".join(rendered)


def build_user_prompt(sample: dict) -> str:
    dialogue = render_dialogue(sample["cscw_dialogue"])
    return build_final_diagram_user_prompt(
        dialogue,
        sample_id=str(sample["id"]),
        diagram_type=str(sample.get("diagram_type", "unknown")),
        current_best=False,
    )


def build_messages(sample: EvaluationSample) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": sample.prompt},
    ]


def load_evaluation_samples(
    source_dir: str | Path = DEFAULT_SOURCE_DIR,
    split_dir: str | Path = DEFAULT_SPLIT_DIR,
    split: str = "test",
    max_samples: int = 0,
    sample_ids: Optional[set[str]] = None,
) -> list[EvaluationSample]:
    source_dir = resolve_path(source_dir)
    split_dir = resolve_path(split_dir)
    split_map = load_split_ids(split_dir)

    if split == "all":
        ordered_ids: list[tuple[str, str]] = []
        for split_name in ("train", "validation", "test"):
            ordered_ids.extend((sample_id, split_name) for sample_id in split_map[split_name])
    else:
        ordered_ids = [(sample_id, split) for sample_id in split_map[split]]

    rows: list[EvaluationSample] = []
    for sample_id, sample_split in ordered_ids:
        if sample_ids is not None and sample_id not in sample_ids:
            continue
        sample_path = source_dir / f"{sample_id}.json"
        if not sample_path.exists():
            continue
        raw = json.loads(sample_path.read_text(encoding="utf-8"))
        rows.append(
            EvaluationSample(
                sample_id=sample_id,
                split=sample_split,
                diagram_type=str(raw.get("diagram_type", "unknown")),
                prompt=build_user_prompt(raw),
                reference_code=str(raw.get("code", "")).rstrip() + "\n",
                source_path=str(sample_path),
                dialogue_turns=len(raw.get("cscw_dialogue", [])),
                metadata={
                    "source": raw.get("source"),
                    "license": raw.get("license"),
                    "compilation_status": raw.get("compilation_status"),
                    "dialogue_metadata": raw.get("dialogue_metadata", {}),
                    "extra": raw.get("extra", {}),
                },
                raw_sample=raw,
            )
        )
        if max_samples > 0 and len(rows) >= max_samples:
            break
    return rows


def sample_to_transcript_rows(
    sample: EvaluationSample,
    interval_ms: int = 450,
    expected_intent_map: Optional[dict[str, str]] = None,
) -> list[dict]:
    rows: list[dict] = []
    dialogue = sample.raw_sample.get("cscw_dialogue", [])
    timestamp_ms = 0
    for turn in dialogue:
        utterance = normalize_whitespace(turn.get("utterance", ""))
        if not utterance:
            continue
        action_type = str(turn.get("action_type", ""))
        rows.append(
            {
                "timestamp_ms": timestamp_ms,
                "text": utterance,
                "speaker": str(turn.get("role", "user")),
                "is_final": True,
                "expected_intent": (
                    expected_intent_map.get(action_type) if expected_intent_map else None
                ),
                "metadata": {
                    "action_type": action_type,
                    "turn_id": turn.get("turn_id"),
                    "is_repair": bool(turn.get("is_repair", False)),
                },
            }
        )
        timestamp_ms += interval_ms
    return rows
