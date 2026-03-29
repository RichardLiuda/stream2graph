# Cursor Skills（本项目）

## 已安装

| 目录 | 说明 |
|------|------|
| `frontend-design/` | 前端界面与视觉实现：避免「AI 通用审美」，强调明确风格与细节。 |

Cursor 会扫描 `.cursor/skills/<name>/SKILL.md`（需含 YAML 里的 `name` 与 `description`）。

## 怎么用

1. **自动**：在 **Agent** 里提需求时，若任务与 `description` 里写的场景匹配（例如「做个落地页」「改组件样式」），模型可能会 **读取** 对应 `SKILL.md` 并按其中指引执行。
2. **手动**：在对话里明确说，例如：「按 `.cursor/skills/frontend-design/SKILL.md` 的风格做」或「用 frontend-design skill」。
3. **写进规则（可选）**：在 Cursor **Settings → Rules** 或项目 `AGENTS.md` / `.cursor/rules` 里加一句：做 UI/前端时优先遵循 `frontend-design` skill，触发会更稳定。

## 与根目录 `skills/` 的关系

根目录 `skills/` 可作为副本或上游来源；**Cursor 实际加载的是本目录** `.cursor/skills/` 下的 `SKILL.md`。
