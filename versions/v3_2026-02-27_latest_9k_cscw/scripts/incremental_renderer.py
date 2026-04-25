#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Incremental graph renderer with anti-flicker metrics.

Design goals:
- Keep existing node positions stable (mental map preservation).
- Place new nodes near anchors and only locally relax them.
- Emit per-frame flicker statistics and global stability summary.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from statistics import mean, median
from typing import Dict, List, Optional, Set, Tuple


@dataclass
class NodeState:
    id: str
    label: str
    x: float
    y: float
    created_frame: int


@dataclass
class RenderFrame:
    frame_id: int
    update_id: int
    node_count: int
    edge_count: int
    touched_nodes: List[str]
    added_nodes: List[str]
    added_edges: int
    flicker_index: float
    mean_displacement: float
    p95_displacement: float
    unchanged_max_drift: float
    mental_map_score: float


def _pctl(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    arr = sorted(values)
    if p <= 0:
        return float(arr[0])
    if p >= 100:
        return float(arr[-1])
    idx = int(round((len(arr) - 1) * p / 100.0))
    return float(arr[idx])


class IncrementalGraphRenderer:
    def __init__(
        self,
        min_distance: float = 80.0,
        local_relax_iters: int = 6,
        mental_map_scale: float = 32.0,
    ) -> None:
        self.min_distance = min_distance
        self.local_relax_iters = local_relax_iters
        self.mental_map_scale = max(mental_map_scale, 1.0)

        self.nodes: Dict[str, NodeState] = {}
        self.edges: Set[Tuple[str, str]] = set()
        self.edge_frames: Dict[Tuple[str, str], int] = {}
        self.frame_id = 0
        self.frames: List[RenderFrame] = []

    def apply_update(
        self,
        update_id: int,
        operations: List[Dict],
        intent_type: str = "generic",
    ) -> RenderFrame:
        self.frame_id += 1
        prev_pos = {nid: (n.x, n.y) for nid, n in self.nodes.items()}
        touched_nodes: Set[str] = set()
        added_nodes: List[str] = []
        added_edges = 0
        anchor_for_new: Dict[str, str] = {}

        for op in operations:
            if op.get("op") != "add_edge":
                continue
            src = str(op.get("from", "")).strip()
            dst = str(op.get("to", "")).strip()
            if src and dst:
                anchor_for_new.setdefault(dst, src)

        for op in operations:
            kind = op.get("op")
            if kind == "add_node":
                nid = str(op.get("id", "")).strip()
                if not nid:
                    continue
                label = str(op.get("label", nid))
                if nid in self.nodes:
                    touched_nodes.add(nid)
                    self.nodes[nid].label = label
                    continue
                anchor_id = anchor_for_new.get(nid)
                x, y = self._initial_position(nid, anchor_id, intent_type)
                self.nodes[nid] = NodeState(
                    id=nid,
                    label=label,
                    x=x,
                    y=y,
                    created_frame=self.frame_id,
                )
                touched_nodes.add(nid)
                added_nodes.append(nid)

            elif kind == "add_edge":
                src = str(op.get("from", "")).strip()
                dst = str(op.get("to", "")).strip()
                if not src or not dst:
                    continue
                if src not in self.nodes:
                    x, y = self._initial_position(src, None, intent_type)
                    self.nodes[src] = NodeState(src, src, x, y, self.frame_id)
                    touched_nodes.add(src)
                    added_nodes.append(src)
                if dst not in self.nodes:
                    x, y = self._initial_position(dst, src, intent_type)
                    self.nodes[dst] = NodeState(dst, dst, x, y, self.frame_id)
                    touched_nodes.add(dst)
                    added_nodes.append(dst)
                edge = (src, dst)
                if edge not in self.edges:
                    self.edges.add(edge)
                    self.edge_frames[edge] = self.frame_id
                    added_edges += 1

        self._local_relax_new_nodes(added_nodes)
        frame = self._build_frame_metrics(
            update_id=update_id,
            prev_pos=prev_pos,
            touched_nodes=touched_nodes,
            added_nodes=added_nodes,
            added_edges=added_edges,
        )
        self.frames.append(frame)
        return frame

    def export_state(self) -> Dict:
        return {
            "nodes": [asdict(n) for n in self.nodes.values()],
            "edges": [
                {"from": s, "to": t, "created_frame": self.edge_frames.get((s, t), 0)}
                for s, t in sorted(self.edges)
            ],
            "frame_count": self.frame_id,
        }

    def summary(self) -> Dict:
        flickers = [f.flicker_index for f in self.frames]
        mental = [f.mental_map_score for f in self.frames]
        unchanged = [f.unchanged_max_drift for f in self.frames]
        return {
            "frame_count": len(self.frames),
            "node_count": len(self.nodes),
            "edge_count": len(self.edges),
            "flicker_index": self._stats(flickers),
            "mental_map_score": self._stats(mental),
            "unchanged_max_drift": self._stats(unchanged),
        }

    def _initial_position(
        self,
        node_id: str,
        anchor_id: Optional[str],
        intent_type: str,
    ) -> Tuple[float, float]:
        if anchor_id and anchor_id in self.nodes:
            anchor = self.nodes[anchor_id]
            deg = (len(self.nodes) * 47) % 360
            radius = 90.0 + 10.0 * (len(self.nodes) % 3)
            x = anchor.x + radius * math.cos(math.radians(deg))
            y = anchor.y + radius * math.sin(math.radians(deg))
            return x, y

        idx = len(self.nodes)
        if intent_type in {"sequential", "contrastive"}:
            return float(idx * 160), float((idx % 3) * 80)
        if intent_type in {"structural", "relational"}:
            angle = math.radians((idx * 37) % 360)
            radius = 120.0 + 16.0 * (idx // 8)
            return radius * math.cos(angle), radius * math.sin(angle)
        return float((idx % 8) * 140), float((idx // 8) * 90)

    def _local_relax_new_nodes(self, new_ids: List[str]) -> None:
        if not new_ids:
            return

        for _ in range(self.local_relax_iters):
            for nid in new_ids:
                n = self.nodes.get(nid)
                if not n:
                    continue

                fx = 0.0
                fy = 0.0
                for oid, o in self.nodes.items():
                    if oid == nid:
                        continue
                    dx = n.x - o.x
                    dy = n.y - o.y
                    dist = math.hypot(dx, dy) + 1e-6
                    if dist < self.min_distance:
                        push = (self.min_distance - dist) / self.min_distance
                        fx += (dx / dist) * push
                        fy += (dy / dist) * push

                # Clamp movement to keep visual continuity.
                n.x += max(-24.0, min(24.0, fx * 18.0))
                n.y += max(-24.0, min(24.0, fy * 18.0))

    def _build_frame_metrics(
        self,
        update_id: int,
        prev_pos: Dict[str, Tuple[float, float]],
        touched_nodes: Set[str],
        added_nodes: List[str],
        added_edges: int,
    ) -> RenderFrame:
        common = set(prev_pos.keys()) & set(self.nodes.keys())
        disps = []
        unchanged_disps = []
        for nid in common:
            old_x, old_y = prev_pos[nid]
            node = self.nodes[nid]
            d = math.hypot(node.x - old_x, node.y - old_y)
            disps.append(d)
            if nid not in touched_nodes:
                unchanged_disps.append(d)

        mean_disp = float(mean(disps)) if disps else 0.0
        p95_disp = _pctl(disps, 95.0)
        unchanged_max = max(unchanged_disps) if unchanged_disps else 0.0
        flicker_index = sum(disps) / max(len(common), 1)
        mental_map = max(0.0, 1.0 - (mean_disp / self.mental_map_scale))

        return RenderFrame(
            frame_id=self.frame_id,
            update_id=update_id,
            node_count=len(self.nodes),
            edge_count=len(self.edges),
            touched_nodes=sorted(touched_nodes),
            added_nodes=added_nodes,
            added_edges=added_edges,
            flicker_index=round(flicker_index, 4),
            mean_displacement=round(mean_disp, 4),
            p95_displacement=round(p95_disp, 4),
            unchanged_max_drift=round(unchanged_max, 4),
            mental_map_score=round(mental_map, 4),
        )

    def _stats(self, values: List[float]) -> Dict:
        if not values:
            return {"count": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0}
        return {
            "count": float(len(values)),
            "mean": round(float(mean(values)), 4),
            "p50": round(float(median(values)), 4),
            "p95": round(float(_pctl(values, 95.0)), 4),
            "max": round(float(max(values)), 4),
        }
