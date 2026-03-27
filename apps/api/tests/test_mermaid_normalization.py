from tools.eval.metrics import normalize_mermaid


def test_normalize_mermaid_splits_concatenated_flowchart_edges() -> None:
    candidate = """flowchart TD
Client[Client] --> APIGateway[API Gateway] APIGateway -- Auth[Auth] APIGateway --> Backend[Backend]
"""

    assert normalize_mermaid(candidate) == "\n".join(
        [
            "flowchart TD",
            "Client[Client] --> APIGateway[API Gateway]",
            "APIGateway --> Auth[Auth]",
            "APIGateway --> Backend[Backend]",
        ]
    )


def test_normalize_mermaid_converts_graph_header_and_semicolon_statements() -> None:
    candidate = "graph LR; A[One] --> B[Two]; B -- C[Three]"

    assert normalize_mermaid(candidate) == "\n".join(
        [
            "flowchart LR",
            "A[One] --> B[Two]",
            "B --> C[Three]",
        ]
    )
