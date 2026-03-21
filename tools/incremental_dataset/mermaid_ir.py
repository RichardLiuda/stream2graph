from __future__ import annotations

import re

from tools.eval.common import normalize_whitespace
from tools.eval.metrics import canonical_diagram_type, normalize_mermaid
from tools.incremental_dataset.schema import GraphEdge, GraphGroup, GraphIR, GraphNode, SourceSample


NODE_DECL_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*"
    r"(\[\[[^\]]+\]\]|\[[^\]]+\]|\(\([^)]*\)\)|\([^)]*\)|\{[^}]*\}|>[^]\n]*\])"
)
SIMPLE_NODE_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*$")
SEQUENCE_ACTOR_RE = re.compile(
    r"^\s*(participant|actor|database|entity|queue|boundary|control|collections?)\s+([A-Za-z][A-Za-z0-9_]{0,63})"
    r"(?:\s+as\s+(.*))?$",
    flags=re.IGNORECASE,
)
EDGE_LINE_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9_]{0,63})(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|>[^]\n]*\])?\s*"
    r"(<<?[-.=ox]+>?|-->|==>|-.->|->>|-->>|<<--|<--|<->)\s*"
    r"(?:\|([^|]+)\|\s*)?"
    r"([A-Za-z][A-Za-z0-9_]{0,63})"
    r"(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|>[^]\n]*\])?"
    r"(?:\s*:\s*(.*))?$"
)
SUBGRAPH_RE = re.compile(r'^\s*subgraph\s+(.+?)\s*$', flags=re.IGNORECASE)
STYLE_RE = re.compile(r"^\s*(classDef|class|style|linkStyle)\b", flags=re.IGNORECASE)
STATE_TOKEN_RE = r'(?:\[\*\]|"[^"]+"|[A-Za-z][A-Za-z0-9_]{0,63})'
STATE_EDGE_RE = re.compile(
    rf"^\s*({STATE_TOKEN_RE})\s*"
    r"(<<?[-.=ox]+>?|-->|==>|-.->|->>|-->>|<<--|<--|<->|--)\s*"
    rf"(?:\|([^|]+)\|\s*)?({STATE_TOKEN_RE})"
    r"(?:\s*:\s*(.*))?$"
)
STATE_BLOCK_RE = re.compile(
    r'^\s*state\s+(".*?"|[A-Za-z][A-Za-z0-9_]{0,63})'
    r'(?:\s+as\s+([A-Za-z][A-Za-z0-9_]{0,63}))?'
    r'(?:\s+<<[^>]+>>)?\s*\{\s*$',
    flags=re.IGNORECASE,
)
STATE_DECL_RE = re.compile(
    r'^\s*state\s+(".*?"|[A-Za-z][A-Za-z0-9_]{0,63})'
    r'(?:\s+as\s+([A-Za-z][A-Za-z0-9_]{0,63}))?'
    r'(?:\s+<<[^>]+>>)?\s*$',
    flags=re.IGNORECASE,
)
ER_EDGE_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*([|}{o.\-]+)\s*([A-Za-z][A-Za-z0-9_]*)\s*(?::\s*(.*))?$"
)
ER_ENTITY_BLOCK_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*\{\s*$")


def _strip_node_shape(raw: str) -> str:
    value = (raw or "").strip()
    wrappers = ("[[", "]]"), ("[", "]"), ("((", "))"), ("(", ")"), ("{", "}"), (">", "]")
    for lhs, rhs in wrappers:
        if value.startswith(lhs) and value.endswith(rhs):
            value = value[len(lhs) : len(value) - len(rhs)]
            break
    value = value.replace("<br>", " ").replace("<br/>", " ").replace("<br />", " ")
    value = re.sub(r"<[^>]+>", "", value)
    value = value.strip("\"' ")
    return normalize_whitespace(value)


def _clean_group_label(raw: str, fallback: str) -> tuple[str, str]:
    value = (raw or "").strip()
    explicit_id = ""
    explicit_label = value
    id_match = re.match(r'^([A-Za-z][A-Za-z0-9_]{0,63})\s*(.*)$', value)
    if id_match and id_match.group(2).strip():
        explicit_id = id_match.group(1)
        explicit_label = id_match.group(2).strip()
    explicit_label = explicit_label.strip("\"' ")
    explicit_label = _strip_node_shape(explicit_label) or explicit_label
    explicit_label = normalize_whitespace(explicit_label) or fallback
    return explicit_id or fallback, explicit_label


def _safe_identifier(raw: str, fallback: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_]+", "_", (raw or "").strip())
    value = re.sub(r"_+", "_", value).strip("_")
    if not value:
        return fallback
    if not re.match(r"^[A-Za-z]", value):
        value = f"{fallback}_{value}"
    return value[:64]


def _resolve_state_symbol(raw: str, fallback: str) -> tuple[str, str, str]:
    token = (raw or "").strip()
    if token == "[*]":
        return "state_start", "[*]", "pseudo_state"
    if token.startswith('"') and token.endswith('"') and len(token) >= 2:
        label = normalize_whitespace(token[1:-1]) or fallback
        return _safe_identifier(label, fallback), label, "state"
    label = normalize_whitespace(token) or fallback
    return token, label, "state"


def _resolve_declared_state(name_token: str, alias_token: str | None, fallback: str) -> tuple[str, str]:
    if alias_token:
        label = normalize_whitespace((name_token or "").strip().strip('"')) or alias_token
        return alias_token, label
    state_id, state_label, _ = _resolve_state_symbol(name_token, fallback)
    return state_id, state_label


def parse_mermaid_to_graph_ir(sample: SourceSample) -> GraphIR:
    normalized = normalize_mermaid(sample.code)
    diagram_type = canonical_diagram_type(sample.diagram_type)
    nodes_by_id: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    groups_by_id: dict[str, GraphGroup] = {}
    group_stack: list[str] = []

    def ensure_node(node_id: str, label: str | None, kind: str, source_index: int) -> GraphNode:
        existing = nodes_by_id.get(node_id)
        parent = group_stack[-1] if group_stack else None
        if existing is None:
            node = GraphNode(
                id=node_id,
                label=normalize_whitespace(label or node_id) or node_id,
                kind=kind,
                parent=parent,
                source_index=source_index,
                metadata={"diagram_type": diagram_type},
            )
            nodes_by_id[node_id] = node
            if parent and parent in groups_by_id and node_id not in groups_by_id[parent].member_ids:
                groups_by_id[parent].member_ids.append(node_id)
            return node
        if label and not existing.label:
            existing.label = normalize_whitespace(label)
        if parent and existing.parent is None:
            existing.parent = parent
            if parent in groups_by_id and node_id not in groups_by_id[parent].member_ids:
                groups_by_id[parent].member_ids.append(node_id)
        return existing

    for line_index, line in enumerate(normalized.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("%%") or stripped == "---":
            continue
        if stripped.lower().startswith(("graph ", "flowchart ", "sequencediagram", "statediagram", "erdiagram", "mindmap")):
            continue
        if diagram_type == "statediagram" and stripped == "}":
            if group_stack:
                group_stack.pop()
            continue
        if diagram_type == "er" and stripped in {"{", "}"}:
            continue
        if stripped.lower() == "end":
            if group_stack:
                group_stack.pop()
            continue
        if STYLE_RE.match(stripped):
            continue

        if diagram_type == "statediagram":
            state_block_match = STATE_BLOCK_RE.match(stripped)
            if state_block_match:
                fallback_id = f"state_group_{len(groups_by_id) + 1}"
                state_id, state_label = _resolve_declared_state(
                    state_block_match.group(1),
                    state_block_match.group(2),
                    fallback_id,
                )
                parent = group_stack[-1] if group_stack else None
                groups_by_id[state_id] = GraphGroup(
                    id=state_id,
                    label=state_label,
                    parent=parent,
                    source_index=line_index,
                    metadata={"kind": "state_group"},
                )
                group_stack.append(state_id)
                continue

            state_edge_match = STATE_EDGE_RE.match(stripped)
            if state_edge_match:
                source_id, source_label, source_kind = _resolve_state_symbol(
                    state_edge_match.group(1),
                    f"state_src_{line_index}",
                )
                target_id, target_label, target_kind = _resolve_state_symbol(
                    state_edge_match.group(4),
                    f"state_dst_{line_index}",
                )
                edge_label = normalize_whitespace(state_edge_match.group(3) or state_edge_match.group(5) or "")
                ensure_node(source_id, source_label, source_kind, line_index)
                ensure_node(target_id, target_label, target_kind, line_index)
                edges.append(
                    GraphEdge(
                        id=f"e{len(edges) + 1}",
                        source=source_id,
                        target=target_id,
                        label=edge_label,
                        source_index=line_index,
                        metadata={"connector": state_edge_match.group(2), "diagram_type": diagram_type},
                    )
                )
                continue

            state_decl_match = STATE_DECL_RE.match(stripped)
            if state_decl_match:
                state_id, state_label = _resolve_declared_state(
                    state_decl_match.group(1),
                    state_decl_match.group(2),
                    f"state_{line_index}",
                )
                ensure_node(state_id, state_label, "state", line_index)
                continue

        if diagram_type == "er":
            if stripped.lower().startswith("direction "):
                continue
            entity_block_match = ER_ENTITY_BLOCK_RE.match(stripped)
            if entity_block_match:
                entity_id = entity_block_match.group(1)
                ensure_node(entity_id, entity_id, "entity", line_index)
                continue

            er_edge_match = ER_EDGE_RE.match(stripped)
            if er_edge_match:
                source_id = er_edge_match.group(1)
                target_id = er_edge_match.group(3)
                edge_label = normalize_whitespace(er_edge_match.group(4) or "")
                ensure_node(source_id, source_id, "entity", line_index)
                ensure_node(target_id, target_id, "entity", line_index)
                edges.append(
                    GraphEdge(
                        id=f"e{len(edges) + 1}",
                        source=source_id,
                        target=target_id,
                        label=edge_label,
                        source_index=line_index,
                        metadata={"connector": er_edge_match.group(2), "diagram_type": diagram_type},
                    )
                )
                continue

        subgraph_match = SUBGRAPH_RE.match(stripped)
        if subgraph_match:
            fallback_id = f"group_{len(groups_by_id) + 1}"
            group_id, group_label = _clean_group_label(subgraph_match.group(1), fallback_id)
            parent = group_stack[-1] if group_stack else None
            groups_by_id[group_id] = GraphGroup(
                id=group_id,
                label=group_label,
                parent=parent,
                source_index=line_index,
            )
            group_stack.append(group_id)
            continue

        sequence_match = SEQUENCE_ACTOR_RE.match(stripped)
        if sequence_match:
            actor_kind = sequence_match.group(1).lower()
            actor_id = sequence_match.group(2)
            actor_label = normalize_whitespace(sequence_match.group(3) or actor_id)
            ensure_node(actor_id, actor_label, actor_kind, line_index)
            continue

        edge_match = EDGE_LINE_RE.match(stripped)
        if edge_match:
            source_id = edge_match.group(1)
            label_from_pipe = normalize_whitespace(edge_match.group(3) or "")
            target_id = edge_match.group(4)
            label_from_suffix = normalize_whitespace(edge_match.group(5) or "")
            edge_label = label_from_pipe or label_from_suffix
            ensure_node(source_id, source_id, "node", line_index)
            ensure_node(target_id, target_id, "node", line_index)
            edges.append(
                GraphEdge(
                    id=f"e{len(edges) + 1}",
                    source=source_id,
                    target=target_id,
                    label=edge_label,
                    source_index=line_index,
                    metadata={"connector": edge_match.group(2)},
                )
            )
            continue

        node_match = NODE_DECL_RE.match(stripped)
        if node_match:
            node_id = node_match.group(1)
            node_label = _strip_node_shape(node_match.group(2)) or node_id
            ensure_node(node_id, node_label, "node", line_index)
            continue

        simple_node_match = SIMPLE_NODE_RE.match(stripped)
        if simple_node_match:
            node_id = simple_node_match.group(1)
            ensure_node(node_id, node_id, "node", line_index)

    return GraphIR(
        graph_id=sample.sample_id,
        diagram_type=diagram_type,
        nodes=sorted(nodes_by_id.values(), key=lambda item: (item.source_index, item.id)),
        edges=sorted(edges, key=lambda item: (item.source_index, item.id)),
        groups=sorted(groups_by_id.values(), key=lambda item: (item.source_index, item.id)),
        metadata={
            "source_path": sample.source_path,
            "compilation_status": sample.compilation_status,
            "content_size": sample.content_size,
            "normalized_code": normalized,
        },
    )
