"use client";

import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@stream2graph/ui";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type Point = { x: number; y: number };

export function PanZoomCanvas({
  className = "",
  contentClassName = "",
  style: styleProp,
  overlay,
  onZoomEnd,
  minScale = 0.6,
  maxScale = 2.4,
  initialScale = 1,
  initialOffset = { x: 0, y: 0 },
  children,
}: PropsWithChildren<{
  className?: string;
  contentClassName?: string;
  /** Merged with internal `touchAction: none`. */
  style?: CSSProperties;
  /** 固定在画布视口左下角，不参与平移/缩放（例如操作说明）。 */
  overlay?: ReactNode;
  /** When pan/zoom interaction settles, notify parent to allow a re-paint/re-mount. */
  onZoomEnd?: () => void;
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

  // Quantize translation to device-pixel grid to reduce SVG text/lines blur.
  // Pan/zoom uses fractional offsets (via zoom math), which can land on non-integer pixels.
  const devicePixelRatio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const quantizeToPixel = (v: number) => Math.round(v * devicePixelRatio) / devicePixelRatio;

  // Scheme 1: toggling `will-change` can force the browser to drop/rebuild the
  // compositor cache for transform layers, improving blur quality on small viewports.
  const [willChange, setWillChange] = useState<CSSProperties["willChange"]>("transform");
  const willChangeRestoreRaf1Ref = useRef<number | null>(null);
  const willChangeRestoreRaf2Ref = useRef<number | null>(null);
  const stateRef = useRef({
    scale,
    offset,
    minScale,
    maxScale,
  });

  const onZoomEndRef = useRef(onZoomEnd);
  useEffect(() => {
    onZoomEndRef.current = onZoomEnd;
  }, [onZoomEnd]);

  // Debounce pan/zoom settle to avoid remounting every single frame.
  const lastTransformAtRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const scheduleZoomEnd = () => {
    if (!onZoomEndRef.current) return;
    lastTransformAtRef.current = performance.now();
    if (rafIdRef.current != null) return;

    const tick = () => {
      const elapsed = performance.now() - lastTransformAtRef.current;
      if (elapsed >= 220) {
        rafIdRef.current = null;
        // Temporarily disable will-change, then restore next frames.
        setWillChange(undefined);
        if (willChangeRestoreRaf1Ref.current != null) cancelAnimationFrame(willChangeRestoreRaf1Ref.current);
        if (willChangeRestoreRaf2Ref.current != null) cancelAnimationFrame(willChangeRestoreRaf2Ref.current);
        willChangeRestoreRaf1Ref.current = requestAnimationFrame(() => {
          willChangeRestoreRaf2Ref.current = requestAnimationFrame(() => setWillChange("transform"));
        });
        onZoomEndRef.current?.();
        return;
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      if (willChangeRestoreRaf1Ref.current != null) cancelAnimationFrame(willChangeRestoreRaf1Ref.current);
      if (willChangeRestoreRaf2Ref.current != null) cancelAnimationFrame(willChangeRestoreRaf2Ref.current);
      willChangeRestoreRaf1Ref.current = null;
      willChangeRestoreRaf2Ref.current = null;
    };
  }, []);

  const transform = useMemo(
    () =>
      `translate(${quantizeToPixel(offset.x).toFixed(2)}px, ${quantizeToPixel(offset.y).toFixed(2)}px) scale(${scale.toFixed(3)})`,
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
      scheduleZoomEnd();
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
    scheduleZoomEnd();
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      // 画布内滚轮：只做缩放，不做任何平移
      event.preventDefault();
      const { scale: currentScale } = stateRef.current;
      const zoomIntensity = 0.0015;
      // 指数缩放更稳定，避免大 delta 时突兀跳变
      const scaleFactor = Math.exp(-event.deltaY * zoomIntensity);
      const next = currentScale * scaleFactor;
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
        if (target?.closest?.("[data-panzoom-controls], [data-panzoom-no-pan]")) return;
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
        scheduleZoomEnd();
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
        scheduleZoomEnd();
      }}
      style={{ touchAction: "none", ...styleProp }}
    >
      <div
        className={`absolute right-3 top-3 z-[5] flex items-center gap-1.5 rounded-lg border border-[color:var(--panzoom-chrome-border)] bg-[var(--panzoom-chrome-bg)] p-1.5 shadow-lg`}
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
        <div className="min-w-[56px] select-none text-center text-[11px] font-semibold text-[color:var(--panzoom-chrome-text)]">
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
        <div className="mx-1 h-6 w-px bg-[var(--panzoom-chrome-divider)]" aria-hidden />
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
        style={{ transform, willChange }}
      >
        {children}
      </div>
      {overlay ? (
        <div
          className="pointer-events-none absolute bottom-3 left-3 z-[6] max-w-[min(calc(100%-1.5rem),18rem)]"
          data-panzoom-no-pan
        >
          {overlay}
        </div>
      ) : null}
    </div>
  );
}

