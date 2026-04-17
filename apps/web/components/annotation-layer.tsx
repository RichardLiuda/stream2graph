"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };

// NOTE: keep legacy "erase" to survive Fast Refresh state carry-over.
export type AnnotationTool = "none" | "pen" | "rect" | "text" | "erase" | "erase_object" | "erase_precise";

export type AnnotationPen = {
  kind: "pen";
  id: string;
  points: Point[];
  color: string;
  width: number;
  opacity: number;
};

export type AnnotationRect = {
  kind: "rect";
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: "highlight" | "outline";
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  radius: number;
};

export type AnnotationText = {
  kind: "text";
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
};

export type AnnotationItem = AnnotationPen | AnnotationRect | AnnotationText;

export type AnnotationPayload = { items: AnnotationItem[] };

export type AnnotationDoc = {
  version: number;
  payload: AnnotationPayload;
};

function id32() {
  // not crypto; stable enough for client-side ids
  return Math.random().toString(16).slice(2).padEnd(8, "0") + Date.now().toString(16).slice(-8);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function svgPointFromClient(svg: SVGSVGElement, client: Point): Point {
  const pt = svg.createSVGPoint();
  pt.x = client.x;
  pt.y = client.y;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: client.x, y: client.y };
  const inv = ctm.inverse();
  const res = pt.matrixTransform(inv);
  return { x: res.x, y: res.y };
}

function normalizeRect(a: Point, b: Point) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}

export function AnnotationLayer({
  enabled,
  tool,
  doc,
  onChange,
  penColor = "rgba(229,231,235,0.92)",
  penWidth = 2,
  eraserWidth = 12,
  rectMode = "outline",
  rectColor = "rgba(229,231,235,0.92)",
  textColor = "rgba(229,231,235,0.92)",
  textSize = 14,
}: {
  enabled: boolean;
  tool: AnnotationTool;
  doc: AnnotationDoc;
  onChange: (next: AnnotationDoc) => void;
  penColor?: string;
  penWidth?: number;
  /** @description 橡皮擦粗细（屏幕像素）。只作用于 `erase_precise` / `erase_object`。 */
  eraserWidth?: number;
  rectMode?: "highlight" | "outline";
  rectColor?: string;
  textColor?: string;
  textSize?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draftingRef = useRef<{ pointerId: number; start: Point; kind: AnnotationTool } | null>(null);
  const draftPenPointsRef = useRef<Point[] | null>(null);
  const draftRectRef = useRef<{ start: Point; end: Point } | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const erasePointerIdRef = useRef<number | null>(null);
  const lastEraseCommitAtRef = useRef<number>(0);
  const lastEraserPointRef = useRef<Point | null>(null);
  const lastEraserClientRef = useRef<Point | null>(null);
  const [eraserIndicator, setEraserIndicator] = useState<{ x: number; y: number; r: number } | null>(null);
  const [pendingTextDelete, setPendingTextDelete] = useState<{ id: string; x: number; y: number } | null>(null);

  const [draftPenPoints, setDraftPenPoints] = useState<Point[] | null>(null);
  const [draftRect, setDraftRect] = useState<{ start: Point; end: Point } | null>(null);
  const [draftText, setDraftText] = useState<{ at: Point; value: string } | null>(null);

  const items = useMemo(() => doc.payload?.items ?? [], [doc.payload?.items]);

  useEffect(() => {
    if (!enabled) {
      setDraftPenPoints(null);
      setDraftRect(null);
      setDraftText(null);
      draftingRef.current = null;
      draftPenPointsRef.current = null;
      draftRectRef.current = null;
      setPendingTextDelete(null);
      lastEraserClientRef.current = null;
      setEraserIndicator(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || tool !== "text" || !draftText) return;
    const raf = requestAnimationFrame(() => textAreaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [draftText, enabled, tool]);

  useEffect(() => {
    if (!enabled || (tool !== "erase" && tool !== "erase_object" && tool !== "erase_precise")) {
      setPendingTextDelete(null);
      setEraserIndicator(null);
    }
  }, [enabled, tool]);

  const eraserMode: "object" | "precise" = tool === "erase_precise" ? "precise" : "object";

  const draftItem = useMemo<AnnotationItem | null>(() => {
    if (!enabled) return null;
    if (tool === "pen" && draftPenPoints && draftPenPoints.length >= 2) {
      return {
        kind: "pen",
        id: "__draft__",
        points: draftPenPoints,
        color: penColor,
        width: penWidth,
        opacity: 1,
      };
    }
    if (tool === "rect" && draftRect) {
      const { x, y, w, h } = normalizeRect(draftRect.start, draftRect.end);
      return {
        kind: "rect",
        id: "__draft__",
        x,
        y,
        w,
        h,
        mode: rectMode,
        stroke: rectColor,
        fill: rectMode === "highlight" ? "rgba(148,163,184,0.18)" : "transparent",
        strokeWidth: 2,
        opacity: 1,
        radius: 10,
      };
    }
    return null;
  }, [draftPenPoints, draftRect, enabled, penColor, penWidth, rectColor, rectMode, tool]);

  const displayItems = useMemo(() => (draftItem ? [...items, draftItem] : items), [draftItem, items]);

  const commit = (nextItems: AnnotationItem[]) => {
    onChange({
      version: Math.max(1, Number.isFinite(doc.version) ? doc.version : 1),
      payload: { items: nextItems },
    });
  };

  const worldRadiusFromPixels = (svg: SVGSVGElement, client: Point, pixelRadius: number) => {
    const p0 = svgPointFromClient(svg, client);
    const p1 = svgPointFromClient(svg, { x: client.x + 1, y: client.y });
    const worldPerPx = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    return worldPerPx * pixelRadius;
  };

  const distPointToSegmentSq = (p: Point, a: Point, b: Point) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const ab2 = abx * abx + aby * aby;
    const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;
    const cx = a.x + t * abx;
    const cy = a.y + t * aby;
    const dx = p.x - cx;
    const dy = p.y - cy;
    return dx * dx + dy * dy;
  };

  const hitTestPen = (p: Point, item: AnnotationPen, rWorld: number) => {
    const pts = item.points;
    if (!pts || pts.length < 2) return false;
    const r2 = rWorld * rWorld;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const apx = p.x - a.x;
      const apy = p.y - a.y;
      const ab2 = abx * abx + aby * aby;
      const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2)) : 0;
      const cx = a.x + t * abx;
      const cy = a.y + t * aby;
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  };

  // "最强"精准橡皮：用橡皮拖动线段（胶囊）裁剪笔画，而不是按采样点删除
  const erasePenPreciselyBySegment = (segA: Point, segB: Point, item: AnnotationPen, rWorld: number) => {
    const pts = item.points || [];
    if (pts.length < 2) return null;
    const r2 = rWorld * rWorld;

    // 先把笔画重采样到更均匀的点间距，避免“擦在线段中间但附近没点”
    const step = Math.max(1.5, Math.min(3.0, rWorld * 0.55)); // world units
    const dense: Point[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        dense.push({ x: a.x + dx * t, y: a.y + dy * t });
      }
    }
    dense.push(pts[pts.length - 1]);

    const keepMask = dense.map((p) => distPointToSegmentSq(p, segA, segB) > r2);
    if (keepMask.every(Boolean)) return null;

    // 边界补点：相邻 keep/erase 发生变化时，用二分插入一个更接近边界的点，让切口更干净
    const refined: Point[] = [];
    const refinedKeep: boolean[] = [];
    for (let i = 0; i < dense.length; i++) {
      refined.push(dense[i]);
      refinedKeep.push(keepMask[i]);
      if (i === 0) continue;
      const prevKeep = keepMask[i - 1];
      const curKeep = keepMask[i];
      if (prevKeep === curKeep) continue;
      const a = dense[i - 1];
      const b = dense[i];
      let lo = 0;
      let hi = 1;
      // find boundary where dist == r (approx)
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        const m: Point = { x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid };
        const inside = distPointToSegmentSq(m, segA, segB) <= r2;
        if (prevKeep) {
          // keep -> erase : boundary near start where it becomes inside
          if (inside) hi = mid;
          else lo = mid;
        } else {
          // erase -> keep
          if (inside) lo = mid;
          else hi = mid;
        }
      }
      const t = (lo + hi) / 2;
      const boundary: Point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      refined.push(boundary);
      refinedKeep.push(prevKeep); // keep-side boundary
    }

    const nextSegments: Point[][] = [];
    let current: Point[] = [];
    for (let i = 0; i < refined.length; i++) {
      if (refinedKeep[i]) {
        current.push(refined[i]);
      } else if (current.length) {
        nextSegments.push(current);
        current = [];
      }
    }
    if (current.length) nextSegments.push(current);

    const nextPens: AnnotationPen[] = nextSegments
      .map((seg) => {
        // 轻度抽稀，避免 payload 过大
        const decimated: Point[] = [];
        for (const p of seg) {
          const last = decimated[decimated.length - 1];
          if (!last) {
            decimated.push(p);
            continue;
          }
          const dx = p.x - last.x;
          const dy = p.y - last.y;
          if (dx * dx + dy * dy >= 0.9) decimated.push(p);
        }
        return decimated;
      })
      .filter((seg) => seg.length >= 2)
      .map((seg) => ({
        kind: "pen",
        id: id32(),
        points: seg,
        color: item.color,
        width: item.width,
        opacity: item.opacity,
      }));

    return nextPens;
  };

  const hitTestRect = (p: Point, item: AnnotationRect, marginWorld: number) => {
    const margin = marginWorld;
    const x1 = item.x;
    const y1 = item.y;
    const x2 = item.x + item.w;
    const y2 = item.y + item.h;
    const inside = p.x >= x1 - margin && p.x <= x2 + margin && p.y >= y1 - margin && p.y <= y2 + margin;
    if (!inside) return false;
    if (item.mode === "highlight") return true;
    const nearLeft = Math.abs(p.x - x1) <= margin;
    const nearRight = Math.abs(p.x - x2) <= margin;
    const nearTop = Math.abs(p.y - y1) <= margin;
    const nearBottom = Math.abs(p.y - y2) <= margin;
    return nearLeft || nearRight || nearTop || nearBottom;
  };

  const hitTestText = (p: Point, item: AnnotationText, marginWorld: number) => {
    const fontSize = clamp(item.fontSize, 10, 32);
    const w = Math.max(22, item.text.length * fontSize * 0.62);
    const h = fontSize * 1.4;
    let x = item.x;
    if (item.align === "center") x = item.x - w / 2;
    if (item.align === "right") x = item.x - w;
    const y = item.y;
    const margin = marginWorld;
    return p.x >= x - margin && p.x <= x + w + margin && p.y >= y - margin && p.y <= y + h + margin;
  };

  const eraseAtPoint = (p: Point, client: Point, opts?: { isDown?: boolean }) => {
    if (!items.length) return;
    const svg = svgRef.current;
    if (!svg) return;
    const now = performance.now();
    // avoid spamming commits when pointermove is very frequent
    if (now - lastEraseCommitAtRef.current < 35) return;
    const basePx = Math.max(4, Number.isFinite(eraserWidth) ? eraserWidth : 12);
    const pixelRadius = (tool === "erase_object" || tool === "erase") ? basePx / 2 + 6 : basePx / 2;
    const rWorld = worldRadiusFromPixels(svg, client, pixelRadius);
    const marginWorld = worldRadiusFromPixels(svg, client, tool === "erase_object" || tool === "erase" ? 6 : 3);

    if (eraserMode === "object") {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const hit =
          item.kind === "pen"
            ? hitTestPen(p, item, rWorld)
            : item.kind === "rect"
              ? hitTestRect(p, item, marginWorld)
              : hitTestText(p, item, marginWorld);
        if (!hit) continue;
        // 框：直接删
        if (item.kind === "rect") {
          setPendingTextDelete(null);
          lastEraseCommitAtRef.current = now;
          commit(items.filter((x) => x.id !== item.id));
          return;
        }
        // 字：点击命中才弹确认按钮
        if (item.kind === "text") {
          if (opts?.isDown) setPendingTextDelete({ id: item.id, x: item.x, y: item.y });
          lastEraseCommitAtRef.current = now;
          return;
        }
        // 其他：整对象删除
        setPendingTextDelete(null);
        lastEraseCommitAtRef.current = now;
        commit(items.filter((x) => x.id !== item.id));
        return;
      }
      return;
    }

    // precise: 使用拖动段（lastEraserPoint -> p）进行连续擦除
    const last = lastEraserPointRef.current ?? p;
    const segA = last;
    const segB = p;
    let changed = false;
    let nextItems: AnnotationItem[] = items;

    // 先处理“字”：只在点击时弹出确认按钮，拖动不弹
    if (opts?.isDown) {
      for (let i = nextItems.length - 1; i >= 0; i--) {
        const it = nextItems[i];
        if (it.kind !== "text") continue;
        if (hitTestText(p, it, marginWorld)) {
          setPendingTextDelete({ id: it.id, x: it.x, y: it.y });
          lastEraseCommitAtRef.current = now;
          lastEraserPointRef.current = p;
          lastEraserClientRef.current = client;
          return;
        }
      }
    }

    // 框：仍按“直接删除”逻辑（可以一次拖动删多个）
    const remaining: AnnotationItem[] = [];
    for (const it of nextItems) {
      if (it.kind === "rect" && hitTestRect(p, it, marginWorld)) {
        changed = true;
        continue;
      }
      remaining.push(it);
    }
    nextItems = remaining;

    // 笔画：对每条命中的笔画做胶囊裁剪（可分裂为多条）
    const afterPens: AnnotationItem[] = [];
    for (const it of nextItems) {
      if (it.kind !== "pen") {
        afterPens.push(it);
        continue;
      }
      // 快速跳过：端点都离得很远且不可能命中时不处理
      //（粗略：如果任一点到橡皮段距离很小才进一步裁剪）
      const maybeHit = hitTestPen(p, it, rWorld) || hitTestPen(segA, it, rWorld);
      if (!maybeHit) {
        afterPens.push(it);
        continue;
      }
      const nextPens = erasePenPreciselyBySegment(segA, segB, it, rWorld);
      if (!nextPens) {
        afterPens.push(it);
        continue;
      }
      changed = true;
      for (const np of nextPens) afterPens.push(np);
    }
    nextItems = afterPens;

    lastEraserPointRef.current = p;
    lastEraserClientRef.current = client;
    if (changed) {
      setPendingTextDelete(null);
      lastEraseCommitAtRef.current = now;
      commit(nextItems);
    }
  };

  const startDraft = (event: React.PointerEvent) => {
    if (!enabled || tool === "none") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;

    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    const p = svgPointFromClient(svg, { x: event.clientX, y: event.clientY });
    draftingRef.current = { pointerId: event.pointerId, start: p, kind: tool };
    if (enabled && tool === "erase_precise") {
      const rWorld = worldRadiusFromPixels(svg, { x: event.clientX, y: event.clientY }, Math.max(4, eraserWidth) / 2);
      setEraserIndicator({ x: p.x, y: p.y, r: rWorld });
    }

    if (tool === "erase" || tool === "erase_object" || tool === "erase_precise") {
      erasePointerIdRef.current = event.pointerId;
      lastEraserPointRef.current = p;
      lastEraserClientRef.current = { x: event.clientX, y: event.clientY };
      eraseAtPoint(p, { x: event.clientX, y: event.clientY }, { isDown: true });
      return;
    }
    if (tool === "pen") {
      draftPenPointsRef.current = [p];
      setDraftPenPoints([p]);
      return;
    }
    if (tool === "rect") {
      draftRectRef.current = { start: p, end: p };
      setDraftRect({ start: p, end: p });
      return;
    }
    if (tool === "text") {
      setDraftText({ at: p, value: "" });
      return;
    }
  };

  const moveDraft = (event: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const p = svgPointFromClient(svg, { x: event.clientX, y: event.clientY });

    // 指示器：即使未按下，也要随鼠标移动持续显示
    if (enabled && tool === "erase_precise") {
      const rWorld = worldRadiusFromPixels(svg, { x: event.clientX, y: event.clientY }, Math.max(4, eraserWidth) / 2);
      setEraserIndicator({ x: p.x, y: p.y, r: rWorld });
    }

    const draft = draftingRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;

    if (
      (draft.kind === "erase" || draft.kind === "erase_object" || draft.kind === "erase_precise") &&
      erasePointerIdRef.current === event.pointerId
    ) {
      eraseAtPoint(p, { x: event.clientX, y: event.clientY }, { isDown: false });
      return;
    }
    if (draft.kind === "pen") {
      const current = draftPenPointsRef.current || [draft.start];
      const next = [...current, p];
      if (next.length > 1) {
        const last = next[next.length - 1];
        const prev = next[next.length - 2];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        if (dx * dx + dy * dy < 0.6) return;
      }
      draftPenPointsRef.current = next;
      setDraftPenPoints(next);
      return;
    }
    if (draft.kind === "rect") {
      const current = draftRectRef.current || { start: draft.start, end: p };
      const next = { start: current.start, end: p };
      draftRectRef.current = next;
      setDraftRect(next);
    }
  };

  const endDraft = (event: React.PointerEvent) => {
    const draft = draftingRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    draftingRef.current = null;

    if (draft.kind === "erase" || draft.kind === "erase_object" || draft.kind === "erase_precise") {
      erasePointerIdRef.current = null;
      lastEraserPointRef.current = null;
      lastEraserClientRef.current = null;
      setEraserIndicator(null);
      return;
    }
    if (draft.kind === "pen") {
      const usable = draftPenPointsRef.current && draftPenPointsRef.current.length >= 2 ? draftPenPointsRef.current : null;
      if (usable) {
        const next: AnnotationPen = {
          kind: "pen",
          id: id32(),
          points: usable,
          color: penColor,
          width: clamp(penWidth, 1, 24),
          opacity: 1,
        };
        commit([...items, next]);
      }
      draftPenPointsRef.current = null;
      setDraftPenPoints(null);
      return;
    }

    if (draft.kind === "rect") {
      const rect = draftRectRef.current;
      if (rect) {
        const { x, y, w, h } = normalizeRect(rect.start, rect.end);
        if (w >= 2 && h >= 2) {
          const next: AnnotationRect = {
            kind: "rect",
            id: id32(),
            x,
            y,
            w,
            h,
            mode: rectMode,
            stroke: rectColor,
            fill: rectMode === "highlight" ? "rgba(148,163,184,0.18)" : "transparent",
            strokeWidth: 2,
            opacity: 1,
            radius: 10,
          };
          commit([...items, next]);
        }
      }
      draftRectRef.current = null;
      setDraftRect(null);
      return;
    }
  };

  const renderItem = (item: AnnotationItem) => {
    if (item.kind === "pen") {
      const d = item.points
        .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
        .join(" ");
      return (
        <path
          key={item.id}
          d={d}
          fill="none"
          stroke={item.color}
          strokeWidth={item.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={item.opacity}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    if (item.kind === "rect") {
      return (
        <rect
          key={item.id}
          x={item.x}
          y={item.y}
          width={item.w}
          height={item.h}
          rx={item.radius}
          fill={item.mode === "highlight" ? item.fill : "transparent"}
          stroke={item.mode === "outline" ? item.stroke : item.stroke}
          strokeWidth={item.strokeWidth}
          opacity={item.opacity}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    return (
      <text
        key={item.id}
        x={item.x}
        y={item.y}
        fill={item.color}
        fontSize={item.fontSize}
        fontWeight={600}
        dominantBaseline="hanging"
        textAnchor={item.align === "center" ? "middle" : item.align === "right" ? "end" : "start"}
      >
        {item.text}
      </text>
    );
  };

  const commitText = () => {
    if (!draftText) return;
    const value = draftText.value.trim();
    if (!value) {
      setDraftText(null);
      return;
    }
    const next: AnnotationText = {
      kind: "text",
      id: id32(),
      x: draftText.at.x,
      y: draftText.at.y,
      text: value,
      fontSize: clamp(textSize, 10, 32),
      color: textColor,
      align: "left",
    };
    commit([...items, next]);
    setDraftText(null);
  };

  return (
    <div id="s2g-annotation-host" className="absolute inset-0 z-[4]">
      <svg
        ref={svgRef}
        className={`absolute inset-0 h-full w-full ${
          enabled ? "pointer-events-auto" : "pointer-events-none"
        } ${enabled && tool === "erase_object" ? "cursor-crosshair" : enabled && tool === "erase_precise" ? "cursor-none" : "cursor-default"}`}
        preserveAspectRatio="none"
        onPointerDown={startDraft}
        onPointerMove={moveDraft}
        onPointerUp={endDraft}
        onPointerCancel={endDraft}
      >
        {/* 透明命中层：保证整块画布都可批注（含空白区域） */}
        <rect x="0" y="0" width="100%" height="100%" fill="transparent" />
        <g>{displayItems.map(renderItem)}</g>

        {enabled && tool === "erase_precise" && eraserIndicator ? (
          <circle
            cx={eraserIndicator.x}
            cy={eraserIndicator.y}
            r={Math.max(0.01, eraserIndicator.r)}
            fill="rgba(0,0,0,0.06)"
            stroke="rgba(229,231,235,0.85)"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ) : null}

        {enabled && (tool === "erase" || tool === "erase_object" || tool === "erase_precise") && pendingTextDelete ? (
          <foreignObject x={pendingTextDelete.x} y={pendingTextDelete.y} width="92" height="44">
            <div style={{ padding: 0, margin: 0 }}>
              <button
                type="button"
                onClick={() => {
                  const id = pendingTextDelete.id;
                  setPendingTextDelete(null);
                  commit(items.filter((x) => x.id !== id));
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "34px",
                  padding: "0 12px",
                  borderRadius: "12px",
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(127, 29, 29, 0.85)",
                  color: "rgba(255,255,255,0.92)",
                  fontSize: "12px",
                  fontWeight: 700,
                  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                  cursor: "pointer",
                }}
              >
                删除
              </button>
            </div>
          </foreignObject>
        ) : null}

        {enabled && tool === "text" && draftText ? (
          <foreignObject x={draftText.at.x} y={draftText.at.y} width="320" height="120">
            <div style={{ padding: 0, margin: 0 }}>
              <textarea
                value={draftText.value}
                ref={textAreaRef}
                placeholder="输入批注…"
                onChange={(e) => setDraftText((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
                onBlur={commitText}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    commitText();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDraftText(null);
                  }
                }}
                style={{
                  width: "300px",
                  height: "88px",
                  resize: "none",
                  padding: "10px 12px",
                  borderRadius: "12px",
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(9, 9, 11, 0.78)",
                  color: "rgba(255,255,255,0.92)",
                  outline: "none",
                  fontSize: "12px",
                  lineHeight: "18px",
                  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                }}
              />
              <div style={{ marginTop: "6px", fontSize: "10px", color: "rgba(255,255,255,0.55)" }}>
                Ctrl/⌘ + Enter 保存，Esc 取消
              </div>
            </div>
          </foreignObject>
        ) : null}
      </svg>
    </div>
  );
}

