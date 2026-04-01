import type { ReactNode } from "react";

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  tone = "default",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** @description 深色通栏背景上的标题对比度 */
  tone?: "default" | "onDark";
}) {
  const eyebrowCls =
    tone === "onDark"
      ? "text-indigo-300/90"
      : "text-[var(--accent-strong)]";
  const titleCls = "text-theme-1";
  const descCls = tone === "onDark" ? "text-theme-3" : "text-theme-5";

  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div className="max-w-3xl">
        {eyebrow ? (
          <div className={`mb-3 text-xs font-semibold uppercase tracking-[0.28em] ${eyebrowCls}`}>
            {eyebrow}
          </div>
        ) : null}
        <h2 className={`text-[2rem] font-semibold tracking-[-0.04em] ${titleCls}`}>{title}</h2>
        {description ? <p className={`mt-3 max-w-2xl text-sm leading-7 ${descCls}`}>{description}</p> : null}
      </div>
      {actions ? <div className="md:pb-1">{actions}</div> : null}
    </div>
  );
}
