import { AdminShell } from "@/components/admin-shell";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminShell>{children}</AdminShell>
  );
}
