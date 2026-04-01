import { Card } from "./card";

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="p-4 md:p-5">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-zinc-100">{value}</div>
      {hint ? <div className="mt-1.5 text-[11px] leading-snug text-zinc-500">{hint}</div> : null}
    </Card>
  );
}
