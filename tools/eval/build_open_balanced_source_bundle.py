#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from huggingface_hub import hf_hub_download

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tools.eval.common import resolve_path, sha256_text, utc_iso, write_json
from tools.eval.metrics import canonical_diagram_type, first_nonempty_line, normalize_mermaid
from tools.incremental_dataset.complexity import assign_complexity_buckets, build_profile
from tools.incremental_dataset.mermaid_ir import parse_mermaid_to_graph_ir
from tools.incremental_dataset.schema import SourceSample
from tools.incremental_dataset.selection import _allocate_evenly, assign_splits
from tools.incremental_dataset.source_dataset import DEFAULT_SOURCE_DIR, DEFAULT_SPLIT_DIR, load_source_samples


OPEN_SOURCE_LICENSES = {
    "agpl-3.0",
    "apache-2.0",
    "artistic-2.0",
    "bsd-2-clause",
    "bsd-3-clause",
    "bsl-1.0",
    "cc-by-4.0",
    "cc-by-sa-4.0",
    "cc0-1.0",
    "epl-2.0",
    "gpl-2.0",
    "gpl-3.0",
    "isc",
    "lgpl-2.1",
    "lgpl-3.0",
    "mit",
    "mit-0",
    "mpl-2.0",
    "unlicense",
    "wtfpl",
}

DEFAULT_HF_REPO = "sts07142/mermaid_samples_13k"
DEFAULT_OUTPUT_SOURCE_DIR = "data/incremental_dataset/sources/open_balanced_v1_3600"
DEFAULT_OUTPUT_REPORT_DIR = "reports/evaluation/published/open_balanced_v1_3600_source_build"
DEFAULT_TARGET_PER_TYPE = 600
WEAK_TYPES = ("mindmap", "statediagram", "er")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build an open-license, six-type-balanced Mermaid source bundle for the public benchmark."
    )
    parser.add_argument("--local-source-dir", type=str, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--local-split-dir", type=str, default=DEFAULT_SPLIT_DIR)
    parser.add_argument("--hf-repo", type=str, default=DEFAULT_HF_REPO)
    parser.add_argument("--hf-jsonl", type=str, default="mermaid_samples_13k.jsonl")
    parser.add_argument("--output-source-dir", type=str, default=DEFAULT_OUTPUT_SOURCE_DIR)
    parser.add_argument("--output-report-dir", type=str, default=DEFAULT_OUTPUT_REPORT_DIR)
    parser.add_argument("--target-per-type", type=int, default=DEFAULT_TARGET_PER_TYPE)
    return parser.parse_args()


def _infer_hf_diagram_type(code: str) -> str:
    first = first_nonempty_line(normalize_mermaid(code)).lower().rstrip(";")
    token = first.split()[0] if first else ""
    if token == "architecture-beta":
        return "architecture"
    if token == "erdiagram":
        return "er"
    return canonical_diagram_type(token)


def _entity_count(graph_ir) -> int:
    return len(graph_ir.nodes) + len(graph_ir.edges) + len(graph_ir.groups)


def _sample_to_profile(sample: SourceSample, origin: str) -> tuple[dict[str, Any], dict[str, Any]]:
    graph_ir = parse_mermaid_to_graph_ir(sample)
    profile = build_profile(sample, graph_ir)
    profile["origin"] = origin
    profile["source_url"] = sample.metadata.get("source_url", "")
    profile["license"] = sample.license
    profile["sample_payload"] = {
        "id": sample.sample_id,
        "source": sample.source,
        "source_url": sample.metadata.get("source_url"),
        "diagram_type": sample.diagram_type,
        "code": sample.code,
        "content_size": sample.content_size,
        "compilation_status": sample.compilation_status,
        "license": sample.license,
        "metadata": sample.metadata,
    }
    return profile, {
        "entity_count": _entity_count(graph_ir),
        "graph_ir": graph_ir.to_payload(),
    }


def _load_local_candidates(source_dir: str, split_dir: str) -> list[dict[str, Any]]:
    rows = load_source_samples(source_dir=source_dir, split_dir=split_dir)
    candidates: list[dict[str, Any]] = []
    for sample in rows:
        if sample.license.lower() not in OPEN_SOURCE_LICENSES:
            continue
        profile, stats = _sample_to_profile(sample, origin="local_release_v7")
        if not profile.get("compile_success"):
            continue
        if stats["entity_count"] <= 0:
            continue
        candidates.append(profile)
    return candidates


def _load_hf_candidates(repo_id: str, filename: str) -> list[dict[str, Any]]:
    path = Path(hf_hub_download(repo_id=repo_id, repo_type="dataset", filename=filename))
    candidates: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for index, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            code = str(payload.get("text", ""))
            diagram_type = _infer_hf_diagram_type(code)
            if diagram_type not in WEAK_TYPES:
                continue
            normalized = normalize_mermaid(code)
            code_hash = sha256_text(normalized)
            if code_hash in seen_hashes:
                continue
            seen_hashes.add(code_hash)
            sample = SourceSample(
                sample_id=f"hf_ms13k_{diagram_type}_{index:05d}",
                split="train",
                diagram_type=diagram_type,
                code=code,
                source_path=str(path),
                source="huggingface",
                license="mit",
                compilation_status="success",
                content_size=len(code.encode("utf-8")),
                metadata={
                    "source_url": f"https://huggingface.co/datasets/{repo_id}",
                    "dataset_repo": repo_id,
                    "dataset_file": filename,
                    "hf_row_index": index,
                },
            )
            profile, stats = _sample_to_profile(sample, origin="hf_mermaid_samples_13k")
            if stats["entity_count"] <= 0:
                continue
            candidates.append(profile)
    return candidates


def _sort_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda item: (
            0 if item.get("origin") == "local_release_v7" else 1,
            not bool(item.get("compile_success")),
            bool(item.get("augmented")),
            -float(item.get("complexity_score", 0.0)),
            sha256_text(str(item.get("sample_id", ""))),
        ),
    )


def _select_balanced_profiles(profiles: list[dict[str, Any]], target_per_type: int) -> list[dict[str, Any]]:
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for profile in profiles:
        by_type[str(profile["diagram_type"])].append(profile)

    selected: list[dict[str, Any]] = []
    for diagram_type in sorted(by_type):
        type_rows = by_type[diagram_type]
        bucket_rows: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in type_rows:
            bucket_rows[int(row.get("complexity_bucket", 1))].append(row)
        bucket_quota = _allocate_evenly(
            {str(bucket): len(rows) for bucket, rows in bucket_rows.items()},
            target_per_type,
        )
        chosen_for_type: list[dict[str, Any]] = []
        for bucket in sorted(bucket_rows):
            rows = _sort_candidates(bucket_rows[bucket])
            take = bucket_quota.get(str(bucket), 0)
            chosen_for_type.extend(rows[:take])
        if len(chosen_for_type) < target_per_type:
            chosen_ids = {row["sample_id"] for row in chosen_for_type}
            leftovers = [row for row in _sort_candidates(type_rows) if row["sample_id"] not in chosen_ids]
            chosen_for_type.extend(leftovers[: target_per_type - len(chosen_for_type)])
        selected.extend(chosen_for_type[:target_per_type])

    assign_splits(selected)
    return selected


def _write_source_bundle(output_source_dir: Path, selected_profiles: list[dict[str, Any]]) -> None:
    if output_source_dir.exists():
        for child in output_source_dir.iterdir():
            if child.is_file():
                child.unlink()
            else:
                import shutil

                shutil.rmtree(child)
    output_source_dir.mkdir(parents=True, exist_ok=True)
    split_dir = output_source_dir / "splits"
    split_dir.mkdir(parents=True, exist_ok=True)

    split_ids: dict[str, list[str]] = {"train": [], "validation": [], "test": []}
    for row in selected_profiles:
        sample_id = str(row["sample_id"])
        payload = dict(row["sample_payload"])
        payload["id"] = sample_id
        payload["release_version"] = "open_balanced_v1_3600_source_bundle"
        payload["release_built_at"] = utc_iso()
        write_json(output_source_dir / f"{sample_id}.json", payload)
        split_ids[str(row["incremental_split"])].append(sample_id)

    for split_name, ids in split_ids.items():
        write_json(split_dir / f"{split_name}_ids.json", {"ids": ids})


def main() -> None:
    args = parse_args()
    output_source_dir = resolve_path(args.output_source_dir)
    output_report_dir = resolve_path(args.output_report_dir)

    local_profiles = _load_local_candidates(args.local_source_dir, args.local_split_dir)
    hf_profiles = _load_hf_candidates(args.hf_repo, args.hf_jsonl)

    combined_by_hash: dict[str, dict[str, Any]] = {}
    duplicates_removed = 0
    for row in [*local_profiles, *hf_profiles]:
        code_hash = sha256_text(normalize_mermaid(str(row["sample_payload"]["code"])))
        existing = combined_by_hash.get(code_hash)
        if existing is None:
            combined_by_hash[code_hash] = row
            continue
        keep_existing = existing.get("origin") == "local_release_v7"
        if keep_existing:
            duplicates_removed += 1
            continue
        combined_by_hash[code_hash] = row
        duplicates_removed += 1

    combined_profiles = list(combined_by_hash.values())
    assign_complexity_buckets(combined_profiles)
    selected_profiles = _select_balanced_profiles(combined_profiles, target_per_type=int(args.target_per_type))
    _write_source_bundle(output_source_dir, selected_profiles)

    selected_by_type = Counter(str(row["diagram_type"]) for row in selected_profiles)
    selected_by_origin = Counter(str(row["origin"]) for row in selected_profiles)
    selected_by_type_origin = Counter((str(row["diagram_type"]), str(row["origin"])) for row in selected_profiles)
    selected_by_license = Counter(str(row["license"]).lower() for row in selected_profiles)

    manifest = {
        "generated_at_utc": utc_iso(),
        "output_source_dir": str(output_source_dir),
        "target_per_type": int(args.target_per_type),
        "total_selected": len(selected_profiles),
        "local_candidate_count": len(local_profiles),
        "hf_candidate_count": len(hf_profiles),
        "combined_candidate_count": len(combined_profiles),
        "duplicates_removed": duplicates_removed,
        "selected_by_type": {key: int(value) for key, value in sorted(selected_by_type.items())},
        "selected_by_origin": {key: int(value) for key, value in sorted(selected_by_origin.items())},
        "selected_by_license": {key: int(value) for key, value in sorted(selected_by_license.items())},
        "selected_by_type_origin": {
            f"{diagram_type}::{origin}": int(value)
            for (diagram_type, origin), value in sorted(selected_by_type_origin.items())
        },
        "sources": [
            {
                "name": "release_v7_kimi_k25_fullregen_strict_20260313",
                "kind": "local_release_subset",
                "url": str(resolve_path(args.local_source_dir)),
                "license_policy": "keep only explicit open-source licenses",
            },
            {
                "name": args.hf_repo,
                "kind": "huggingface_dataset",
                "url": f"https://huggingface.co/datasets/{args.hf_repo}",
                "license": "mit",
            },
        ],
        "split_counts": {
            split_name: len(json.loads((output_source_dir / "splits" / f"{split_name}_ids.json").read_text(encoding="utf-8"))["ids"])
            for split_name in ("train", "validation", "test")
        },
        "example_selected_samples": [
            {
                "sample_id": row["sample_id"],
                "diagram_type": row["diagram_type"],
                "origin": row["origin"],
                "license": row["license"],
                "split": row["incremental_split"],
                "complexity_bucket": row.get("complexity_bucket"),
            }
            for row in selected_profiles[:30]
        ],
    }
    write_json(output_source_dir / "source_bundle_manifest.json", manifest)
    write_json(output_report_dir / "open_balanced_source_build.summary.json", manifest)
    (output_report_dir / "open_balanced_source_build.summary.md").write_text(
        "\n".join(
            [
                "# Open Balanced Source Bundle",
                "",
                f"- Generated at (UTC): {manifest['generated_at_utc']}",
                f"- Output source dir: `{output_source_dir}`",
                f"- Total selected: {manifest['total_selected']}",
                f"- Local candidates: {manifest['local_candidate_count']}",
                f"- HF candidates: {manifest['hf_candidate_count']}",
                f"- Combined candidates: {manifest['combined_candidate_count']}",
                f"- Duplicates removed: {manifest['duplicates_removed']}",
                "",
                "## Selected By Type",
                "",
                *[f"- `{key}`: {value}" for key, value in manifest["selected_by_type"].items()],
                "",
                "## Selected By Origin",
                "",
                *[f"- `{key}`: {value}" for key, value in manifest["selected_by_origin"].items()],
                "",
                "## Selected By License",
                "",
                *[f"- `{key}`: {value}" for key, value in manifest["selected_by_license"].items()],
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
