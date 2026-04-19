"use client";

import * as Popover from "@radix-ui/react-popover";
import { useCallback, useId, useState } from "react";

/** 使用 Canvas 规范化颜色字符串；无效时返回 null */
function tryParseCssColor(input: string): string | null {
  const s = input.trim();
  if (!s || typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = s;
  const out = ctx.fillStyle;
  return typeof out === "string" && out.length ? out : null;
}

function rgbLikeToHex6(rgb: string): string {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return "#111827";
  const toH = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${toH(Number(m[1]))}${toH(Number(m[2]))}${toH(Number(m[3]))}`;
}

function toColorInputHex(value: string): string {
  const s = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  const parsed = tryParseCssColor(s);
  if (!parsed) return "#111827";
  if (/^#[0-9a-f]{6}$/i.test(parsed)) return parsed.toLowerCase();
  return rgbLikeToHex6(parsed);
}

export type AnnotationColorPopoverProps = {
  swatches: readonly string[];
  value: string;
  onChange: (next: string) => void;
};

export function AnnotationColorPopover({ swatches, value, onChange }: AnnotationColorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const lid = useId();

  const applyDraft = useCallback(() => {
    const parsed = tryParseCssColor(draft);
    if (parsed) onChange(parsed);
  }, [draft, onChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) setDraft(value);
    },
    [value],
  );

  const hexPick = toColorInputHex(value);

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm p-0 outline-none ring-offset-2 hover:bg-surface-muted/30 focus-visible:ring-2 focus-visible:ring-[color:var(--ring-focus)]"
          aria-label="调色"
        >
          <span
            className="h-3.5 w-3.5 rounded-[3px] border border-theme-default/70"
            style={{ background: value }}
            aria-hidden
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className="z-[24001] w-[200px] rounded-lg border border-theme-default bg-surface-2 p-2 shadow-xl outline-none"
        >
          <div className="grid grid-cols-8 gap-0.5">
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className={`h-4 w-4 rounded border ${
                  value === c ? "border-theme-strong ring-1 ring-[color:var(--accent)]/35" : "border-theme-default"
                }`}
                style={{ background: c }}
                title={c}
                aria-label={`颜色 ${c}`}
                onClick={() => {
                  onChange(c);
                  setDraft(c);
                }}
              />
            ))}
          </div>

          <input
            id={`${lid}-pick`}
            type="color"
            value={hexPick}
            className="mt-2 h-7 w-full min-w-0 cursor-pointer rounded border border-theme-default bg-surface-1 p-px"
            aria-label="拾色器"
            onChange={(e) => {
              onChange(e.target.value);
              setDraft(e.target.value);
            }}
          />

          <input
            id={`${lid}-text`}
            value={draft}
            className="mt-1.5 h-7 w-full rounded border border-theme-default bg-surface-1 px-2 text-[11px] text-theme-1 outline-none focus-visible:border-theme-strong"
            spellCheck={false}
            autoComplete="off"
            aria-label="颜色值"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={applyDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyDraft();
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
