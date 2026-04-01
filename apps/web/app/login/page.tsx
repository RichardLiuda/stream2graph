import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center bg-[var(--page-bg)] px-4 py-10">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,rgba(82,82,91,0.2),transparent_60%)]"
        aria-hidden
      />
      <div className="relative w-full max-w-[480px]">
        <LoginForm />
      </div>
    </main>
  );
}
