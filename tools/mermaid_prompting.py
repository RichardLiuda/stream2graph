from __future__ import annotations

import re
from typing import Optional


MERMAID_RUNTIME_VERSION = "11.13.0"
MERMAID_SYNTAX_PROFILE = f"mermaid@{MERMAID_RUNTIME_VERSION}/strict-subset-v1"

_DIAGRAM_HEADER_HINTS = {
    "flowchart": "flowchart TD",
    "graph": "flowchart TD",
    "sequence": "sequenceDiagram",
    "sequencediagram": "sequenceDiagram",
    "statediagram": "stateDiagram-v2",
    "statediagram-v2": "stateDiagram-v2",
    "class": "classDiagram",
    "classdiagram": "classDiagram",
    "er": "erDiagram",
    "erdiagram": "erDiagram",
    "requirementdiagram": "requirementDiagram",
}

_CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_LATIN_PATTERN = re.compile(r"[A-Za-z]")
_SPEAKER_PREFIX_PATTERN = re.compile(r"^[A-Za-z0-9_ ./-]{1,32}:\s+")


def canonical_diagram_hint(diagram_type: str | None) -> str:
    value = (diagram_type or "").strip().lower()
    return _DIAGRAM_HEADER_HINTS.get(value, "flowchart TD")


def detect_dominant_dialogue_language(text: str) -> str:
    content = str(text or "")
    normalized_lines: list[str] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line = _SPEAKER_PREFIX_PATTERN.sub("", line)
        normalized_lines.append(line)
    content = "\n".join(normalized_lines) or content
    cjk_count = len(_CJK_PATTERN.findall(content))
    latin_count = len(_LATIN_PATTERN.findall(content))
    if cjk_count == 0 and latin_count == 0:
        return "Unknown"
    if cjk_count and not latin_count:
        return "Chinese"
    if latin_count and not cjk_count:
        return "English"
    if cjk_count >= 2 and (cjk_count * 2) >= latin_count:
        return "Chinese"
    if latin_count >= max(6, cjk_count * 3):
        return "English"
    return "Mixed Chinese-English"


def build_output_language_requirement(text: str) -> str:
    language = detect_dominant_dialogue_language(text)
    if language == "Chinese":
        return (
            "Detected dominant dialogue language: Chinese. Output every human-readable diagram "
            "label in Chinese. Do not translate Chinese source content into English. "
            "Preserve proper nouns, acronyms, API names, and official product names in their "
            "original form when appropriate."
        )
    if language == "English":
        return (
            "Detected dominant dialogue language: English. Output every human-readable diagram "
            "label in English. Do not translate English source content into another language "
            "unless the user explicitly asks for translation."
        )
    if language == "Mixed Chinese-English":
        return (
            "Detected dominant dialogue language: Mixed Chinese-English. Keep each label in the "
            "language used by the source content, and do not normalize everything into a "
            "different single language. Preserve proper nouns and API names as written."
        )
    return (
        "Keep all human-readable diagram labels in the same language as the source dialogue. "
        "Do not translate unless the user explicitly asks for translation."
    )


MERMAID_GENERATION_SYSTEM_PROMPT = "\n".join(
    [
        "You convert collaborative diagram-building dialogue into exactly one Mermaid diagram.",
        f"The runtime renderer is mermaid@{MERMAID_RUNTIME_VERSION}. Follow that syntax exactly.",
        f"Use the syntax profile {MERMAID_SYNTAX_PROFILE}.",
        "Return Mermaid code only. Do not add explanations, markdown fences, JSON, or think traces.",
        "Output contract:",
        "1. The first non-comment line must be a valid Mermaid diagram header.",
        "2. Output exactly one diagram and one statement per line.",
        "3. Never chain multiple edges or declarations on one line.",
        "4. Never use ';' to separate Mermaid statements.",
        "5. Use simple ASCII identifiers like Gateway, AuthService, UserDB.",
        "6. Put human-readable text in labels, not in the identifier token.",
        "7. For flowcharts, use only valid explicit connectors such as -->, -.->, or ==>.",
        "8. Do not use bare '--' as a connector in flowcharts.",
        "9. If a specific diagram type is requested, use that exact Mermaid family header.",
        "10. If the diagram type is unclear, default to flowchart TD.",
        "11. Every node identifier must be unique across the entire diagram. Never reuse an identifier.",
        "12. Never create a subgraph and then place a node with the same identifier as the subgraph inside it.",
        "13. Never set a node or subgraph as its own parent — this creates a cycle and breaks rendering.",
        "14. All edges must connect two different existing nodes. Never create self-referencing edges (A --> A).",
        "15. Use the same dominant language as the source dialogue for every human-readable label.",
        "16. Do not translate Chinese source text into English or English source text into Chinese unless explicitly asked.",
        "17. ASCII identifiers are internal only; labels must still follow the source language.",
        "Plan the overall structure internally first, then emit only the final Mermaid code.",
    ]
)


def build_final_diagram_user_prompt(
    dialogue_text: str,
    *,
    sample_id: str | None = None,
    session_title: str | None = None,
    diagram_type: str | None = None,
    current_best: bool = False,
) -> str:
    header_hint = canonical_diagram_hint(diagram_type)
    lines = [
        "Generate the Mermaid diagram code from the collaborative dialogue below.",
        "Use the repaired final state implied by the conversation." if not current_best else "Generate the current best complete diagram state implied by the conversation so far.",
        f"Mermaid runtime version: {MERMAID_RUNTIME_VERSION}",
        f"Syntax profile: {MERMAID_SYNTAX_PROFILE}",
        "Structure requirements:",
        f"- Use this header unless the dialogue makes a different valid family unavoidable: {header_hint}",
        "- Keep one node declaration or edge statement per line.",
        "- Prefer a stable top-level structure with a small number of core nodes first, then add branches.",
        "- Do not emit markdown fences or any prose.",
        "Language requirement:",
        f"- {build_output_language_requirement(dialogue_text)}",
    ]
    if sample_id:
        lines.append(f"Sample ID: {sample_id}")
    if session_title:
        lines.append(f"Session title: {session_title}")
    if diagram_type:
        lines.append(f"Requested diagram type: {diagram_type}")
    lines.extend(["", "Dialogue:", dialogue_text.strip()])
    return "\n".join(lines).strip()


def build_repair_diagram_user_prompt(
    dialogue_text: str,
    failed_code: str,
    compile_error: str,
    *,
    session_title: str | None = None,
    diagram_type: str | None = None,
) -> str:
    header_hint = canonical_diagram_hint(diagram_type)
    lines = [
        "Repair the Mermaid diagram below so it compiles under the required Mermaid runtime.",
        f"Mermaid runtime version: {MERMAID_RUNTIME_VERSION}",
        f"Syntax profile: {MERMAID_SYNTAX_PROFILE}",
        f"Target header family: {header_hint}",
        "Repair rules:",
        "- Preserve the intended semantics and overall structure.",
        "- Output exactly one Mermaid diagram and nothing else.",
        "- Keep one statement per line.",
        "- Remove invalid chained statements, invalid separators, and invalid connectors.",
        "- For flowcharts, replace invalid bare '--' edges with a valid explicit connector if needed.",
        "Language requirement:",
        f"- {build_output_language_requirement(dialogue_text)}",
    ]
    if session_title:
        lines.append(f"Session title: {session_title}")
    if diagram_type:
        lines.append(f"Requested diagram type: {diagram_type}")
    lines.extend(
        [
            "",
            "Compiler feedback:",
            compile_error.strip() or "(no compiler feedback provided)",
            "",
            "Original dialogue context:",
            dialogue_text.strip(),
            "",
            "Broken Mermaid candidate:",
            failed_code.strip(),
        ]
    )
    return "\n".join(lines).strip()
