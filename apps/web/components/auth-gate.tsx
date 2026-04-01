"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError, api } from "@/lib/api";
import { clearAuthPending, getAuthPendingAgeMs, hasRecentAuthPending } from "@/lib/auth-session";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [retryCount, setRetryCount] = useState(0);
  const query = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.me,
    retry: false,
    refetchOnMount: "always",
  });

  const isUnauthorized = query.error instanceof ApiError && query.error.status === 401;
  const authPending = hasRecentAuthPending();
  const shouldHoldRedirect = isUnauthorized && authPending;

  useEffect(() => {
    if (query.isSuccess) {
      clearAuthPending();
      setRetryCount(0);
    }
  }, [query.isSuccess]);

  useEffect(() => {
    if (!shouldHoldRedirect) return;
    const ageMs = getAuthPendingAgeMs();
    if (ageMs === null || retryCount >= 6) {
      clearAuthPending();
      return;
    }
    const timeout = window.setTimeout(() => {
      setRetryCount((current) => current + 1);
      void query.refetch();
    }, 450 + retryCount * 250);
    return () => window.clearTimeout(timeout);
  }, [query, retryCount, shouldHoldRedirect]);

  useEffect(() => {
    if (shouldHoldRedirect) return;
    if (isUnauthorized && pathname !== "/login") {
      clearAuthPending();
      router.replace("/login");
    }
  }, [isUnauthorized, pathname, router, shouldHoldRedirect]);

  if (query.isLoading || shouldHoldRedirect) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-theme-4">
        {shouldHoldRedirect ? "正在建立管理员登录态..." : "正在验证管理员身份..."}
      </div>
    );
  }

  if (isUnauthorized) {
    return null;
  }

  if (query.isError) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-4">
        <div className="max-w-md rounded-[28px] border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-800">
          平台暂时无法确认登录状态。请刷新页面后重试；如果仍然失败，请检查 API 服务是否正常运行。
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
