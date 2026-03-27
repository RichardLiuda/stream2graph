from __future__ import annotations

import difflib
import json
import re
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from tools.eval.common import (
    extract_mermaid_candidate,
    first_nonempty_line,
    nonempty_lines,
    normalize_whitespace,
    sha256_text,
)

GRAPH_LIKE_TYPES = {
    "architecture",
    "block-beta",
    "c4context",
    "class",
    "er",
    "flowchart",
    "gitgraph",
    "graph",
    "mindmap",
    "packet-beta",
    "requirementdiagram",
    "sequence",
    "statediagram",
    "statediagram-v2",
}

EDGE_PATTERN = re.compile(
    r"([A-Za-z][A-Za-z0-9_]{0,63})[^\n]*?"
    r"(<?[-.=ox]+>?|-->|==>|-.->|->>|-->>|<<--|<--|<->)"
    r"(?:\|[^|]*\|)?[^\n]*?([A-Za-z][A-Za-z0-9_]{0,63})"
)
NODE_DECL_PATTERN = re.compile(
    r"\b([A-Za-z][A-Za-z0-9_]{0,63})\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|>[^<\n]*])"
)
SEQUENCE_ACTOR_PATTERN = re.compile(
    r"\b(participant|actor|database|entity|queue|boundary|control|collections?)\s+([A-Za-z][A-Za-z0-9_]{0,63})",
    flags=re.IGNORECASE,
)
LABEL_PATTERN = re.compile(
    r"(?:\[[^\]]*([A-Za-z][A-Za-z0-9 _-]{1,80})[^\]]*])|"
    r"(?:\(([^)]{1,80})\))|"
    r"(?:as\s+([A-Za-z][A-Za-z0-9 _-]{1,80}))",
    flags=re.IGNORECASE,
)
GRAPH_HEADER_PATTERN = re.compile(r"^(graph|flowchart)(?:\s+([A-Za-z]{2}))?(?:\s*;\s*(.+))?$", flags=re.IGNORECASE)
GRAPH_NODE_PATTERN = r"[A-Za-z][A-Za-z0-9_]{0,63}(?:\s*(?:\[[^\]\n]*\]|\([^\)\n]*\)|\{[^}\n]*\}|>[^<\n]*\]))?"
GRAPH_BARE_EDGE_PATTERN = re.compile(
    rf"(?P<lhs>{GRAPH_NODE_PATTERN})\s+--\s+(?P<rhs>{GRAPH_NODE_PATTERN})(?=$|\s+[A-Za-z])"
)
GRAPH_STATEMENT_BOUNDARY_PATTERNS = (
    re.compile(
        r"(?<=[\]\)\}])\s+(?=[A-Za-z][A-Za-z0-9_]{0,63}\s*(?:\[|\(|\{|>|-->|==>|-.->|->>|-->>|<<--|<--|<->|---|--\s))"
    ),
    re.compile(r"(?<=[A-Za-z0-9_])\s+(?=[A-Za-z][A-Za-z0-9_]{0,63}\s*(?:-->|==>|-.->|->>|-->>|<<--|<--|<->|---|--\s))"),
)
GRAPH_CONTROL_PREFIXES = ("subgraph ", "end", "class ", "classDef ", "style ", "linkStyle ", "click ")


def _leading_diagram_type(lines: list[str]) -> str:
    for line in lines:
        lower = line.strip().lower()
        if not lower:
            continue
        if lower == "---" or lower.startswith("title:") or lower.startswith("%%{") or lower.startswith("%%"):
            continue
        return canonical_diagram_type(lower.split()[0])
    return "unknown"


def _split_top_level_statements(line: str) -> list[str]:
    parts: list[str] = []
    buffer: list[str] = []
    square_depth = 0
    round_depth = 0
    curly_depth = 0
    quote_char: str | None = None

    for char in line:
        if quote_char:
            buffer.append(char)
            if char == quote_char:
                quote_char = None
            continue
        if char in {"'", '"'}:
            quote_char = char
            buffer.append(char)
            continue
        if char == "[":
            square_depth += 1
        elif char == "]":
            square_depth = max(0, square_depth - 1)
        elif char == "(":
            round_depth += 1
        elif char == ")":
            round_depth = max(0, round_depth - 1)
        elif char == "{":
            curly_depth += 1
        elif char == "}":
            curly_depth = max(0, curly_depth - 1)
        elif char == ";" and square_depth == 0 and round_depth == 0 and curly_depth == 0:
            chunk = "".join(buffer).strip()
            if chunk:
                parts.append(chunk)
            buffer = []
            continue
        buffer.append(char)

    chunk = "".join(buffer).strip()
    if chunk:
        parts.append(chunk)
    return parts


def _normalize_graph_statement(statement: str) -> list[str]:
    repaired = statement.strip()
    if not repaired:
        return []
    repaired = GRAPH_BARE_EDGE_PATTERN.sub(lambda match: f"{match.group('lhs')} --> {match.group('rhs')}", repaired)
    previous = None
    while repaired != previous:
        previous = repaired
        for pattern in GRAPH_STATEMENT_BOUNDARY_PATTERNS:
            repaired = pattern.sub("\n", repaired)
    return [part.strip() for part in repaired.splitlines() if part.strip()]


def _normalize_graph_lines(lines: list[str]) -> list[str]:
    normalized: list[str] = []
    header_processed = False

    for line in lines:
        stripped = line.strip()
        lower = stripped.lower()

        if not header_processed and (lower == "---" or lower.startswith("title:") or lower.startswith("%%{") or lower.startswith("%%")):
            normalized.append(stripped)
            continue

        if not header_processed:
            header_match = GRAPH_HEADER_PATTERN.match(stripped)
            if header_match:
                direction = (header_match.group(2) or "TD").upper()
                normalized.append(f"flowchart {direction}")
                remainder = (header_match.group(3) or "").strip()
                header_processed = True
                if remainder:
                    for chunk in _split_top_level_statements(remainder):
                        for part in _normalize_graph_statement(chunk):
                            normalized.append(part)
                continue
            normalized.append(stripped)
            header_processed = True
            continue

        if lower.startswith(GRAPH_CONTROL_PREFIXES):
            normalized.append(stripped)
            continue

        for chunk in _split_top_level_statements(stripped):
            for part in _normalize_graph_statement(chunk):
                normalized.append(part)

    return normalized


def normalize_mermaid(code: str) -> str:
    lines: list[str] = []
    for line in extract_mermaid_candidate(code).replace("\r\n", "\n").splitlines():
        stripped = line.rstrip()
        if not stripped:
            continue
        lines.append(stripped)
    if _leading_diagram_type(lines) == "flowchart":
        lines = _normalize_graph_lines(lines)
    return "\n".join(lines).strip()


def canonical_diagram_type(raw: str) -> str:
    value = (raw or "").strip().lower()
    if value in {"graph", "flowchart"}:
        return "flowchart"
    if value in {"sequencediagram", "sequence"}:
        return "sequence"
    if value.startswith("statediagram"):
        return "statediagram"
    return value or "unknown"


def infer_diagram_type(code: str) -> str:
    lines = nonempty_lines(normalize_mermaid(code))
    for line in lines:
        lower = line.strip().lower()
        if not lower:
            continue
        if lower == "---" or lower.startswith("title:") or lower.startswith("%%{") or lower.startswith("%%"):
            continue
        token = lower.split()[0]
        return canonical_diagram_type(token)
    return "unknown"


def _multiset_prf(reference: list[str], prediction: list[str]) -> dict[str, float]:
    if not reference and not prediction:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not reference:
        return {"precision": 0.0, "recall": 1.0, "f1": 0.0}
    if not prediction:
        return {"precision": 1.0, "recall": 0.0, "f1": 0.0}
    ref_counts = Counter(reference)
    pred_counts = Counter(prediction)
    overlap = sum(min(ref_counts[item], pred_counts[item]) for item in ref_counts.keys() | pred_counts.keys())
    precision = overlap / max(sum(pred_counts.values()), 1)
    recall = overlap / max(sum(ref_counts.values()), 1)
    denom = precision + recall
    f1 = 0.0 if denom == 0 else (2 * precision * recall / denom)
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def tokenize_mermaid(code: str) -> list[str]:
    normalized = normalize_mermaid(code).lower()
    return re.findall(r"[A-Za-z_][A-Za-z0-9_:-]*|[\u4e00-\u9fff]+", normalized)


def extract_graph_features(code: str) -> dict:
    normalized = normalize_mermaid(code)
    diagram_type = infer_diagram_type(normalized)
    nodes: set[str] = set()
    edges: list[str] = []
    labels: list[str] = []

    for match in NODE_DECL_PATTERN.finditer(normalized):
        nodes.add(match.group(1))
    for match in SEQUENCE_ACTOR_PATTERN.finditer(normalized):
        nodes.add(match.group(2))
    for lhs, _connector, rhs in EDGE_PATTERN.findall(normalized):
        nodes.add(lhs)
        nodes.add(rhs)
        edges.append(f"{lhs}->{rhs}")
    for groups in LABEL_PATTERN.findall(normalized):
        label = next((normalize_whitespace(item) for item in groups if item and normalize_whitespace(item)), "")
        if label:
            labels.append(label.lower())

    return {
        "diagram_type": diagram_type,
        "nodes": sorted(nodes),
        "edges": sorted(edges),
        "labels": sorted(labels),
        "graph_like": diagram_type in GRAPH_LIKE_TYPES,
    }


@dataclass
class MermaidCompileChecker:
    command_template: str
    cache_dir: Optional[Path] = None
    timeout_sec: int = 20

    def check(self, code: str) -> dict:
        normalized = normalize_mermaid(code)
        digest = sha256_text(normalized)
        if self.cache_dir is not None:
            cache_path = self.cache_dir / f"{digest}.json"
            if cache_path.exists():
                return json.loads(cache_path.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory(prefix="stream2graph_eval_") as tmp_dir:
            tmp_path = Path(tmp_dir)
            input_path = tmp_path / "candidate.mmd"
            output_path = tmp_path / "candidate.svg"
            input_path.write_text(normalized, encoding="utf-8")
            command = self.command_template.format(input=str(input_path), output=str(output_path))
            try:
                completed = subprocess.run(
                    command,
                    shell=True,
                    check=False,
                    capture_output=True,
                    text=False,
                    timeout=self.timeout_sec,
                )
                stdout_text = completed.stdout.decode("utf-8", errors="replace") if completed.stdout else ""
                stderr_text = completed.stderr.decode("utf-8", errors="replace") if completed.stderr else ""
                payload = {
                    "compile_success": completed.returncode == 0,
                    "returncode": completed.returncode,
                    "stdout": stdout_text[-5000:],
                    "stderr": stderr_text[-5000:],
                    "command": command,
                }
            except subprocess.TimeoutExpired as exc:
                payload = {
                    "compile_success": False,
                    "returncode": None,
                    "stdout": "",
                    "stderr": f"timeout after {exc.timeout}s",
                    "command": command,
                }

        if self.cache_dir is not None:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            cache_path = self.cache_dir / f"{digest}.json"
            cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return payload


def score_prediction(
    reference_code: str,
    predicted_code: str,
    declared_diagram_type: str,
    compile_checker: Optional[MermaidCompileChecker] = None,
) -> dict:
    reference_norm = normalize_mermaid(reference_code)
    prediction_norm = normalize_mermaid(predicted_code)

    reference_lines = [line.strip() for line in nonempty_lines(reference_norm) if not line.strip().startswith("%%")]
    prediction_lines = [line.strip() for line in nonempty_lines(prediction_norm) if not line.strip().startswith("%%")]
    line_scores = _multiset_prf(reference_lines, prediction_lines)

    reference_tokens = tokenize_mermaid(reference_norm)
    prediction_tokens = tokenize_mermaid(prediction_norm)
    token_scores = _multiset_prf(reference_tokens, prediction_tokens)

    ref_features = extract_graph_features(reference_norm)
    pred_features = extract_graph_features(prediction_norm)
    node_scores = _multiset_prf(ref_features["nodes"], pred_features["nodes"])
    edge_scores = _multiset_prf(ref_features["edges"], pred_features["edges"])
    label_scores = _multiset_prf(ref_features["labels"], pred_features["labels"])

    predicted_type = infer_diagram_type(prediction_norm)
    normalized_similarity = difflib.SequenceMatcher(None, reference_norm, prediction_norm).ratio()

    compile_payload = None
    if compile_checker is not None:
        compile_payload = compile_checker.check(prediction_norm)

    return {
        "normalized_exact_match": reference_norm == prediction_norm,
        "normalized_similarity": round(float(normalized_similarity), 4),
        "diagram_type_reference": canonical_diagram_type(declared_diagram_type),
        "diagram_type_predicted": predicted_type,
        "diagram_type_match": predicted_type == canonical_diagram_type(declared_diagram_type),
        "reference_chars": len(reference_norm),
        "prediction_chars": len(prediction_norm),
        "reference_nonempty_lines": len(reference_lines),
        "prediction_nonempty_lines": len(prediction_lines),
        "prediction_to_reference_char_ratio": round(len(prediction_norm) / max(len(reference_norm), 1), 4),
        "line_precision": line_scores["precision"],
        "line_recall": line_scores["recall"],
        "line_f1": line_scores["f1"],
        "token_precision": token_scores["precision"],
        "token_recall": token_scores["recall"],
        "token_f1": token_scores["f1"],
        "graph_like_reference": ref_features["graph_like"],
        "graph_like_prediction": pred_features["graph_like"],
        "node_precision": node_scores["precision"],
        "node_recall": node_scores["recall"],
        "node_f1": node_scores["f1"],
        "edge_precision": edge_scores["precision"],
        "edge_recall": edge_scores["recall"],
        "edge_f1": edge_scores["f1"],
        "label_precision": label_scores["precision"],
        "label_recall": label_scores["recall"],
        "label_f1": label_scores["f1"],
        "compile_success": None if compile_payload is None else compile_payload["compile_success"],
        "compile_returncode": None if compile_payload is None else compile_payload["returncode"],
        "compile_stderr": None if compile_payload is None else compile_payload["stderr"],
    }
