"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useState } from "react";

import { Button, Card, Input } from "@stream2graph/ui";

import { markAuthPending } from "@/lib/auth-session";
import { api } from "@/lib/api";

const schema = z.object({
  username: z.string().min(1, "请输入管理员账号"),
  password: z.string().min(1, "请输入密码"),
});

type FormValues = z.infer<typeof schema>;

export function LoginForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: () => {
      markAuthPending();
      queryClient.removeQueries({ queryKey: ["auth", "me"], exact: true });
      router.replace("/app/realtime");
    },
  });

  return (
    <Card
      variant="dark"
      className="mx-auto w-full max-w-[460px] border border-theme-default p-6 shadow-[0_20px_50px_rgba(0,0,0,0.45)] md:p-8"
    >
      <div className="mb-8">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-theme-4">管理员登录</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-theme-1">进入正式研究平台</h1>
        <p className="mt-2 text-sm leading-snug text-theme-4">
          管理实时实验、样本对照、研究与报告导出。
        </p>
      </div>

      <form
        className="space-y-4"
        method="post"
        autoComplete="off"
        onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium text-theme-3">管理员账号</label>
          <Input variant="dark" autoComplete="username" {...form.register("username")} />
          {form.formState.errors.username ? (
            <p className="text-xs text-red-400">{form.formState.errors.username.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-theme-3">密码</label>
          <div className="relative">
            <Input
              variant="dark"
              type={passwordVisible ? "text" : "password"}
              autoComplete="current-password"
              className="pr-11"
              {...form.register("password")}
            />
            <button
              type="button"
              aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
              className="absolute right-2 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-theme-subtle bg-surface-muted text-theme-2 transition hover:border-theme-default hover:bg-surface-muted hover:text-theme-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-focus"
              onClick={() => setPasswordVisible((v) => !v)}
            >
              {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {form.formState.errors.password ? (
            <p className="text-xs text-red-400">{form.formState.errors.password.message}</p>
          ) : null}
        </div>

        {mutation.isError ? (
          <div className="rounded-xl border border-red-900/55 bg-red-950/45 px-4 py-3 text-sm leading-relaxed text-red-200">
            {(mutation.error as Error).message}
          </div>
        ) : null}

        <Button type="submit" className="w-full justify-center" disabled={mutation.isPending}>
          {mutation.isPending ? "登录中…" : "登录并进入"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Button>
      </form>

      <div className="mt-6 border-t border-theme-subtle pt-5">
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-center text-theme-3 hover:text-theme-2"
          onClick={() => router.replace("/app/realtime")}
        >
          跳过登录，先试用
        </Button>
        <p className="mt-3 text-center text-[11px] leading-snug text-theme-4">
          跳过登录可体验实时工作台；样本对照、实验报告与平台设置需管理员账号。
        </p>
      </div>
    </Card>
  );
}
