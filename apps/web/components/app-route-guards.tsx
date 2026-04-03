"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ApiError, api } from "@/lib/api";

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** 未登录时重定向到 /login，用于设置等仅管理员页面 */
export function RequireAdminLogin({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const auth = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (auth.isFetched && auth.isError && isUnauthorized(auth.error)) {
      router.replace("/login");
    }
  }, [auth.isFetched, auth.isError, auth.error, router]);

  if (auth.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-4 text-sm text-theme-4">
        正在验证管理员身份…
      </div>
    );
  }

  if (auth.isError && isUnauthorized(auth.error)) {
    return null;
  }

  if (auth.isError) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="max-w-md text-sm text-red-400 theme-light:text-red-700">{(auth.error as Error).message}</p>
      </div>
    );
  }

  return <>{children}</>;
}

/** 未登录（访客）时重定向到实时工作台，用于样本对照 / 实验报告等 */
export function RedirectGuestsToRealtime({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const auth = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (auth.isFetched && auth.isError && isUnauthorized(auth.error)) {
      router.replace("/app/realtime");
    }
  }, [auth.isFetched, auth.isError, auth.error, router]);

  if (auth.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-4 text-sm text-theme-4">
        正在验证访问权限…
      </div>
    );
  }

  if (auth.isError && isUnauthorized(auth.error)) {
    return null;
  }

  if (auth.isError) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="max-w-md text-sm text-red-400 theme-light:text-red-700">{(auth.error as Error).message}</p>
      </div>
    );
  }

  return <>{children}</>;
}
