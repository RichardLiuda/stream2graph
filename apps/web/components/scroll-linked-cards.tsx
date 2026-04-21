"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValueEvent, useScroll } from "framer-motion";

type LinkedCardTone = "paper" | "note" | "code" | "chip";

export type LinkedCard = {
  id: string;
  eyebrow?: string;
  title: string;
  description?: string;
  tone?: LinkedCardTone;
  meta?: string;
  branches?: Array<{
    id: string;
    label: string;
    hint?: string;
    side?: "left" | "right";
    direction?: "outbound" | "inbound";
  }>;
};

export type ScrollLinkedCardsBlock = {
  id: string;
  kicker: string;
  title: string;
  description: string;
  direction: "left" | "right";
  cards: LinkedCard[];
};

type ArrowSegment = {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  sourceId?: string;
  targetId?: string;
};

type NodeRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
};

function edgePointToward(rect: NodeRect, targetX: number, targetY: number) {
  const dx = targetX - rect.centerX;
  const dy = targetY - rect.centerY;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const x = dx >= 0 ? rect.right : rect.left;
    const y = clamp(targetY, rect.top + 16, rect.bottom - 16);
    return { x, y };
  }
  const y = dy >= 0 ? rect.bottom : rect.top;
  const x = clamp(targetX, rect.left + 18, rect.right - 18);
  return { x, y };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const register = (node: T | null) => {
    ref.current = node;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) => {
        if (prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    });
    ro.observe(node);
    return () => ro.disconnect();
  };

  return { ref, register, size } as const;
}

function cardToneClasses(tone: LinkedCardTone | undefined) {
  switch (tone) {
    case "note":
      return {
        shell:
          "border-amber-200/30 bg-gradient-to-b from-amber-100/10 via-surface-1/70 to-surface-2/40 shadow-[0_26px_90px_-40px_rgba(251,191,36,0.25)]",
        accent: "bg-amber-300/70",
      };
    case "code":
      return {
        shell:
          "border-theme-default bg-gradient-to-b from-surface-1/90 via-surface-2/35 to-surface-1/80 shadow-[0_28px_100px_-44px_rgba(124,111,154,0.30)]",
        accent: "bg-[color:var(--accent)]/80",
      };
    case "chip":
      return {
        shell:
          "border-emerald-200/20 bg-gradient-to-b from-emerald-100/10 via-surface-1/70 to-surface-2/40 shadow-[0_26px_90px_-40px_rgba(16,185,129,0.22)]",
        accent: "bg-emerald-300/70",
      };
    case "paper":
    default:
      return {
        shell:
          "border-theme-default bg-gradient-to-b from-surface-1/90 via-surface-2/35 to-surface-1/80 shadow-[0_28px_100px_-44px_rgba(124,111,154,0.30)]",
        accent: "bg-[color:var(--accent)]/80",
      };
  }
}

function LinkedCardView({
  card,
  style,
  index,
  sizeVariant,
  dragBounds,
  dragOffset,
  onDragEnd,
  onDragStart,
  onDrag,
  cardRef,
}: {
  card: LinkedCard;
  style: React.CSSProperties;
  index: number;
  sizeVariant: "sm" | "md" | "lg";
  dragBounds: { left: number; right: number; top: number; bottom: number };
  dragOffset: { x: number; y: number };
  onDragEnd: (delta: { x: number; y: number }) => void;
  onDragStart?: () => void;
  onDrag?: (delta: { x: number; y: number }) => void;
  cardRef?: (node: HTMLDivElement | null) => void;
}) {
  const tone = cardToneClasses(card.tone);
  const cardSizeClass =
    sizeVariant === "lg"
      ? "w-[min(34.5rem,90vw)] sm:w-[34.5rem] rounded-[2.2rem] p-8"
      : sizeVariant === "md"
        ? "w-[min(30.5rem,86vw)] sm:w-[30.5rem] rounded-[2rem] p-7"
        : "w-[min(26.5rem,82vw)] sm:w-[26.5rem] rounded-[1.8rem] p-6";
  const titleSizeClass = sizeVariant === "lg" ? "mt-2.5 text-[2.05rem] sm:text-[2.2rem]" : sizeVariant === "md" ? "mt-2.5 text-[1.9rem] sm:text-[2.05rem]" : "mt-2 text-[1.65rem] sm:text-[1.8rem]";
  const bodySizeClass = sizeVariant === "lg" ? "mt-5 text-[17px] sm:text-[18px] md:text-[19px]" : sizeVariant === "md" ? "mt-5 text-[16px] sm:text-[17px] md:text-[18px]" : "mt-4 text-[15px] sm:text-[16px] md:text-[17px]";
  return (
    <motion.div
      ref={cardRef}
      drag
      dragMomentum={false}
      dragElastic={0.03}
      dragConstraints={dragBounds}
      onDragStart={onDragStart}
      onDrag={(_, info) => onDrag?.({ x: info.offset.x, y: info.offset.y })}
      onDragEnd={(_, info) => onDragEnd({ x: info.offset.x, y: info.offset.y })}
      style={{
        ...style,
        // 基座位置由 style.left/top 决定；x/y 只负责“拖拽偏移”，避免双重位移/松手跳动。
        x: dragOffset.x,
        y: dragOffset.y,
      }}
      className={`group absolute -translate-x-1/2 -translate-y-1/2 cursor-grab border backdrop-blur-md transition-colors duration-200 hover:-translate-y-[calc(50%+2px)] hover:border-theme-strong active:cursor-grabbing ${cardSizeClass} ${tone.shell}`}
      data-card-index={index}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {card.eyebrow ? (
            <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-theme-4">{card.eyebrow}</div>
          ) : null}
          <div className={`font-display font-semibold tracking-tight text-theme-1 ${titleSizeClass}`}>
            {card.title}
          </div>
        </div>
        <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-[1.35rem] border border-theme-subtle bg-surface-muted/70">
          <span className={`h-3 w-3 rounded-full ${tone.accent}`} aria-hidden />
        </span>
      </div>
      {card.description ? (
        <p className={`leading-relaxed text-theme-3 ${bodySizeClass}`}>
          {card.description}
        </p>
      ) : null}
      {card.meta ? (
        <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-theme-4">
          <span className="truncate">{card.meta}</span>
          <span className="h-px flex-1 bg-gradient-to-r from-theme-subtle to-transparent" aria-hidden />
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-x-5 bottom-0 h-px bg-gradient-to-r from-transparent via-[color:var(--accent)]/30 to-transparent opacity-70" />
    </motion.div>
  );
}

function BranchCardView({
  label,
  hint,
  style,
  dragOffset,
  dragBounds,
  onDragStart,
  onDrag,
  onDragEnd,
  nodeRef,
}: {
  label: string;
  hint?: string;
  style: React.CSSProperties;
  dragOffset: { x: number; y: number };
  dragBounds: { left: number; right: number; top: number; bottom: number };
  onDragStart?: () => void;
  onDrag?: (delta: { x: number; y: number }) => void;
  onDragEnd: (delta: { x: number; y: number }) => void;
  nodeRef?: (node: HTMLDivElement | null) => void;
}) {
  return (
    <motion.div
      ref={nodeRef}
      drag
      dragMomentum={false}
      dragElastic={0.04}
      dragConstraints={dragBounds}
      onDragStart={onDragStart}
      onDrag={(_, info) => onDrag?.({ x: info.offset.x, y: info.offset.y })}
      onDragEnd={(_, info) => onDragEnd({ x: info.offset.x, y: info.offset.y })}
      style={{ ...style, x: dragOffset.x, y: dragOffset.y }}
      className="absolute -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-xl border border-theme-subtle bg-surface-1/92 px-3 py-2 shadow-[0_14px_36px_-20px_rgba(88,74,130,0.42)] backdrop-blur-sm transition-colors hover:border-theme-strong active:cursor-grabbing min-w-[118px] max-w-[190px]"
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--accent-strong)] whitespace-nowrap">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-theme-4 break-keep">{hint}</div> : null}
    </motion.div>
  );
}

function ArrowOverlay({
  blockId,
  segments,
  direction,
  width,
  height,
  activeNodeId,
  interactionLevel,
  scrollProgress,
}: {
  blockId: string;
  segments: ArrowSegment[];
  direction: "left" | "right";
  width: number;
  height: number;
  activeNodeId: string | null;
  interactionLevel: number;
  scrollProgress: number;
}) {
  if (segments.length === 0 || width <= 0 || height <= 0) return null;
  const markerId = `card-arrow-overlay-${blockId}-${direction}`;
  const gradientId = `card-arrow-grad-${blockId}-${direction}`;
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-40"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(76,65,118,0.28)" />
          <stop offset="45%" stopColor="rgba(101,87,151,0.9)" />
          <stop offset="100%" stopColor="rgba(66,55,104,0.38)" />
          <animateTransform attributeName="gradientTransform" type="translate" values="-0.45 0;0.45 0;-0.45 0" dur="4.8s" repeatCount="indefinite" />
        </linearGradient>
        <marker
          id={markerId}
          viewBox="0 0 12 12"
          refX="10"
          refY="6"
          markerWidth="7.6"
          markerHeight="7.6"
          orient="auto"
        >
          <path d="M 0 0 L 12 6 L 0 12 z" fill="rgba(68,57,106,1)" />
        </marker>
      </defs>
      {segments.map((seg, index) => {
        const dx = seg.endX - seg.startX;
        const dy = seg.endY - seg.startY;
        const span = Math.abs(dx);
        const curvature = clamp(span * 0.23, 38, 152);
        const sway = clamp(Math.abs(dy) * 0.22, 0, 32) * (dy >= 0 ? 1 : -1);
        const c1x = seg.startX + (dx >= 0 ? curvature : -curvature);
        const c2x = seg.endX - (dx >= 0 ? curvature : -curvature);
        const c1y = seg.startY + sway * 0.5;
        const c2y = seg.endY - sway * 0.5;
        const d = `M ${seg.startX.toFixed(2)} ${seg.startY.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${seg.endX.toFixed(2)} ${seg.endY.toFixed(2)}`;
        const scrollBin = Math.floor(scrollProgress * 6);
        const styleGroup = (Math.floor(index / 2) + scrollBin) % 6;
        const related = !!activeNodeId && (seg.sourceId === activeNodeId || seg.targetId === activeNodeId || seg.id.includes(activeNodeId));
        const focusBoost = related ? 1 : 0;
        const attenuate = activeNodeId && !related ? 0.34 : 1;
        const wheelBias = 1 + scrollProgress * 0.5;
        const flowDuration = (1.9 + (index % 4) * 0.36) * (1 - interactionLevel * 0.34 - focusBoost * 0.2) / wheelBias;
        const pulseDuration = (1.55 + (index % 3) * 0.28) * (1 - interactionLevel * 0.22 - focusBoost * 0.16) / (0.88 + scrollProgress * 0.35);
        const dashPattern =
          styleGroup === 0 ? "10 14" : styleGroup === 1 ? "4 10" : styleGroup === 2 ? "15 8 2 10" : styleGroup === 3 ? "2 8" : styleGroup === 4 ? "18 7 4 9" : "3 5";
        const coreStroke = styleGroup === 0 ? 3.4 : styleGroup === 1 ? 3.1 : styleGroup === 2 ? 3.7 : styleGroup === 3 ? 3.25 : styleGroup === 4 ? 3.95 : 2.9;
        const overlayOpacity = (0.36 + focusBoost * 0.45 + interactionLevel * 0.24 + scrollProgress * 0.12) * attenuate;
        const dashDrift = styleGroup === 3 || styleGroup === 5 ? 84 : -96;
        const flickerDur = styleGroup === 2 ? "0.7s" : styleGroup === 4 ? "0.54s" : "1.1s";
        const wheelPulseOffset = -((scrollProgress * 240 + index * 22) % 280);
        const wheelPulseOffsetB = -((scrollProgress * 380 + index * 35) % 340);
        return (
          <g key={seg.id}>
            <path d={d} stroke="rgba(68,57,106,0.42)" strokeWidth={5.8 + focusBoost * 1.4} strokeLinecap="round" opacity={0.2 + overlayOpacity * 0.58} />
            <path d={d} stroke={`url(#${gradientId})`} strokeWidth={coreStroke + focusBoost * 0.7} strokeLinecap="round" markerEnd={`url(#${markerId})`} opacity={0.62 + focusBoost * 0.36} />
            <path d={d} stroke="rgba(164,150,234,0.72)" strokeWidth="2" strokeLinecap="round" opacity="0.45">
              <animate attributeName="opacity" values={related ? "0.45;1;0.45" : "0.18;0.58;0.18"} dur={`${pulseDuration}s`} repeatCount="indefinite" />
              <animate attributeName="stroke-width" values={related ? "2;3.2;2" : "1.4;2.2;1.4"} dur={`${pulseDuration}s`} repeatCount="indefinite" />
            </path>
            <path
              d={d}
              stroke="rgba(235,231,255,0.95)"
              strokeWidth={1.65 + focusBoost * 0.9}
              strokeLinecap="round"
              strokeDasharray={dashPattern}
              strokeDashoffset="0"
              markerEnd={`url(#${markerId})`}
              opacity={overlayOpacity}
            >
              <animate attributeName="stroke-dashoffset" values={`0;${dashDrift}`} dur={`${Math.max(0.38, flowDuration)}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values={related ? "0.4;1;0.4" : "0.08;0.75;0.08"} dur={flickerDur} repeatCount="indefinite" />
            </path>
            <path
              d={d}
              stroke="rgba(255,255,255,0.92)"
              strokeWidth={1 + focusBoost * 0.45}
              strokeLinecap="round"
              strokeDasharray="14 280"
              strokeDashoffset={wheelPulseOffset}
              opacity={(0.2 + scrollProgress * 0.45 + focusBoost * 0.18) * attenuate}
            />
          </g>
        );
      })}
    </svg>
  );
}

function BranchArrowOverlay({
  blockId,
  segments,
  width,
  height,
  activeNodeId,
  interactionLevel,
  scrollProgress,
}: {
  blockId: string;
  segments: ArrowSegment[];
  width: number;
  height: number;
  activeNodeId: string | null;
  interactionLevel: number;
  scrollProgress: number;
}) {
  if (segments.length === 0 || width <= 0 || height <= 0) return null;
  const markerId = `branch-arrow-overlay-${blockId}`;
  const gradientId = `branch-arrow-grad-${blockId}`;
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-50"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(125,108,182,0.12)" />
          <stop offset="38%" stopColor="rgba(121,99,198,0.88)" />
          <stop offset="100%" stopColor="rgba(94,75,160,0.28)" />
          <animateTransform attributeName="gradientTransform" type="translate" values="-0.55 0;0.55 0;-0.55 0" dur="3.9s" repeatCount="indefinite" />
        </linearGradient>
        <marker id={markerId} viewBox="0 0 12 12" refX="10" refY="6" markerWidth="6.6" markerHeight="6.6" orient="auto">
          <path d="M 0 0 L 12 6 L 0 12 z" fill="rgba(88,74,130,0.96)" />
        </marker>
      </defs>
      {segments.map((seg, index) => {
        const dx = seg.endX - seg.startX;
        const dy = seg.endY - seg.startY;
        const curve = clamp(Math.abs(dx) * 0.24, 20, 70);
        const twist = clamp(Math.abs(dy) * 0.16, 0, 16) * (dy >= 0 ? 1 : -1);
        const c1x = seg.startX + (dx >= 0 ? curve : -curve);
        const c2x = seg.endX - (dx >= 0 ? curve : -curve);
        const c1y = seg.startY + twist * 0.45;
        const c2y = seg.endY - twist * 0.45;
        const d = `M ${seg.startX.toFixed(2)} ${seg.startY.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${seg.endX.toFixed(2)} ${seg.endY.toFixed(2)}`;
        const scrollBin = Math.floor(scrollProgress * 5);
        const styleGroup = (Math.floor(index / 3) + scrollBin) % 5;
        const related = !!activeNodeId && (seg.sourceId === activeNodeId || seg.targetId === activeNodeId || seg.id.includes(activeNodeId));
        const attenuate = activeNodeId && !related ? 0.28 : 1;
        const branchFlow = (1.45 + (index % 4) * 0.24) * (1 - interactionLevel * 0.35 - (related ? 0.22 : 0)) / (0.92 + scrollProgress * 0.5);
        const dashPattern = styleGroup === 0 ? "8 11" : styleGroup === 1 ? "3 8" : styleGroup === 2 ? "10 8 3 8" : styleGroup === 3 ? "2 7" : "14 9";
        const dashDrift = styleGroup === 1 || styleGroup === 3 ? 64 : -72;
        const wheelPulseOffset = -((scrollProgress * 200 + index * 19) % 250);
        return (
          <g key={seg.id}>
            <path d={d} stroke="rgba(88,74,130,0.3)" strokeWidth={3.1 + (related ? 1.2 : 0)} strokeLinecap="round" opacity={0.4 * attenuate} />
            <path d={d} stroke={`url(#${gradientId})`} strokeWidth={2.15 + (related ? 0.5 : 0)} strokeLinecap="round" markerEnd={`url(#${markerId})`} opacity={0.65 + (related ? 0.3 : 0)} />
            <path d={d} stroke="rgba(228,220,255,0.92)" strokeWidth={1.05 + (related ? 0.45 : 0)} strokeLinecap="round" strokeDasharray={dashPattern} markerEnd={`url(#${markerId})`} opacity={attenuate}>
              <animate attributeName="stroke-dashoffset" values={`0;${dashDrift}`} dur={`${Math.max(0.34, branchFlow)}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values={related ? "0.35;1;0.35" : "0.1;0.72;0.1"} dur={styleGroup === 2 ? "0.72s" : styleGroup === 4 ? "0.62s" : "0.95s"} repeatCount="indefinite" />
            </path>
            <path
              d={d}
              stroke="rgba(255,244,214,0.95)"
              strokeWidth="0.8"
              strokeLinecap="round"
              strokeDasharray="10 260"
              strokeDashoffset={wheelPulseOffset}
              opacity={(0.16 + scrollProgress * 0.42) * attenuate}
            />
          </g>
        );
      })}
    </svg>
  );
}

function ConnectorLayer({
  width,
  height,
  points,
  markerId,
  direction,
}: {
  width: number;
  height: number;
  points: Array<{ x: number; y: number }>;
  markerId: string;
  direction: "left" | "right";
}) {
  const segments = useMemo(() => {
    if (points.length < 2) return [];
    const ordered = direction === "right" ? points : [...points].reverse();
    const parts: Array<{ id: string; d: string }> = [];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const a = ordered[i]!;
      const b = ordered[i + 1]!;
      const dx = b.x - a.x;
      const direction = Math.sign(dx || 1);
      const span = Math.abs(dx);
      const edgeInset = clamp(span * 0.33, 140, 260);
      const startX = a.x + direction * edgeInset;
      const endX = b.x - direction * edgeInset;
      const localSpan = Math.abs(endX - startX);
      if (localSpan < 20) continue;

      // 每一对相邻卡片一根独立箭头，不共享连线。
      const curveSign = i % 2 === 0 ? -1 : 1;
      const baseLift = clamp(localSpan * 0.22, 14, 36);
      const ctrlLift = baseLift * curveSign;
      const c1x = startX + (endX - startX) * 0.35;
      const c2x = startX + (endX - startX) * 0.68;
      const c1y = a.y + ctrlLift;
      const c2y = b.y - ctrlLift * 0.85;

      parts.push({
        id: `${i}-${i + 1}`,
        d: `M ${startX.toFixed(2)} ${a.y.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${endX.toFixed(2)} ${b.y.toFixed(2)}`,
      });
    }
    return parts;
  }, [direction, points]);

  if (segments.length === 0 || width <= 0 || height <= 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-30"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`${markerId}-stroke`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(90,76,127,0.40)" />
          <stop offset="45%" stopColor="rgba(90,76,127,0.78)" />
          <stop offset="100%" stopColor="rgba(90,76,127,1)" />
        </linearGradient>
        <marker
          id={markerId}
          viewBox="0 0 12 12"
          refX="10"
          refY="6"
          markerWidth="10"
          markerHeight="10"
          orient="auto"
        >
          <path d="M 0 1 L 11 6 L 0 11 z" fill="rgba(90,76,127,1)" />
        </marker>
      </defs>
      {segments.map((seg) => (
        <g key={seg.id}>
          <path
            d={seg.d}
            stroke={`url(#${markerId}-stroke)`}
            strokeWidth="3.6"
            strokeLinecap="round"
            markerEnd={`url(#${markerId})`}
          />
        </g>
      ))}
    </svg>
  );
}

export function ScrollLinkedCardsBlockSection({
  rootRef,
  block,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  block: ScrollLinkedCardsBlock;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageSize = useElementSize<HTMLDivElement>();
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [branchDragOffsets, setBranchDragOffsets] = useState<Record<string, { x: number; y: number }>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(`s2g-branch-offsets:${block.id}`);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
      return parsed ?? {};
    } catch {
      return {};
    }
  });
  const dragStartOffsetsRef = useRef<Record<string, { x: number; y: number }>>({});
  const branchDragStartOffsetsRef = useRef<Record<string, { x: number; y: number }>>({});
  const cardNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const branchNodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [cardRects, setCardRects] = useState<Record<string, NodeRect>>({});
  const [branchRects, setBranchRects] = useState<Record<string, NodeRect>>({});
  const [activeDragNodeId, setActiveDragNodeId] = useState<string | null>(null);
  const [rawProgress, setRawProgress] = useState(0);
  const lockedProgressRef = useRef(0);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`s2g-branch-offsets:${block.id}`, JSON.stringify(branchDragOffsets));
    } catch {
      // ignore write failures (private mode / quota)
    }
  }, [block.id, branchDragOffsets]);

  const { scrollYProgress } = useScroll({
    container: rootRef,
    target: sectionRef,
    // 进入该 block 即开始播放，直到 block 结束才释放到下一个 block。
    offset: ["start start", "end start"],
  });

  const directionSign = block.direction === "left" ? -1 : 1;
  const cardCount = block.cards.length;
  const expectedArrowCount = Math.max(0, cardCount - 1);
  const cardGap = 560;
  const cardOffsets = useMemo(() => {
    if (cardCount <= 0) return [];
    const progressive: number[] = new Array(cardCount).fill(0);
    for (let i = 1; i < cardCount; i += 1) {
      // 间距只放大不缩小：最小 1.0x，最大 1.28x。
      const spacingMultiplier = 1 + (i % 3) * 0.14;
      progressive[i] = progressive[i - 1]! + cardGap * spacingMultiplier;
    }
    const mid = (cardCount - 1) / 2;
    const center = progressive[Math.round(mid)] ?? 0;
    return progressive.map((x) => x - center);
  }, [cardCount, cardGap]);
  const centerSpan = useMemo(() => {
    if (cardOffsets.length === 0) return 0;
    const first = cardOffsets[0] ?? 0;
    const last = cardOffsets[cardOffsets.length - 1] ?? 0;
    return Math.max(Math.abs(first), Math.abs(last));
  }, [cardOffsets]);
  useMotionValueEvent(scrollYProgress, "change", (value) => {
    setRawProgress(value);
  });
  const progress = clamp(rawProgress, 0, 1);
  const stableProgress = activeDragNodeId ? lockedProgressRef.current : progress;
  const interactionLevel = activeDragNodeId ? 0.78 : 0.12;
  // 尾段缓冲：最后一张卡片要“离开阅读区”后才释放到下一屏。
  // 直到最后一张卡片明确“开始离开”阅读区后才允许解锁。
  const readingExitPx = Math.max(460, stageSize.size.width * 0.38);
  const tailProgress =
    centerSpan > 0 ? clamp(readingExitPx / Math.max(1, centerSpan * 2), 0.2, 0.42) : 0.26;
  const motionProgress = clamp(stableProgress * (1 + tailProgress), 0, 1 + tailProgress);
  const scrollShift = directionSign * centerSpan + (-directionSign * centerSpan - directionSign * centerSpan) * motionProgress;
  const glow =
    stableProgress <= 0.55
      ? 0.4 + ((1 - 0.4) * stableProgress) / 0.55
      : 1 + ((0.55 - 1) * (stableProgress - 0.55)) / 0.45;

  // 每个系列的“播放长度”：卡越多，需要更长滚动距离。
  const playbackVh = useMemo(() => {
    // 既考虑卡片数量，也考虑真实横向位移跨度，避免“最后一张还没跑完就释放到下一屏”。
    const base = 170;
    const byCardCount = 62 * Math.max(1, cardCount);
    const readingExitPx = Math.max(460, stageSize.size.width * 0.38);
    const travelPx = centerSpan * 2 + readingExitPx;
    const byTravel = travelPx > 0 ? travelPx / 9 : 0;
    return Math.round(base + Math.max(byCardCount, byTravel));
  }, [cardCount, centerSpan, stageSize.size.width]);

  const connectorPoints = useMemo(() => {
    const { width, height } = stageSize.size;
    if (width <= 0 || height <= 0) return [];
    const centerY = height * 0.5;
    const baseX = width * 0.5;
    const points: Array<{ x: number; y: number }> = [];
    const mid = (cardCount - 1) / 2;

    for (let i = 0; i < cardCount; i += 1) {
      const jitter = (i % 2 === 0 ? -1 : 1) * 14;
      points.push({
        x: baseX + (i - mid) * (cardGap * 0.92),
        y: centerY + jitter * 1.55,
      });
    }
    return points;
  }, [cardCount, cardGap, stageSize.size]);
  const cardYs = useMemo(() => {
    return block.cards.map((_, index) => {
      const ySeed = index % 4;
      return ySeed === 0 ? -30 : ySeed === 1 ? 14 : ySeed === 2 ? 28 : -16;
    });
  }, [block.cards]);
  const cardSizeVariants = useMemo(() => {
    const mid = (cardCount - 1) / 2;
    return block.cards.map((_, index) => {
      const distanceFromCenter = Math.abs(index - Math.round(mid));
      return distanceFromCenter === 0 ? "lg" : distanceFromCenter === 1 ? "md" : "sm";
    });
  }, [block.cards, cardCount]);
  const cardWidthPx = (variant: "sm" | "md" | "lg") => {
    const viewportWidth = stageSize.size.width > 0 ? stageSize.size.width : 1440;
    if (variant === "lg") return Math.min(34.5 * 16, viewportWidth * 0.9);
    if (variant === "md") return Math.min(30.5 * 16, viewportWidth * 0.86);
    return Math.min(26.5 * 16, viewportWidth * 0.82);
  };

  useLayoutEffect(() => {
    const stageEl = stageSize.ref.current;
    if (!stageEl) return;
    const stageRect = stageEl.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;
    const nextCards: Record<string, NodeRect> = {};
    for (const card of block.cards) {
      const node = cardNodeRefs.current[card.id];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      nextCards[card.id] = {
        left: rect.left - stageRect.left,
        right: rect.right - stageRect.left,
        top: rect.top - stageRect.top,
        bottom: rect.bottom - stageRect.top,
        centerX: rect.left - stageRect.left + rect.width / 2,
        centerY: rect.top - stageRect.top + rect.height / 2,
      };
    }
    const nextBranches: Record<string, NodeRect> = {};
    for (const card of block.cards) {
      for (const branch of card.branches ?? []) {
        const key = `${card.id}::${branch.id}`;
        const node = branchNodeRefs.current[key];
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        nextBranches[key] = {
          left: rect.left - stageRect.left,
          right: rect.right - stageRect.left,
          top: rect.top - stageRect.top,
          bottom: rect.bottom - stageRect.top,
          centerX: rect.left - stageRect.left + rect.width / 2,
          centerY: rect.top - stageRect.top + rect.height / 2,
        };
      }
    }
    setCardRects((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(nextCards);
      if (prevKeys.length !== nextKeys.length) return nextCards;
      for (const key of nextKeys) {
        const a = prev[key];
        const b = nextCards[key];
        if (!a || !b) return nextCards;
        if (
          Math.abs(a.left - b.left) > 0.25 ||
          Math.abs(a.right - b.right) > 0.25 ||
          Math.abs(a.top - b.top) > 0.25 ||
          Math.abs(a.bottom - b.bottom) > 0.25 ||
          Math.abs(a.centerX - b.centerX) > 0.25 ||
          Math.abs(a.centerY - b.centerY) > 0.25
        ) {
          return nextCards;
        }
      }
      return prev;
    });
    setBranchRects((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(nextBranches);
      if (prevKeys.length !== nextKeys.length) return nextBranches;
      for (const key of nextKeys) {
        const a = prev[key];
        const b = nextBranches[key];
        if (!a || !b) return nextBranches;
        if (
          Math.abs(a.left - b.left) > 0.25 ||
          Math.abs(a.right - b.right) > 0.25 ||
          Math.abs(a.top - b.top) > 0.25 ||
          Math.abs(a.bottom - b.bottom) > 0.25 ||
          Math.abs(a.centerX - b.centerX) > 0.25 ||
          Math.abs(a.centerY - b.centerY) > 0.25
        ) {
          return nextBranches;
        }
      }
      return prev;
    });
  }, [block.cards, dragOffsets, branchDragOffsets, rawProgress, stageSize.ref, stageSize.size.width, stageSize.size.height, activeDragNodeId]);

  return (
    <section
      ref={sectionRef}
      className="relative mx-auto w-full px-0 text-theme-2"
      style={{ height: `calc(${playbackVh}vh)` }}
    >
      {/* Sticky 舞台：系列播完前固定在视口，不随页面上下移动 */}
      <div className="sticky top-0 h-[100dvh] w-full overflow-hidden">
        {/* 顶部单行头部：固定在舞台里 */}
        <div className="mx-auto w-full max-w-6xl px-6 pt-10 md:px-10 md:pt-12">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-theme-subtle bg-surface-muted/60 px-3 py-1 text-xs font-medium text-theme-3">
                  <span className="h-1.5 w-1.5 rounded-sm bg-[color:var(--accent)]/80" aria-hidden />
                  {block.kicker}
                </span>
                <h2 className="font-display truncate text-2xl font-semibold tracking-tight text-theme-1 sm:text-3xl">
                  {block.title}
                </h2>
                <span
                  className="hidden h-px w-10 shrink-0 bg-gradient-to-r from-[color:var(--accent)]/55 to-transparent md:block"
                  aria-hidden
                />
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-theme-3 md:truncate md:text-base">
                  {block.description}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <span className="rounded-full border border-theme-subtle bg-surface-2/70 px-3 py-1.5 text-xs font-medium text-theme-3">
                {cardCount} cards / {expectedArrowCount} arrows
              </span>
              {block.cards.slice(0, 3).map((c) => (
                <span
                  key={c.id}
                  className="rounded-full border border-theme-subtle bg-surface-2/70 px-3 py-1.5 text-xs font-medium text-theme-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
                >
                  {c.title}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 全宽舞台：卡片在整屏范围移动 */}
        <div className="relative mt-8">
          <div
            ref={stageSize.register}
            className="relative left-1/2 h-[72vh] w-screen -translate-x-1/2 overflow-hidden bg-[radial-gradient(ellipse_70%_55%_at_50%_40%,rgba(124,111,154,0.12),transparent_62%)]"
          >
            <div style={{ opacity: glow }} className="pointer-events-none absolute inset-0 z-0">
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_60%_at_60%_40%,rgba(124,111,154,0.18),transparent_70%)]" />
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_40%_55%_at_15%_60%,rgba(56,189,248,0.10),transparent_60%)]" />
            </div>

            {(() => {
              const stageW = stageSize.size.width;
              const stageH = stageSize.size.height;
              const stageCenterX = stageW * 0.5;
              const stageCenterY = stageH * 0.5;
              const cardsLayout = block.cards.map((card, index) => {
                const mid = (cardCount - 1) / 2;
                const rawBaseX = (cardOffsets[index] ?? (index - mid) * cardGap) + scrollShift;
                const laneSign = index % 2 === 0 ? -1 : 1;
                // 收紧中心阅读带：只有更接近舞台中心的卡片才被认为是“主阅读卡”。
                const centerDistance = stageW > 0 ? Math.abs(rawBaseX) / (stageW * 0.5) : 1;
                const focus = 1 - clamp(centerDistance, 0, 1);
                const orbit = Math.sin(stableProgress * Math.PI * 2 + index * 0.82);
                const laneArcY = laneSign * (1 - focus) * 48 + orbit * (8 + (index % 3) * 4);
                // 中央阅读区强锁定：焦点高时几乎不施加额外逃逸。
                const centerLock = focus > 0.58 ? 0 : 1;
                const edgeFactor = Math.pow(1 - focus, 1.7) * centerLock;
                // 边缘增强：不只左右离场，而是斜向/上下也参与。
                const escapeXSign = block.direction === "right" ? (index % 3 === 0 ? 1 : -1) : (index % 3 === 0 ? -1 : 1);
                const escapeX = escapeXSign * edgeFactor * (74 + (index % 4) * 30);
                const escapeY = ((index % 5) - 2) * edgeFactor * 30 + laneSign * edgeFactor * 42;
                // 非主阅读卡增加“快速离场”推进，减少在中心附近滞留导致的遮挡。
                const awaySign = Math.sign(rawBaseX || (index % 2 === 0 ? -1 : 1));
                const bypassX = awaySign * Math.pow(1 - focus, 1.15) * (96 + (index % 3) * 22);
                const baseX = rawBaseX + escapeX + bypassX;
                const baseY = (cardYs[index] ?? 0) + laneArcY + escapeY;
                const drag = dragOffsets[card.id] ?? { x: 0, y: 0 };
                const sizeVariant: "sm" | "md" | "lg" = cardSizeVariants[index] ?? "sm";
                const width = cardWidthPx(sizeVariant);
                const approxHeight = sizeVariant === "lg" ? 300 : sizeVariant === "md" ? 276 : 252;
                const baseArea = Math.max(1, width * approxHeight);
                const stageArea = Math.max(1, stageW * stageH);
                // 主要阅读卡在中心时目标占据舞台约 35% 面积。
                const centerTargetScale = clamp(Math.sqrt((stageArea * 0.35) / baseArea), 1, 2.05);
                const visualScale = 0.62 + focus * (centerTargetScale - 0.62);
                const visualRotate = 0;
                // 边缘卡更快淡出，中心卡保持最高可读性。
                const visualOpacity = 0.24 + Math.pow(focus, 1.25) * 0.76;
                const centerX = stageCenterX + baseX + drag.x;
                const centerY = stageCenterY + baseY + drag.y;
                const anchorX = stageCenterX + baseX;
                const anchorY = stageCenterY + baseY;
                return { card, index, baseX, baseY, drag, sizeVariant, width, centerX, centerY, anchorX, anchorY, focus, visualScale, visualRotate, visualOpacity };
              });
              const peakFocus = cardsLayout.reduce((max, item) => Math.max(max, item.focus), 0);
              // 没有主阅读卡时，收起连线，避免舞台中部出现“悬空横线”。
              const showConnectors = peakFocus > 0.12;
              const rawBranchLayouts = cardsLayout.flatMap((parent) => {
                const branches = parent.card.branches ?? [];
                const defaultSide = parent.index % 2 === 0 ? "right" : "left";
                const parentHalfW = parent.width * 0.5;
                const parentHalfH = parent.sizeVariant === "lg" ? 150 : parent.sizeVariant === "md" ? 138 : 126;
                return branches.map((branch, branchIndex) => {
                  const anchorSide: "left" | "right" = branch.side ?? defaultSide;
                  const dir = anchorSide === "right" ? 1 : -1;
                  const spreadX = parent.sizeVariant === "lg" ? 168 : parent.sizeVariant === "md" ? 154 : 142;
                  const orbitX = parentHalfW + spreadX + Math.floor(branchIndex / 2) * 36;
                  const fan = branchIndex % 2 === 0 ? -1 : 1;
                  let orbitY = fan * (94 + Math.floor(branchIndex / 2) * 42);
                  const key = `${parent.card.id}::${branch.id}`;
                  const drag = branchDragOffsets[key] ?? { x: 0, y: 0 };
                  const branchW = 132;
                  const branchH = 58;
                  const safeY = parentHalfH + branchH * 0.72 + 28;
                  if (Math.abs(orbitY) < safeY) {
                    orbitY = (orbitY >= 0 ? 1 : -1) * safeY;
                  }
                  // 分支基座跟随滚动轨道，但不跟随大卡拖拽偏移，避免“拖大卡带着小卡跑”。
                  const baseX = parent.anchorX + dir * orbitX;
                  const baseY = parent.anchorY + orbitY;
                  return {
                    key,
                    parentCardId: parent.card.id,
                    branch,
                    anchorSide,
                    drag,
                    branchW,
                    branchH,
                    baseX,
                    baseY,
                  };
                });
              });
              // 位置打磨：边界钳制 + 简单防重叠，保证初始布局更稳定。
              const branchLayouts = (() => {
                const parentById = new Map(
                  cardsLayout.map((item) => [
                    item.card.id,
                    {
                      centerX: item.centerX,
                      centerY: item.centerY,
                      halfW: item.width * 0.5,
                      halfH: item.sizeVariant === "lg" ? 150 : item.sizeVariant === "md" ? 138 : 126,
                    },
                  ]),
                );
                const placed: Array<{
                  key: string;
                  parentCardId: string;
                  branch: NonNullable<LinkedCard["branches"]>[number];
                  anchorSide: "left" | "right";
                  drag: { x: number; y: number };
                  branchW: number;
                  branchH: number;
                  baseX: number;
                  baseY: number;
                }> = [];
                for (const node of rawBranchLayouts) {
                  let x = node.baseX;
                  let y = node.baseY;
                  const parent = parentById.get(node.parentCardId);
                  if (parent) {
                    const forbiddenHalfW = parent.halfW + node.branchW * 0.62 + 26;
                    const forbiddenHalfH = parent.halfH + node.branchH * 0.64 + 22;
                    const inForbidden = Math.abs(x - parent.centerX) < forbiddenHalfW && Math.abs(y - parent.centerY) < forbiddenHalfH;
                    if (inForbidden) {
                      const pushRight = x >= parent.centerX;
                      x = parent.centerX + (pushRight ? forbiddenHalfW : -forbiddenHalfW);
                      if (Math.abs(y - parent.centerY) < forbiddenHalfH * 0.7) {
                        y = parent.centerY + (y >= parent.centerY ? forbiddenHalfH : -forbiddenHalfH);
                      }
                    }
                  }
                  for (let i = 0; i < 6; i += 1) {
                    let nudged = false;
                    for (const other of placed) {
                      const dx = x - other.baseX;
                      const dy = y - other.baseY;
                      if (Math.abs(dx) < (node.branchW + other.branchW) * 0.45 && Math.abs(dy) < (node.branchH + other.branchH) * 0.5) {
                        y += dy >= 0 ? 18 : -18;
                        x += dx >= 0 ? 10 : -10;
                        nudged = true;
                      }
                    }
                    if (!nudged) break;
                  }
                  placed.push({ ...node, baseX: x, baseY: y });
                }
                return placed;
              })();
              const segments: ArrowSegment[] = [];
              for (let index = 0; index < cardsLayout.length; index += 1) {
                const from = cardsLayout[index]!;
                const toIndex = block.direction === "right" ? index + 1 : index - 1;
                const to = cardsLayout[toIndex];
                if (!to) continue;
                const fromRect = cardRects[from.card.id];
                const toRect = cardRects[to.card.id];
                const startX = fromRect
                  ? block.direction === "right"
                    ? fromRect.right
                    : fromRect.left
                  : block.direction === "right"
                    ? from.centerX + from.width / 2
                    : from.centerX - from.width / 2;
                const endX = toRect
                  ? block.direction === "right"
                    ? toRect.left
                    : toRect.right
                  : block.direction === "right"
                    ? to.centerX - to.width / 2
                    : to.centerX + to.width / 2;
                const edgeGap = Math.abs(endX - startX);
                if (edgeGap < 8) continue;
                segments.push({
                  id: `${from.card.id}->${to.card.id}`,
                  startX,
                  startY: fromRect?.centerY ?? from.centerY,
                  endX,
                  endY: toRect?.centerY ?? to.centerY,
                  sourceId: from.card.id,
                  targetId: to.card.id,
                });
              }
              const branchSegments: ArrowSegment[] = [];
              for (const branchNode of branchLayouts) {
                const parentRect = cardRects[branchNode.parentCardId];
                const branchRect = branchRects[branchNode.key];
                const currentBranchX = branchNode.baseX + branchNode.drag.x;
                const currentBranchY = branchNode.baseY + branchNode.drag.y;
                const parentCenterX = parentRect?.centerX ?? currentBranchX;
                const parentCenterY = parentRect?.centerY ?? currentBranchY;
                const isBranchRight = branchNode.anchorSide === "right";
                // 锁定默认方向和锚点侧，避免拖拽穿越中心时箭头起止点反跳。
                const nodeDirection = branchNode.branch.direction ?? (isBranchRight ? "outbound" : "inbound");
                const parentPoint = parentRect
                  ? edgePointToward(parentRect, currentBranchX, currentBranchY)
                  : { x: parentCenterX + (isBranchRight ? 120 : -120), y: parentCenterY };
                const branchPoint = branchRect
                  ? edgePointToward(branchRect, parentCenterX, parentCenterY)
                  : { x: currentBranchX + (isBranchRight ? -56 : 56), y: currentBranchY };
                if (Math.abs(branchPoint.x - parentPoint.x) < 6 && Math.abs(branchPoint.y - parentPoint.y) < 6) continue;
                if (nodeDirection === "inbound") {
                  branchSegments.push({
                    id: `${branchNode.key}::in`,
                    startX: branchPoint.x,
                    startY: branchPoint.y,
                    endX: parentPoint.x,
                    endY: parentPoint.y,
                    sourceId: branchNode.key,
                    targetId: branchNode.parentCardId,
                  });
                } else {
                  branchSegments.push({
                    id: `${branchNode.key}::out`,
                    startX: parentPoint.x,
                    startY: parentPoint.y,
                    endX: branchPoint.x,
                    endY: branchPoint.y,
                    sourceId: branchNode.parentCardId,
                    targetId: branchNode.key,
                  });
                }
              }
              return (
                <>
                  <ArrowOverlay
                    blockId={block.id}
                    segments={showConnectors ? segments : []}
                    direction={block.direction}
                    width={stageW}
                    height={stageH}
                    activeNodeId={activeDragNodeId}
                    interactionLevel={interactionLevel}
                    scrollProgress={stableProgress}
                  />
                  <BranchArrowOverlay
                    blockId={block.id}
                    segments={showConnectors ? branchSegments : []}
                    width={stageW}
                    height={stageH}
                    activeNodeId={activeDragNodeId}
                    interactionLevel={interactionLevel}
                    scrollProgress={stableProgress}
                  />
                  <div className="absolute inset-0 z-20">
                    {cardsLayout.map((item) => (
                      <LinkedCardView
                        key={item.card.id}
                        index={item.index}
                        card={item.card}
                        sizeVariant={item.sizeVariant}
                        cardRef={(node) => {
                          cardNodeRefs.current[item.card.id] = node;
                        }}
                        style={{
                          zIndex:
                            activeDragNodeId === item.card.id
                              ? 90
                              : 16 +
                                Math.round(item.focus * 18) +
                                (peakFocus - item.focus < 0.18 ? 18 : 0),
                          left: `calc(50% + ${item.baseX}px)`,
                          top: `calc(50% + ${item.baseY}px)`,
                          opacity: item.visualOpacity,
                          scale: item.visualScale,
                          rotate: item.visualRotate,
                        }}
                        dragBounds={{
                          // 允许拖到视口外一部分（大约 42% 卡宽 + 一点上下余量）
                          left: -(item.width * 0.42),
                          right: item.width * 0.42,
                          top: -180,
                          bottom: 180,
                        }}
                        dragOffset={item.drag}
                        onDragStart={() => {
                          if (!activeDragNodeId) {
                            lockedProgressRef.current = progress;
                          }
                          dragStartOffsetsRef.current[item.card.id] = dragOffsets[item.card.id] ?? { x: 0, y: 0 };
                          setActiveDragNodeId(item.card.id);
                        }}
                        onDrag={(delta) => {
                          const base = dragStartOffsetsRef.current[item.card.id] ?? { x: 0, y: 0 };
                          const next = { x: base.x + delta.x, y: base.y + delta.y };
                          setDragOffsets((prev) => {
                            const current = prev[item.card.id];
                            if (current && current.x === next.x && current.y === next.y) return prev;
                            return { ...prev, [item.card.id]: next };
                          });
                        }}
                        onDragEnd={(delta) => {
                          setActiveDragNodeId((current) => (current === item.card.id ? null : current));
                          const base = dragStartOffsetsRef.current[item.card.id] ?? { x: 0, y: 0 };
                          setDragOffsets((prev) => ({
                            ...prev,
                            [item.card.id]: { x: base.x + delta.x, y: base.y + delta.y },
                          }));
                        }}
                      />
                    ))}
                    {branchLayouts.map((branchNode) => (
                      <BranchCardView
                        key={branchNode.key}
                        label={branchNode.branch.label}
                        hint={branchNode.branch.hint}
                        nodeRef={(node) => {
                          branchNodeRefs.current[branchNode.key] = node;
                        }}
                        style={{
                          zIndex: activeDragNodeId === branchNode.key ? 65 : 35,
                          left: `calc(50% + ${branchNode.baseX - stageCenterX}px)`,
                          top: `calc(50% + ${branchNode.baseY - stageCenterY}px)`,
                        }}
                        dragBounds={{
                          // 放开到舞台级范围，避免“像有隐形边框”的拖拽体验。
                          left: -stageW,
                          right: stageW,
                          top: -stageH,
                          bottom: stageH,
                        }}
                        dragOffset={branchNode.drag}
                        onDragStart={() => {
                          if (!activeDragNodeId) {
                            lockedProgressRef.current = progress;
                          }
                          branchDragStartOffsetsRef.current[branchNode.key] = branchDragOffsets[branchNode.key] ?? { x: 0, y: 0 };
                          setActiveDragNodeId(branchNode.key);
                        }}
                        onDrag={(delta) => {
                          const base = branchDragStartOffsetsRef.current[branchNode.key] ?? { x: 0, y: 0 };
                          const next = { x: base.x + delta.x, y: base.y + delta.y };
                          setBranchDragOffsets((prev) => {
                            const current = prev[branchNode.key];
                            if (current && current.x === next.x && current.y === next.y) return prev;
                            return { ...prev, [branchNode.key]: next };
                          });
                        }}
                        onDragEnd={(delta) => {
                          setActiveDragNodeId((current) => (current === branchNode.key ? null : current));
                          const base = branchDragStartOffsetsRef.current[branchNode.key] ?? { x: 0, y: 0 };
                          setBranchDragOffsets((prev) => ({
                            ...prev,
                            [branchNode.key]: { x: base.x + delta.x, y: base.y + delta.y },
                          }));
                        }}
                      />
                    ))}
                  </div>
                </>
              );
            })()}

            {/* 边缘遮罩：保留“从边缘拉出来”的质感 */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-20 bg-gradient-to-b from-[var(--page-bg)] via-[var(--page-bg)]/60 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[min(12vw,7rem)] bg-gradient-to-r from-[var(--page-bg)] via-[var(--page-bg)]/55 to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-[min(12vw,7rem)] bg-gradient-to-l from-[var(--page-bg)] via-[var(--page-bg)]/55 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-44 bg-gradient-to-t from-[var(--page-bg)] via-[var(--page-bg)]/55 to-transparent" />
          </div>
        </div>
      </div>
    </section>
  );
}

