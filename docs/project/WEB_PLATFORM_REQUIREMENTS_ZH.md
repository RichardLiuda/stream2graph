## 1. 文档目标

这份文档面向负责实现正式网页系统的前后端同学，目标是把当前仓库里已经存在的数据、算法、评测和原型服务，落成一个真正可用于：

- 用户研究
- 项目展示
- 模型对比实验
- 实时演示
- 报告保存与复现

的新平台。

它不是在要求重写算法，而是在要求把现有研究能力包装成一个可维护、可记录、可演示、可实验的正式系统。

## 2. 产品定位

新系统应同时承担三种角色：

- 面向外部介绍项目的展示平台
- 面向内部实验和评测的工作台
- 面向参与者执行任务的用户研究平台

因此它不能只是：

- 一个静态介绍页
- 一个只会输出 Mermaid 的小工具
- 一个没有日志、没有实验记录、没有任务管理的 demo

## 3. 前端要求

### 3.1 前端整体职责

前端需要承担以下职责：

- 展示项目背景和方法
- 提供实时成图操作入口
- 提供静态样本浏览与结果对比入口
- 提供用户研究任务界面
- 提供实验结果与报告查看界面

### 3.2 必须具备的页面

#### A. 项目首页 / 项目说明页

需要支持：

- 项目简介
- 任务定义
- 方法流程概述
- 数据集版本说明
- 进入不同功能区的导航入口

#### B. 实时成图工作台

至少应包含：

- transcript 输入区
- 麦克风输入区
- 图实时显示区
- 会话状态区
- 意图与事件流区
- 实时指标区
- 会话控制区

至少应支持：

- 创建会话
- 发送 transcript chunk
- flush
- snapshot
- close
- 查看当前 session summary
- 查看实时评测结果

#### C. 静态样本浏览与对比页

至少应支持：

- 选择数据集版本
- 选择 split
- 选择 sample
- 展示参考对话
- 展示参考 Mermaid
- 展示预测 Mermaid
- 展示编译结果与离线指标
- 支持多模型并排对比

#### D. 用户研究任务页

这是正式网页系统必须重点支持的页面。至少应支持：

- 参与者按编号进入
- 任务说明展示
- 任务材料加载
- 系统生成结果展示
- 用户编辑最终 Mermaid
- 提交最终答案
- 自动记录时间和操作

#### E. 实验与报告页

至少应支持：

- 查看历史运行
- 查看模型评测结果
- 查看实时评测结果
- 查看用户研究记录
- 下载 JSON / CSV / Markdown 报告

### 3.3 前端交互要求

- 所有长任务都必须有状态提示
  - waiting / running / finished / failed
- 所有运行必须有唯一标识
  - `session_id` 或 `run_id`
- 所有错误都必须前端可见
  - API 错误
  - Mermaid 渲染错误
  - 任务执行错误
- 页面刷新后不能直接让用户丢失全部上下文

### 3.4 前端不应该承担的逻辑

前端不应该自己承担：

- 核心算法计算
- Mermaid 离线评分
- 模型推理编排
- 编译验证逻辑
- 实验结果落盘规范

这些应由后端和现有 Python 工具层完成。

## 4. 后端要求

### 4.1 后端整体职责

后端应作为以下三层的统一入口：

- Web API 层
- 算法编排层
- 结果与日志存储层

后端不要求一定使用 Python，也可以使用 Node.js 或其他框架，但必须能稳定调用现有 Python 算法层与评测脚本。

### 4.2 后端必须提供的核心能力

#### A. 会话管理 API

至少提供：

- 创建 session
- 接收 transcript chunk
- flush session
- snapshot session
- close session
- 查询活跃 session

#### B. 数据集与样本查询 API

至少提供：

- 查询数据集版本
- 查询 split
- 查询 sample 列表
- 查询单条 sample 内容
- 查询 sample 的元数据和参考 Mermaid

#### C. 模型运行 API

至少提供：

- 运行传统基线
- 运行 API 模型
- 运行本地模型
- 运行离线 benchmark
- 保存预测结果与配置快照

#### D. 评测与报告 API

至少提供：

- 运行离线指标
- 运行 Mermaid 编译验证
- 运行实时指标
- 生成报告
- 查询历史报告

#### E. 用户研究 API

至少提供：

- 创建研究 session
- 记录 participant 信息
- 记录 task 信息
- 记录交互事件
- 保存最终提交
- 保存问卷结果

### 4.3 后端数据持久化要求

后端必须保证这些内容可以持久化，而不是只放在内存里：

- session 状态
- transcript 输入
- 模型输出
- 实验配置
- 评测结果
- 用户研究日志
- 问卷数据

### 4.4 后端不应该做的事

- 不应只依赖前端本地状态保存实验
- 不应让任务中断后无法恢复
- 不应让配置和结果脱节
- 不应把不同类型数据混在一个无结构目录里

## 5. 用户研究支持要求

### 5.1 研究模式

平台至少需要支持三种条件：

- `manual`
- `heuristic`
- `model_system`

后续如需要，可扩展为：

- `api_baseline`
- `fine_tuned_model`
- `hybrid_system`

### 5.2 必须记录的研究数据

每个研究 session 至少要记录：

- `participant_id`
- `study_condition`
- `task_id`
- `task_start_time`
- `task_end_time`
- `raw_interaction_log`
- `input_transcript`
- `system_output`
- `user_final_output`
- `compile_success`
- `auto_metrics`
- `survey_response`

### 5.3 导出要求

用户研究数据至少要支持：

- JSON 导出
- CSV 导出
- Markdown 或 HTML 摘要导出

## 6. 数据与实验管理要求

### 6.1 数据集版本可见性

前后端系统里必须显式展示：

- 当前使用的数据集版本
- 当前使用的 split
- 当前运行使用的模型或 provider
- 当前运行使用的评测配置

不能让研究参与者或实验操作者在不知情的情况下混用 `V4`、`V5`、`V6` 或不同 baseline。

### 6.2 实验可追溯性

每一次系统运行至少应保存：

- `run_id`
- `provider`
- `model_name`
- `dataset_version`
- `split`
- `timestamp`
- `config_snapshot`
- `outputs`
- `report_paths`

### 6.3 结果组织建议

建议至少逻辑区分：

- `system_runs`
- `study_sessions`
- `evaluation_reports`
- `dataset_browsing_cache`

## 7. 与现有能力的集成要求

新平台必须优先复用当前仓库里已经存在的核心能力：

- 原型服务层
  - [realtime_frontend_server.py](E:/Desktop/stream2graph/tools/realtime_frontend_server.py#L1)
- 实时 pipeline
  - [run_realtime_pipeline.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/run_realtime_pipeline.py#L62)
- 实时评测
  - [evaluate_realtime_pipeline.py](E:/Desktop/stream2graph/versions/v3_2026-02-27_latest_9k_cscw/scripts/evaluate_realtime_pipeline.py#L45)
- 统一评测平台
  - [run_eval_suite.py](E:/Desktop/stream2graph/tools/eval/run_eval_suite.py#L1)
- 数据集重生成平台
  - [run_suite.py](E:/Desktop/stream2graph/tools/dialogue_regen/run_suite.py#L1)

可以重构服务与界面，但不建议绕开这些能力各写一套新逻辑。

## 8. 非功能要求

### 8.1 可恢复性

- 长任务中断后可继续
- 页面刷新后能恢复关键状态
- 历史结果可回查

### 8.2 可复现性

- 每个实验必须保留配置快照
- 每个报告必须能追溯到输入、模型和版本

### 8.3 可扩展性

未来要能方便接入：

- 新 API baseline
- 本地微调模型
- 新数据集版本
- 新用户研究条件

### 8.4 稳定性

- 前端不应阻塞长任务
- 后端要能处理失败回执
- Mermaid 渲染失败要可见

## 9. 交付物要求

最终至少需要交付：

- 可运行的正式网页系统
- 环境启动说明
- API 说明
- 用户研究操作说明
- 报告导出说明

验收标准不是“页面是否漂亮”，而是：

- 是否真的能支撑研究展示
- 是否真的能支撑用户研究
- 是否真的能支撑评测和报告管理
- 是否真的能与当前算法层稳定集成

## 10. 开发优先级

建议按以下顺序实现：

1. 后端 API 正规化
2. 实时成图工作台
3. 样本浏览与对比页
4. 用户研究任务页
5. 实验与报告页

## 11. 一句话总结

这次要构建的不是一个更漂亮的 demo，而是一个真正能用于研究展示、用户研究和实验管理的正式前后端平台。
