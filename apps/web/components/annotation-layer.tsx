"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

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

/** 精准橡皮：mask 内黑色描边（与画笔折线同源），切口由 stroke 形状决定，不拆笔路径 */
export type AnnotationEraseMaskStroke = {
  id: string;
  points: Point[];
  /** SVG 用户单位下的描边宽度（一般为 2× 擦除半径） */
  width: number;
};

/** mask 时间序：erase 黑线挖洞，reveal 白线在同路径上恢复其后提交的墨迹可见 */
export type AnnotationMaskStroke = {
  id: string;
  kind: "erase" | "reveal";
  points: Point[];
  width: number;
};

export type AnnotationPayload = {
  items: AnnotationItem[];
  maskStrokes?: AnnotationMaskStroke[];
  /** @deprecated 旧版仅擦除；读取时并入 {@link maskStrokes}（kind: erase） */
  eraseMaskPaths?: AnnotationEraseMaskStroke[];
};

export function normalizeMaskStrokes(payload: Partial<AnnotationPayload> | undefined): AnnotationMaskStroke[] {
  if (!payload) return [];
  const ms = Array.isArray(payload.maskStrokes) ? payload.maskStrokes : undefined;
  const legacy = payload.eraseMaskPaths ?? [];
  if (ms && ms.length > 0) return ms;
  if (legacy.length > 0) {
    return legacy.map((s) => ({ id: s.id, kind: "erase" as const, points: s.points, width: s.width }));
  }
  return ms ?? [];
}

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

function pointsToMaskPathD(pts: Point[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) {
    const p = pts[0];
    return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)} l 0.02 0`;
  }
  return pts.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

export function AnnotationLayer({
  enabled,
  tool,
  doc,
  onChange,
  exportHostId = "s2g-annotation-host",
  penColor = "rgba(229,231,235,0.92)",
  penWidth = 2,
  eraserWidth = 12,
  rectMode = "outline",
  rectColor = "rgba(229,231,235,0.92)",
  rectStrokeWidth = 2,
  textColor = "rgba(229,231,235,0.92)",
  textSize = 14,
}: {
  enabled: boolean;
  tool: AnnotationTool;
  doc: AnnotationDoc;
  onChange: (next: AnnotationDoc) => void;
  /** @description 导出 SVG 时用于 `querySelector`；主图 / 结构须不同 id，避免并存时串台 */
  exportHostId?: string;
  penColor?: string;
  penWidth?: number;
  /** @description 橡皮擦粗细（屏幕像素）。只作用于 `erase_precise` / `erase_object`。 */
  eraserWidth?: number;
  rectMode?: "highlight" | "outline";
  rectColor?: string;
  /** @description 矩形描边宽度（与画笔 stroke 同语义，屏幕像素）。 */
  rectStrokeWidth?: number;
  textColor?: string;
  textSize?: number;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draftingRef = useRef<{ pointerId: number; start: Point; kind: AnnotationTool } | null>(null);
  const draftPenPointsRef = useRef<Point[] | null>(null);
  const draftRectRef = useRef<{ start: Point; end: Point } | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragTextRef = useRef<{ pointerId: number; id: string; start: Point; origin: Point } | null>(null);
  const erasePointerIdRef = useRef<number | null>(null);
  const lastEraseCommitAtRef = useRef<number>(0);
  const [eraserIndicator, setEraserIndicator] = useState<{ x: number; y: number; r: number } | null>(null);
  const draftEraseMaskPointsRef = useRef<Point[] | null>(null);
  const draftEraseMaskWidthRef = useRef<number>(0);
  const [draftEraseMaskPoints, setDraftEraseMaskPoints] = useState<Point[] | null>(null);
  const maskReactId = useId();
  const maskDomId = useMemo(() => `s2g-ann-mask-${maskReactId.replace(/:/g, "")}`, [maskReactId]);
  const eraserIndicatorRafRef = useRef<number | null>(null);
  const eraserIndicatorPendingRef = useRef<{ x: number; y: number; r: number } | null>(null);

  const scheduleEraserIndicator = (x: number, y: number, r: number) => {
    eraserIndicatorPendingRef.current = { x, y, r };
    if (eraserIndicatorRafRef.current !== null) return;
    eraserIndicatorRafRef.current = requestAnimationFrame(() => {
      eraserIndicatorRafRef.current = null;
      const v = eraserIndicatorPendingRef.current;
      if (v) setEraserIndicator(v);
    });
  };
  const [draftPenPoints, setDraftPenPoints] = useState<Point[] | null>(null);
  const [draftRect, setDraftRect] = useState<{ start: Point; end: Point } | null>(null);
  const [draftText, setDraftText] = useState<{ at: Point; value: string } | null>(null);

  const items = useMemo(() => doc.payload?.items ?? [], [doc.payload?.items]);
  const maskStrokes = useMemo(() => normalizeMaskStrokes(doc.payload), [doc.payload]);

  useEffect(() => {
    if (!enabled) {
      if (eraserIndicatorRafRef.current !== null) {
        cancelAnimationFrame(eraserIndicatorRafRef.current);
        eraserIndicatorRafRef.current = null;
      }
      eraserIndicatorPendingRef.current = null;
      setDraftPenPoints(null);
      setDraftRect(null);
      setDraftText(null);
      draftingRef.current = null;
      dragTextRef.current = null;
      draftPenPointsRef.current = null;
      draftRectRef.current = null;
      setEraserIndicator(null);
      draftEraseMaskPointsRef.current = null;
      draftEraseMaskWidthRef.current = 0;
      setDraftEraseMaskPoints(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || tool !== "text" || !draftText) return;
    const raf = requestAnimationFrame(() => textAreaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [draftText, enabled, tool]);

  useEffect(() => {
    if (!enabled || (tool !== "erase" && tool !== "erase_object" && tool !== "erase_precise")) {
      if (eraserIndicatorRafRef.current !== null) {
        cancelAnimationFrame(eraserIndicatorRafRef.current);
        eraserIndicatorRafRef.current = null;
      }
      eraserIndicatorPendingRef.current = null;
      setEraserIndicator(null);
      draftEraseMaskPointsRef.current = null;
      draftEraseMaskWidthRef.current = 0;
      setDraftEraseMaskPoints(null);
    }
  }, [enabled, tool]);

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
        strokeWidth: clamp(rectStrokeWidth, 1, 16),
        opacity: 1,
        radius: 10,
      };
    }
    return null;
  }, [draftPenPoints, draftRect, enabled, penColor, penWidth, rectColor, rectMode, rectStrokeWidth, tool]);

  const commit = (nextItems: AnnotationItem[], nextMaskStrokes?: AnnotationMaskStroke[]) => {
    onChange({
      version: Math.max(1, Number.isFinite(doc.version) ? doc.version : 1),
      payload: {
        items: nextItems,
        maskStrokes: nextMaskStrokes ?? maskStrokes,
      },
    });
  };

  const worldRadiusFromPixels = (svg: SVGSVGElement, client: Point, pixelRadius: number) => {
    const p0 = svgPointFromClient(svg, client);
    const p1 = svgPointFromClient(svg, { x: client.x + 1, y: client.y });
    const worldPerPx = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    return worldPerPx * pixelRadius;
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
    const lines = item.text.split(/\r?\n/);
    const longest = lines.reduce((m, s) => Math.max(m, s.length), 0);
    const w = Math.max(22, longest * fontSize * 0.62);
    const h = Math.max(1, lines.length) * fontSize * 1.2;
    let x = item.x;
    if (item.align === "center") x = item.x - w / 2;
    if (item.align === "right") x = item.x - w;
    const y = item.y;
    const margin = marginWorld;
    return p.x >= x - margin && p.x <= x + w + margin && p.y >= y - margin && p.y <= y + h + margin;
  };

  const eraseAtPoint = (p: Point, client: Point) => {
    if (!items.length) return;
    if (tool !== "erase" && tool !== "erase_object") return;
    const svg = svgRef.current;
    if (!svg) return;
    const now = performance.now();
    if (now - lastEraseCommitAtRef.current < 35) return;
    const basePx = Math.max(4, Number.isFinite(eraserWidth) ? eraserWidth : 12);
    const pixelRadius = tool === "erase_object" ? basePx / 2 + 6 : basePx / 2;
    const rWorld = worldRadiusFromPixels(svg, client, pixelRadius);
    const marginWorld = worldRadiusFromPixels(svg, client, tool === "erase_object" ? 6 : 3);

    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "text") continue;
      const hit =
        item.kind === "pen"
          ? hitTestPen(p, item, rWorld)
          : item.kind === "rect"
            ? hitTestRect(p, item, marginWorld)
            : false;
      if (!hit) continue;
      if (item.kind === "rect") {
        lastEraseCommitAtRef.current = now;
        commit(items.filter((x) => x.id !== item.id));
        return;
      }
      lastEraseCommitAtRef.current = now;
      commit(items.filter((x) => x.id !== item.id));
      return;
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
    if (tool === "erase_precise") {
      const client = { x: event.clientX, y: event.clientY };
      const rWorld = worldRadiusFromPixels(svg, client, Math.max(4, eraserWidth) / 2);
      setEraserIndicator({ x: p.x, y: p.y, r: rWorld });
      erasePointerIdRef.current = event.pointerId;
      draftEraseMaskWidthRef.current = Math.max(0.5, rWorld * 2);
      draftEraseMaskPointsRef.current = [p];
      setDraftEraseMaskPoints([p]);
      return;
    }

    if (tool === "erase" || tool === "erase_object") {
      erasePointerIdRef.current = event.pointerId;
      eraseAtPoint(p, { x: event.clientX, y: event.clientY });
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

    const textDrag = dragTextRef.current;
    if (textDrag && textDrag.pointerId === event.pointerId) {
      const dx = p.x - textDrag.start.x;
      const dy = p.y - textDrag.start.y;
      commit(
        items.map((it) =>
          it.kind === "text" && it.id === textDrag.id ? { ...it, x: textDrag.origin.x + dx, y: textDrag.origin.y + dy } : it,
        ),
      );
      return;
    }

    // 指示器：rAF 合并，避免每 pointermove 触发整层重绘
    if (enabled && tool === "erase_precise") {
      const rWorld = worldRadiusFromPixels(svg, { x: event.clientX, y: event.clientY }, Math.max(4, eraserWidth) / 2);
      scheduleEraserIndicator(p.x, p.y, rWorld);
    }

    const draft = draftingRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;

    if (draft.kind === "erase_precise" && erasePointerIdRef.current === event.pointerId) {
      const current = draftEraseMaskPointsRef.current || [draft.start];
      const next = [...current, p];
      if (next.length > 1) {
        const last = next[next.length - 1];
        const prev = next[next.length - 2];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        if (dx * dx + dy * dy < 0.6) return;
      }
      draftEraseMaskPointsRef.current = next;
      setDraftEraseMaskPoints(next);
      return;
    }
    if (
      (draft.kind === "erase" || draft.kind === "erase_object") &&
      erasePointerIdRef.current === event.pointerId
    ) {
      eraseAtPoint(p, { x: event.clientX, y: event.clientY });
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
    const textDrag = dragTextRef.current;
    if (textDrag && textDrag.pointerId === event.pointerId) {
      dragTextRef.current = null;
      return;
    }

    const draft = draftingRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    draftingRef.current = null;

    if (draft.kind === "erase_precise") {
      if (eraserIndicatorRafRef.current !== null) {
        cancelAnimationFrame(eraserIndicatorRafRef.current);
        eraserIndicatorRafRef.current = null;
      }
      eraserIndicatorPendingRef.current = null;
      erasePointerIdRef.current = null;
      setEraserIndicator(null);
      const pts = draftEraseMaskPointsRef.current;
      const w = draftEraseMaskWidthRef.current;
      draftEraseMaskPointsRef.current = null;
      draftEraseMaskWidthRef.current = 0;
      setDraftEraseMaskPoints(null);
      if (pts?.length && w > 0) {
        const stroke: AnnotationMaskStroke = { id: id32(), kind: "erase", points: pts, width: w };
        commit(items, [...maskStrokes, stroke]);
      }
      return;
    }
    if (draft.kind === "erase" || draft.kind === "erase_object") {
      if (eraserIndicatorRafRef.current !== null) {
        cancelAnimationFrame(eraserIndicatorRafRef.current);
        eraserIndicatorRafRef.current = null;
      }
      eraserIndicatorPendingRef.current = null;
      erasePointerIdRef.current = null;
      setEraserIndicator(null);
      return;
    }
    if (draft.kind === "pen") {
      const usable = draftPenPointsRef.current && draftPenPointsRef.current.length >= 2 ? draftPenPointsRef.current : null;
      if (usable) {
        const wPen = clamp(penWidth, 1, 24);
        const next: AnnotationPen = {
          kind: "pen",
          id: id32(),
          points: usable,
          color: penColor,
          width: wPen,
          opacity: 1,
        };
        const reveal: AnnotationMaskStroke = { id: id32(), kind: "reveal", points: usable, width: wPen };
        commit([...items, next], [...maskStrokes, reveal]);
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
            strokeWidth: clamp(rectStrokeWidth, 1, 16),
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
        {item.text.split(/\r?\n/).map((line, idx) => (
          <tspan key={`${item.id}-line-${idx}`} x={item.x} dy={idx === 0 ? 0 : "1.2em"}>
            {line || "\u00A0"}
          </tspan>
        ))}
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

  const updateTextItem = (id: string, updater: (item: AnnotationText) => AnnotationText) => {
    commit(items.map((it) => (it.kind === "text" && it.id === id ? updater(it) : it)));
  };

  const deleteTextItem = (id: string) => {
    commit(items.filter((it) => it.id !== id));
  };

  return (
    <div id={exportHostId} className="absolute inset-0 z-[4]">
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
        <defs>
          <mask id={maskDomId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {maskStrokes.map((s) => (
              <path
                key={s.id}
                d={pointsToMaskPathD(s.points)}
                fill="none"
                stroke={s.kind === "erase" ? "black" : "white"}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                shapeRendering="geometricPrecision"
              />
            ))}
            {draftEraseMaskPoints && draftEraseMaskPoints.length ? (
              <path
                d={pointsToMaskPathD(draftEraseMaskPoints)}
                fill="none"
                stroke="black"
                strokeWidth={Math.max(0.5, draftEraseMaskWidthRef.current)}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                shapeRendering="geometricPrecision"
              />
            ) : null}
          </mask>
        </defs>
        {/* 透明命中层：整块可点；置于底层，草稿笔在蒙版外以便在擦除区继续画 */}
        <rect x="0" y="0" width="100%" height="100%" fill="transparent" />
        <g mask={`url(#${maskDomId})`}>{items.map((item) => (item.kind === "text" ? null : renderItem(item)))}</g>
        {enabled && tool === "text" ? null : <g>{items.map((item) => (item.kind === "text" ? renderItem(item) : null))}</g>}
        {draftItem ? <g>{renderItem(draftItem)}</g> : null}

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

        {enabled && tool === "text"
          ? items
              .filter((it): it is AnnotationText => it.kind === "text")
              .map((it) => (
                <foreignObject key={`text-editor-${it.id}`} x={it.x} y={it.y - 23} width="320" height="140">
                  <div
                    style={{
                      padding: 0,
                      margin: 0,
                      width: "300px",
                    }}
                  >
                    <div
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        const svg = svgRef.current;
                        if (!svg) return;
                        const p = svgPointFromClient(svg, { x: e.clientX, y: e.clientY });
                        dragTextRef.current = { pointerId: e.pointerId, id: it.id, start: p, origin: { x: it.x, y: it.y } };
                        svg.setPointerCapture(e.pointerId);
                      }}
                      style={{
                        height: "20px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0 8px",
                        borderRadius: "10px 10px 0 0",
                        border: "1px solid rgba(234,179,8,0.45)",
                        borderBottom: "none",
                        background: "rgba(254,249,195,0.92)",
                        color: "rgba(113,63,18,0.88)",
                        fontSize: "10px",
                        cursor: "grab",
                        userSelect: "none",
                      }}
                    >
                      <span>拖动文本</span>
                      <button
                        type="button"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteTextItem(it.id);
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "rgba(185,28,28,0.92)",
                          fontSize: "11px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        删除
                      </button>
                    </div>
                    <textarea
                      value={it.text}
                      onPointerDown={(e) => e.stopPropagation()}
                      placeholder="输入批注…"
                      onChange={(e) => updateTextItem(it.id, (cur) => ({ ...cur, text: e.target.value }))}
                      style={{
                        width: "300px",
                        height: "88px",
                        resize: "none",
                        padding: "3px 0 0 0",
                        borderRadius: "0 0 12px 12px",
                        border: "1px solid rgba(234,179,8,0.45)",
                        background: "rgba(254,252,232,0.95)",
                        color: it.color || textColor,
                        outline: "none",
                        fontSize: `${clamp(it.fontSize ?? textSize, 10, 32)}px`,
                        fontWeight: 600,
                        lineHeight: "1.2",
                        fontFamily: "inherit",
                        boxShadow: "0 10px 24px rgba(161,98,7,0.2)",
                      }}
                    />
                  </div>
                </foreignObject>
              ))
          : null}

        {enabled && tool === "text" && draftText ? (
          <foreignObject x={draftText.at.x} y={draftText.at.y - 3} width="320" height="120">
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
                  padding: "3px 0 0 0",
                  borderRadius: "12px",
                  border: "1px solid rgba(234,179,8,0.45)",
                  background: "rgba(254,252,232,0.95)",
                  color: textColor,
                  outline: "none",
                  fontSize: `${clamp(textSize, 10, 32)}px`,
                  fontWeight: 600,
                  lineHeight: "1.2",
                  fontFamily: "inherit",
                  boxShadow: "0 10px 24px rgba(161,98,7,0.2)",
                }}
              />
              <div style={{ marginTop: "6px", fontSize: "10px", color: "rgba(120,53,15,0.72)" }}>
                Ctrl/⌘ + Enter 保存，Esc 取消
              </div>
            </div>
          </foreignObject>
        ) : null}
      </svg>
    </div>
  );
}

