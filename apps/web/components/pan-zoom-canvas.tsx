"use client";

import { Minus, Plus, RotateCcw } from "lucide-react";
import { type PropsWithChildren, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@stream2graph/ui";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type Point = { x: number; y: number };

export function PanZoomCanvas({
  className = "",
  contentClassName = "",
  minScale = 0.6,
  maxScale = 2.4,
  initialScale = 1,
  initialOffset = { x: 0, y: 0 },
  children,
}: PropsWithChildren<{
  className?: string;
  contentClassName?: string;
  minScale?: number;
  maxScale?: number;
  initialScale?: number;
  initialOffset?: Point;
}>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(() => clamp(initialScale, minScale, maxScale));
  const [offset, setOffset] = useState<Point>(initialOffset);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; start: Point; origin: Point } | null>(null);
  const stateRef = useRef({
    scale,
    offset,
    minScale,
    maxScale,
  });

  const transform = useMemo(
    () => `translate(${offset.x.toFixed(2)}px, ${offset.y.toFixed(2)}px) scale(${scale.toFixed(3)})`,
    [offset.x, offset.y, scale],
  );

  useEffect(() => {
    stateRef.current = { scale, offset, minScale, maxScale };
  }, [scale, offset, minScale, maxScale]);

  function zoomTo(nextScale: number, anchorClient?: Point) {
    const el = containerRef.current;
    const clamped = clamp(nextScale, minScale, maxScale);
    const currentScale = stateRef.current.scale;
    if (!el || !anchorClient) {
      setScale(clamped);
      return;
    }

    const rect = el.getBoundingClientRect();
    const anchor: Point = { x: anchorClient.x - rect.left, y: anchorClient.y - rect.top };

    setOffset((current) => {
      // anchor stays visually stable: newOffset = anchor - (anchor - offset) * (new/old)
      const ratio = clamped / currentScale;
      return {
        x: anchor.x - (anchor.x - current.x) * ratio,
        y: anchor.y - (anchor.y - current.y) * ratio,
      };
    });
    setScale(clamped);
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      // 画布内滚轮：默认缩放；若是横向滚动/按住 Shift，则平移（支持左右移动）
      event.preventDefault();
      const { scale: currentScale, offset: currentOffset } = stateRef.current;
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);

      const preferPan = event.shiftKey || absX > absY;
      if (preferPan) {
        // wheel/trackpad pan: deltaX 控制左右，deltaY 控制上下（按需可用）
        setOffset({
          x: currentOffset.x - event.deltaX,
          y: currentOffset.y - event.deltaY,
        });
        return;
      }

      const delta = -event.deltaY;
      const intensity = 0.0018;
      const next = currentScale * (1 + delta * intensity);
      zoomTo(next, { x: event.clientX, y: event.clientY });
    };

    // 关键：passive:false，确保 preventDefault 生效，页面不会上下移动
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as EventListener);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative min-h-0 overflow-hidden ${className}`}
      onPointerDown={(event) => {
        // 鼠标只允许左键拖拽；触摸/笔则忽略 button
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("[data-panzoom-controls]")) return;
        (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          origin: offset,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
        const dx = event.clientX - dragRef.current.start.x;
        const dy = event.clientY - dragRef.current.start.y;
        setOffset({ x: dragRef.current.origin.x + dx, y: dragRef.current.origin.y + dy });
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      style={{ touchAction: "none" }}
    >
      <div
        className={`absolute right-3 top-3 z-[5] flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-950/70 p-1.5 shadow-lg`}
        data-panzoom-controls
      >
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-8 rounded-md px-0 py-0"
          aria-label="缩小"
          onClick={() => zoomTo(scale / 1.18)}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <div className="min-w-[56px] select-none text-center text-[11px] font-semibold text-zinc-300">
          {Math.round(scale * 100)}%
        </div>
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-8 rounded-md px-0 py-0"
          aria-label="放大"
          onClick={() => zoomTo(scale * 1.18)}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <div className="mx-1 h-6 w-px bg-zinc-800" aria-hidden />
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-8 rounded-md px-0 py-0"
          aria-label="重置视图"
          onClick={() => {
            setScale(clamp(initialScale, minScale, maxScale));
            setOffset(initialOffset);
          }}
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>

      <div
        className={`pointer-events-none absolute inset-0 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        aria-hidden
      />
      <div
        className={`relative z-[1] origin-top-left ${contentClassName}`}
        style={{ transform, willChange: "transform" }}
      >
        {children}
      </div>
    </div>
  );
}

