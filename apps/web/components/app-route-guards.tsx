"use client";

/** Anonymous mode: legacy wrappers now pass through without auth redirects. */
export function RequireAdminLogin({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Anonymous mode: legacy wrappers now pass through without auth redirects. */
export function RedirectGuestsToRealtime({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
