from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import json5
from json_repair import repair_json

from tools.eval.common import read_json, strip_code_fences, utc_iso, write_json
from tools.incremental_dataset.minimax_client import MiniMaxChatClient, MiniMaxResult, QuotaPauseRequested


ROLE_PROMPTS = {
    "stage_planner": (
        "You are StagePlanner. Turn a staged GraphIR construction record into stage cards for future dialogue generation. "
        "Return strict JSON only with keys: stage_cards. Each stage card must contain stage_index, title, intent, "
        "new_elements, forbidden_future_elements, and dialogue_goal."
    ),
    "dialogue_writer": (
        "You are DialogueWriter. Generate one continuous collaborative Chinese dialogue for the full chart, based on the stage cards. "
        "The dialogue must progress stage by stage, must not mention future elements too early, and must remain coherent across turns. "
        "Return strict JSON only with keys: dialogue_language, conversation_title, turns, stage_boundaries."
    ),
    "turn_aligner": (
        "You are TurnAligner. Re-check stage alignment for a generated continuous dialogue. "
        "Return strict JSON only with keys: aligned_turns, trigger_turns, notes."
    ),
    "verifier": (
        "You are Verifier. Inspect the structural stages and the aligned dialogue. "
        "Check continuity, stage fidelity, future leakage, and missing elements. "
        "Return strict JSON only with keys: status, issues, repair_required, repair_instructions, summary."
    ),
}


class AgentClusterRunner:
    def __init__(self, client: MiniMaxChatClient, output_root: Path) -> None:
        self.client = client
        self.output_root = output_root
        self.output_root.mkdir(parents=True, exist_ok=True)

    def run_sample(self, structural_payload: dict[str, Any]) -> dict[str, Any]:
        sample_id = str(structural_payload["sample_id"])
        target_path = self.output_root / f"{sample_id}.json"
        existing = read_json(target_path) if target_path.exists() else {}
        record: dict[str, Any] = existing or {
            "sample_id": sample_id,
            "diagram_type": structural_payload.get("diagram_type"),
            "status": "in_progress",
            "started_at_utc": utc_iso(),
        }
        record["status"] = "in_progress"
        record["updated_at_utc"] = utc_iso()

        try:
            if "stage_planner" not in record:
                record["stage_planner"] = self._run_stage_planner(structural_payload)
                write_json(target_path, record)
            if "dialogue_writer" not in record:
                record["dialogue_writer"] = self._run_dialogue_writer(structural_payload, record["stage_planner"]["result"])
                write_json(target_path, record)
            if "turn_aligner" not in record:
                record["turn_aligner"] = self._run_turn_aligner(
                    structural_payload,
                    record["dialogue_writer"]["result"],
                )
                write_json(target_path, record)
            if "verifier" not in record:
                try:
                    record["verifier"] = self._run_verifier(
                        structural_payload,
                        record["dialogue_writer"]["result"],
                        record["turn_aligner"]["result"],
                    )
                except Exception as exc:
                    record["verifier"] = {
                        "role": "verifier",
                        "error": str(exc),
                    }
                write_json(target_path, record)
            verification = record["verifier"].get("result", {})
            record["final_dialogue"] = record["dialogue_writer"]["result"]
            record["final_alignment"] = record["turn_aligner"]["result"]
            record["verification_summary"] = verification
            record.pop("error", None)
            record.pop("warning", None)
            if "result" in record["verifier"]:
                record["status"] = "completed"
            else:
                record["status"] = "completed_with_warnings"
                record["warning"] = record["verifier"].get("error", "verifier failed without a recorded message")
            record["completed_at_utc"] = utc_iso()
            record["updated_at_utc"] = record["completed_at_utc"]
            write_json(target_path, record)
            return record
        except QuotaPauseRequested:
            record["status"] = "paused_for_quota"
            record["updated_at_utc"] = utc_iso()
            write_json(target_path, record)
            raise
        except Exception as exc:
            record["status"] = "error"
            record["error"] = str(exc)
            record["updated_at_utc"] = utc_iso()
            write_json(target_path, record)
            return record

    def _run_stage_planner(self, structural_payload: dict[str, Any]) -> dict[str, Any]:
        prompt = {
            "sample_id": structural_payload["sample_id"],
            "diagram_type": structural_payload["diagram_type"],
            "complexity_profile": structural_payload["profile"],
            "stages": [
                {
                    "stage_index": stage["stage_index"],
                    "stage_name": stage["stage_name"],
                    "stage_description": stage["stage_description"],
                    "delta_ops": stage["delta_ops"],
                    "graph_counts": stage["metrics"],
                }
                for stage in structural_payload["stages"]
            ],
        }
        return self._call_role("stage_planner", prompt)

    def _run_dialogue_writer(self, structural_payload: dict[str, Any], stage_plan: dict[str, Any]) -> dict[str, Any]:
        prompt = {
            "sample_id": structural_payload["sample_id"],
            "diagram_type": structural_payload["diagram_type"],
            "final_graph_summary": structural_payload["profile"],
            "stage_cards": stage_plan.get("stage_cards", []),
            "stage_summaries": [
                {
                    "stage_index": stage["stage_index"],
                    "stage_name": stage["stage_name"],
                    "stage_description": stage["stage_description"],
                    "delta_ops": stage["delta_ops"],
                }
                for stage in structural_payload["stages"]
            ],
        }
        return self._call_role("dialogue_writer", prompt)

    def _run_turn_aligner(self, structural_payload: dict[str, Any], dialogue_payload: dict[str, Any]) -> dict[str, Any]:
        prompt = {
            "sample_id": structural_payload["sample_id"],
            "diagram_type": structural_payload["diagram_type"],
            "stages": [
                {
                    "stage_index": stage["stage_index"],
                    "stage_name": stage["stage_name"],
                    "delta_ops": stage["delta_ops"],
                }
                for stage in structural_payload["stages"]
            ],
            "dialogue": dialogue_payload,
        }
        return self._call_role("turn_aligner", prompt)

    def _run_verifier(
        self,
        structural_payload: dict[str, Any],
        dialogue_payload: dict[str, Any],
        alignment_payload: dict[str, Any],
    ) -> dict[str, Any]:
        prompt = {
            "sample_id": structural_payload["sample_id"],
            "diagram_type": structural_payload["diagram_type"],
            "stages": [
                {
                    "stage_index": stage["stage_index"],
                    "stage_name": stage["stage_name"],
                    "stage_description": stage["stage_description"],
                    "delta_ops": stage["delta_ops"],
                }
                for stage in structural_payload["stages"]
            ],
            "dialogue": dialogue_payload,
            "alignment": alignment_payload,
        }
        return self._call_role("verifier", prompt)

    def _call_role(self, role_name: str, prompt_payload: dict[str, Any]) -> dict[str, Any]:
        system_prompt = ROLE_PROMPTS[role_name]
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(prompt_payload, ensure_ascii=False, indent=2)},
        ]
        last_result: MiniMaxResult | None = None
        last_error: Exception | None = None
        for attempt in range(3):
            result = self.client.chat(messages)
            last_result = result
            try:
                parsed = _parse_json_output(result)
                break
            except Exception as exc:
                last_error = exc
                if not _is_retriable_empty_output(result, exc) or attempt == 2:
                    raise RuntimeError(f"{role_name} parse failed: {exc}") from exc
                time.sleep(1.0 * (attempt + 1))
        else:
            raise RuntimeError(f"{role_name} parse failed: {last_error}")
        return {
            "role": role_name,
            "result": parsed,
            "raw_text": last_result.text if last_result else "",
            "latency_ms": last_result.latency_ms if last_result else 0,
            "usage": last_result.usage if last_result else {},
            "finish_reason": last_result.finish_reason if last_result else "",
            "reasoning": last_result.reasoning if last_result else "",
        }


def _parse_json_output(result: MiniMaxResult) -> dict[str, Any]:
    raw = strip_code_fences(result.text or "")
    if not raw.strip():
        raise ValueError("empty model output")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        candidate = _extract_first_json_object(raw)
        errors: list[str] = []
        for attempt in [candidate, raw]:
            if not attempt:
                continue
            try:
                return json.loads(attempt)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"json:{exc}")
            try:
                repaired = repair_json(attempt)
                if repaired:
                    return json.loads(repaired)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"json_repair:{exc}")
            try:
                parsed = json5.loads(attempt)
                if isinstance(parsed, dict):
                    return parsed
            except Exception as exc:  # noqa: BLE001
                errors.append(f"json5:{exc}")
        raise ValueError("; ".join(errors) if errors else "unable to parse JSON output")


def _extract_first_json_object(text: str) -> str:
    match = re.search(r"(\{.*\})", text, flags=re.DOTALL)
    return match.group(1).strip() if match else ""


def _is_retriable_empty_output(result: MiniMaxResult, exc: Exception) -> bool:
    raw = strip_code_fences(result.text or "").strip()
    if not raw:
        return True
    message = str(exc).lower()
    return "empty model output" in message
