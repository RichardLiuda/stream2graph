#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compile Mermaid code through a renderer endpoint.")
    parser.add_argument("--input", required=True, help="Input Mermaid file path.")
    parser.add_argument("--output", required=True, help="Output artifact path.")
    parser.add_argument(
        "--endpoint",
        default="https://kroki.io/mermaid/svg",
        help="Renderer endpoint. Defaults to Kroki Mermaid SVG.",
    )
    parser.add_argument("--timeout-sec", type=int, default=30, help="Per-request timeout in seconds.")
    parser.add_argument("--max-retries", type=int, default=2, help="Retry count for transient failures.")
    parser.add_argument("--retry-backoff-sec", type=float, default=0.5, help="Backoff multiplier in seconds.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    payload = input_path.read_text(encoding="utf-8").encode("utf-8")

    last_error = "unknown compile error"
    for attempt in range(args.max_retries + 1):
        request = urllib.request.Request(
            args.endpoint,
            data=payload,
            headers={"Content-Type": "text/plain; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=args.timeout_sec) as response:
                body = response.read()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(body)
            return 0
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp is not None else ""
            last_error = f"HTTP {exc.code}: {body[-500:]}"
        except urllib.error.URLError as exc:
            last_error = f"URL error: {exc.reason}"
        except Exception as exc:  # pragma: no cover - defensive wrapper
            last_error = f"{type(exc).__name__}: {exc}"

        if attempt < args.max_retries:
            time.sleep(args.retry_backoff_sec * (attempt + 1))

    print(last_error, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
