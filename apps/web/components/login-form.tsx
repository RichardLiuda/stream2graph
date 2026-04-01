"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: async () => {
      markAuthPending();
      queryClient.removeQueries({ queryKey: ["auth", "me"], exact: true });
      router.replace("/app/realtime");
    },
  });

  return (
    <Card variant="light" className="mx-auto w-full max-w-[460px] p-6 md:p-8">
      <div className="mb-8">
        <div className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent-strong)]">
          管理员登录
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">进入正式研究平台</h1>
        <p className="mt-2 text-sm leading-snug text-slate-600">管理实时实验、样本对照、研究与报告导出。</p>
      </div>

      <form
        className="space-y-4"
        method="post"
        autoComplete="on"
        onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">管理员账号</label>
          <Input variant="light" autoComplete="username" {...form.register("username")} />
          {form.formState.errors.username ? (
            <p className="text-xs text-red-600">{form.formState.errors.username.message}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">密码</label>
          <Input variant="light" type="password" autoComplete="current-password" {...form.register("password")} />
          {form.formState.errors.password ? (
            <p className="text-xs text-red-600">{form.formState.errors.password.message}</p>
          ) : null}
        </div>

        {mutation.isError ? (
          <div className="rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {(mutation.error as Error).message}
          </div>
        ) : null}

        <Button type="submit" className="w-full justify-center" disabled={mutation.isPending}>
          {mutation.isPending ? "登录中..." : "进入工作台"}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </form>
    </Card>
  );
}
