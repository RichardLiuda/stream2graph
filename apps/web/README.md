# Stream2Graph Web

`apps/web` 是 Stream2Graph 正式平台的前端应用，基于 Next.js App Router、React 19、Tailwind CSS、Framer Motion、Mermaid 和共享 UI 包构建。

## 职责

- 首页与产品介绍
- 登录页
- 实时工作台：文本/语音输入、实时成图、结构视图、时间线、批注、回退、报告导出
- 样本对照页：数据集、样本、运行任务入口
- 报告中心：查看与下载实验报告
- 设置页：管理运行时模型、STT、声纹等配置
- 用户研究页：`/study/[participantCode]`

## 目录结构

```text
apps/web/
  app/                  Next.js App Router 页面与全局样式
  components/           页面组件和交互组件
  lib/                  API 客户端、音频输入、辅助工具
  next.config.ts        Next.js 配置与 API rewrite
  tailwind.config.ts    Tailwind 配置
  package.json          前端依赖与脚本
```

主要页面：

```text
app/page.tsx                         首页
app/login/page.tsx                   登录
app/app/realtime/page.tsx            实时工作台
app/app/samples/page.tsx             样本对照
app/app/reports/page.tsx             报告中心
app/app/settings/page.tsx            设置
app/study/[participantCode]/page.tsx 用户研究
```

## 运行

从仓库根目录启动：

```bash
pnpm dev:web
```

或在前端目录启动：

```bash
pnpm --dir apps/web dev
```

默认地址：

```text
http://127.0.0.1:3000
```

如果端口被占用，可临时指定：

```bash
pnpm --dir apps/web exec next dev --hostname 0.0.0.0 --port 3001
```

## 常用命令

```bash
pnpm --dir apps/web dev
pnpm --dir apps/web build
pnpm --dir apps/web start
pnpm --dir apps/web lint
pnpm --dir apps/web typecheck
```

根目录别名：

```bash
pnpm dev:web
pnpm build:web
pnpm lint:web
pnpm typecheck:web
```

## 后端连接

前端默认通过 Next.js 同源 rewrite 调用 API：

```text
/api/health       -> http://127.0.0.1:8000/api/health
/api/v1/:path*    -> http://127.0.0.1:8000/api/v1/:path*
```

相关配置在 `next.config.ts`：

- `API_PROXY_TARGET`
- `NEXT_PUBLIC_API_PROXY_TARGET`
- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_API_BROWSER_PROXY`

默认建议保持同源代理开启。这样局域网访问时，浏览器只访问前端地址，减少跨域和 Cookie 问题。

关闭同源代理：

```env
NEXT_PUBLIC_API_BROWSER_PROXY=0
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000
```

## 音频辅助服务

系统音频相关能力依赖 `apps/audio-helper`：

```env
NEXT_PUBLIC_AUDIO_HELPER_BASE_URL=http://127.0.0.1:8765
```

检查：

```text
http://127.0.0.1:8765/health
```

浏览器语音识别还依赖浏览器权限和浏览器自身能力；不可用时可改用 Transcript 文本输入。

## 关键模块

- `components/home-page.tsx`：首页
- `components/scroll-linked-cards.tsx`：首页滚动介绍卡片与连线
- `components/realtime-studio.tsx`：实时工作台主体
- `components/mermaid-card.tsx`：Mermaid 渲染与错误保留
- `components/graph-stage.tsx`：结构图舞台
- `components/annotation-layer.tsx`：批注层
- `components/platform-settings.tsx`：运行时配置管理
- `lib/api.ts`：API 客户端与响应校验
- `lib/audio-input.ts`：浏览器输入来源配置
- `lib/audio-helper.ts`：本地音频辅助服务客户端

## 开发约定

- 优先使用 `packages/contracts` 中的 schema 校验 API 响应
- 页面级体验改动需要在至少一个桌面尺寸和一个窄屏尺寸下检查
- 复杂交互组件尽量保持状态边界清晰，不把会话状态写进全局缓存，除非明确需要跨会话保留
- Mermaid 内容渲染失败时，应保留最近一次可用图，避免实时工作台空白闪烁
- 视觉主色和基础组件尽量复用 `app/globals.css` 与 `packages/ui`

## 排错

页面提示 API request failed：

- 检查 API 是否启动：`http://127.0.0.1:8000/api/health`
- 检查 Next rewrite 目标是否正确：`API_PROXY_TARGET`
- 检查登录状态和 Cookie

页面端口不是 3000：

- API CORS 可能需要加入新端口
- 或保持同源代理，让浏览器只访问前端端口

类型错误：

```bash
pnpm --dir apps/web typecheck
```

构建错误：

```bash
pnpm --dir apps/web build
```
