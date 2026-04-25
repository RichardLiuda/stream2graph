# Stream2Graph -- Complete Project Documentation

> Version: 2026-04-05
> Audience: Project members, reviewers, and potential collaborators.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Problem Definition](#2-problem-definition)
3. [System Architecture](#3-system-architecture)
4. [Backend Features](#4-backend-features)
5. [Frontend Features](#5-frontend-features)
6. [Dataset Construction](#6-dataset-construction)
7. [Core Algorithms](#7-core-algorithms)
8. [Evaluation & Results](#8-evaluation--results)
9. [Innovation Analysis](#9-innovation-analysis)
10. [Practical & Commercial Value](#10-practical--commercial-value)
11. [Quick Start Guide](#11-quick-start-guide)
12. [Development Guide](#12-development-guide)

---

## 1 Project Overview

### 1.1 One-Liner

**Stream2Graph** is a research-grade interactive system that converts multi-turn collaborative dialogue into structured diagrams (Mermaid) in real time.

### 1.2 Positioning

This is not a simple "text-to-chart" tool. The core research question is:

> When multiple people discuss a system architecture or workflow through dialogue, how can a system determine **when** to update the diagram, **what** to update, and do so in a **stable, controllable** manner?

This involves three layers of problems:
- **Timing**: Is the current information sufficient to trigger a diagram update?
- **Content Planning**: What should the new diagram structure be?
- **Stability**: How to update without disrupting the user's established mental map?

### 1.3 Target Venue

ICMI 2026 (International Conference on Multimodal Interaction), framed as an "Interactive External Representation Building" task.

### 1.4 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12 + FastAPI + SQLAlchemy 2 + PostgreSQL 16 |
| Frontend | Next.js 15 + React 19 + TypeScript + TailwindCSS + XState |
| AI | Multi-model via a compatibility API / gateway: Kimi, Qwen, MiniMax, DeepSeek (depending on deployment config) |
| Database | PostgreSQL 16 + Alembic migrations |
| Deployment | Docker Compose (PostgreSQL) + native process management |
| Voice | iFlytek RTASR (streaming ASR) + iFlytek Voiceprint Recognition |
| Diagram Rendering | Mermaid 11.5.0 |

---

## 2 Problem Definition

### 2.1 Formal Definition

Given a multi-turn dialogue, the system observes dialogue turns sequentially and decides at each turn whether to trigger a diagram update:

- **WAIT**: Insufficient information, buffer more input
- **EMIT_UPDATE**: Information is sufficient, advance the diagram to the next stage
- **SWITCH_CANVAS**: Dialogue has shifted to a new topic, create a new canvas

Formally, let dialogue turns be `T = {t_1, t_2, ..., t_n}`, stages be `S = {s_1, s_2, ..., s_m}`. At turn `k`, seeing prefix `T_<=k`, the system decides whether to update based on current graph state `G_k`.

### 2.2 Comparison with Traditional Text-to-Diagram

| Dimension | Traditional | Stream2Graph |
|---|---|---|
| Input | Complete text at once | Streaming dialogue turns |
| Output | One-shot final diagram | Incremental updates |
| State Management | None (per-turn independent) | Persistent evolving graph state |
| Update Timing | N/A | Core decision |
| Stability | N/A | Key metric (flicker, mental map) |
| Evaluation | Final structure match only | Process metrics + final metrics |

---

## 3 System Architecture

### 3.1 Overall Architecture

```
  +------------------+     +------------------+     +------------------+
  |   Browser Frontend|     |   API Backend     |     |   External LLM    |
  |   (Next.js 15)    |<--->|   (FastAPI)       |<--->|   (OpenAI compat) |
  +------------------+     +------------------+     +------------------+
         |                          |                        |
         |                          v                        |
         |               +------------------+                |
         |               |   PostgreSQL 16  |                |
         |               |   (Docker)       |                |
         |               +------------------+                |
         |                                                   |
  +------------------+     +------------------+     +------------------+
  |   iFlytek RTASR  |     |   mmdc Compile   |     |   iFlytek Voice-  |
  |   (WebSocket)    |     |   Check (CLI)     |     |   print API       |
  +------------------+     +------------------+     +------------------+
```

### 3.2 Directory Structure

```
stream2graph/
  apps/
    api/                    # FastAPI backend
      app/
        main.py             # App entry, CORS, router mounting
        config.py           # Pydantic settings (env var parsing)
        models.py           # SQLAlchemy ORM models (16 tables)
        schemas.py          # Pydantic request/response models
        db.py               # Database engine & session
        security.py         # Password hashing, session encoding
        worker.py           # Standalone background worker
        routers/            # API routes
        services/           # Business logic
    web/                    # Next.js frontend
      app/                  # Page routes
      components/           # UI components
    audio-helper/           # System audio capture service
  tools/
    eval/                   # Evaluation framework
    mermaid_prompting.py    # Mermaid prompt builders
    incremental_dataset/    # Dataset rendering & management
  versions/                 # Dataset versions
  docs/                     # Project documentation
  reports/                  # Experiment report output
```

### 3.3 Database Models (16 Tables)

| Table | Purpose |
|---|---|
| `admin_users` | Admin authentication |
| `platform_settings` | Platform config (JSON KV store) |
| `dataset_versions` | Dataset version registry |
| `run_jobs` | Background job queue |
| `run_artifacts` | Job output artifacts |
| `realtime_sessions` | Realtime sessions (with pipeline state) |
| `realtime_chunks` | Transcript chunks per session |
| `realtime_events` | Pipeline update events |
| `realtime_snapshots` | Session history snapshots |
| `voiceprint_groups` | Voiceprint groups |
| `voiceprint_features` | Individual voiceprint features |
| `study_tasks` | Study task definitions |
| `study_sessions` | Participant study sessions |
| `study_events` | Study event log |
| `study_submissions` | Final submissions |
| `survey_responses` | Survey responses |

---

## 4 Backend Features

### 4.1 API Routes Overview

All prefixed under `/api/v1`:

#### Authentication `/auth`

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Admin login (cookie-based session) |
| POST | `/auth/logout` | Logout |
| GET | `/auth/me` | Get current admin identity |

#### Catalog `/catalog`

| Method | Path | Description |
|---|---|---|
| GET | `/catalog/runtime-options` | Get Gate/Planner/STT profiles |
| PUT | `/catalog/runtime-options/admin` | Save runtime config |
| POST | `/catalog/runtime-options/admin/probe-models` | Probe available models |
| POST | `/catalog/runtime-options/admin/test-connection` | Test provider connection |
| GET | `/catalog/datasets` | List dataset versions |
| GET | `/catalog/datasets/{slug}/samples` | Paginated sample list |
| GET | `/catalog/datasets/{slug}/samples/{sample_id}` | Sample detail |

#### Realtime `/realtime`

| Method | Path | Description |
|---|---|---|
| GET | `/realtime/sessions` | List sessions |
| POST | `/realtime/sessions` | Create session |
| POST | `/realtime/sessions/{id}/chunks` | Add transcript chunk |
| POST | `/realtime/sessions/{id}/chunks/batch` | Batch add chunks |
| POST | `/realtime/sessions/{id}/audio/transcriptions` | Audio transcription |
| POST | `/realtime/sessions/{id}/snapshot` | Force snapshot rebuild |
| POST | `/realtime/sessions/{id}/flush` | Flush buffer & process |
| POST | `/realtime/sessions/{id}/diagram-relayout` | Node drag relayout |
| POST | `/realtime/sessions/{id}/close` | Close session |
| GET | `/realtime/sessions/{id}/transcript/download` | Download transcript |
| POST | `/realtime/sessions/detect-diagram-type` | Auto-detect diagram type |

#### Voiceprints `/voiceprints`

| Method | Path | Description |
|---|---|---|
| GET | `/voiceprints/stt-profiles/{id}/features` | List voiceprint features |
| POST | `/voiceprints/stt-profiles/{id}/features` | Register voiceprint |
| DELETE | `/voiceprints/stt-profiles/{id}/features/{id}` | Delete voiceprint |
| POST | `/voiceprints/stt-profiles/{id}/group/sync` | Sync remote group |

#### Runs `/runs`

| Method | Path | Description |
|---|---|---|
| GET | `/runs` | List jobs |
| POST | `/runs/sample-compare` | Create sample comparison |
| POST | `/runs/benchmark-suite` | Create benchmark suite |
| GET | `/runs/{id}` | Job status |
| GET | `/runs/stream/events` | SSE event stream |

#### Studies `/studies`

| Method | Path | Description |
|---|---|---|
| GET | `/studies/tasks` | List study tasks |
| POST | `/studies/tasks/{id}/sessions` | Create study session |
| GET | `/studies/participant/{code}` | Get participant session |
| POST | `/studies/participant/{code}/events` | Log event |
| POST | `/studies/participant/{code}/autosave` | Auto-save draft |
| POST | `/studies/participant/{code}/submit` | Final submission |
| POST | `/studies/participant/{code}/survey` | Save survey |

#### Reports `/reports`

| Method | Path | Description |
|---|---|---|
| GET | `/reports` | List reports |
| GET | `/reports/{id}` | Report detail |
| GET | `/reports/exports/download` | Export data |

#### Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Service health check |

### 4.2 Core Engine: CoordinationRuntimeSession

~119KB of code implementing the Gate-Planner architecture:

```
Dialogue Chunks ──→ [Gate Model] ──→ WAIT / EMIT_UPDATE / SWITCH_CANVAS
                         │
                   If EMIT_UPDATE
                         ↓
                [Planner Model] ──→ delta_ops + target_graph_ir
                         │
                         ↓
            [IncrementalGraphRenderer] ──→ Updated graph + stability metrics
                         │
                         ↓
              [render_preview_mermaid] ──→ Mermaid code
```

**Gate** (small model, e.g., Qwen3.5-4B):
- Decides "when to update"
- Three actions: WAIT, EMIT_UPDATE, SWITCH_CANVAS
- Avoids calling large model on every word

**Planner** (large model, e.g., Qwen3.5-27B):
- Decides "what to update"
- Returns delta operations: add_node, add_edge, add_group
- Optionally returns full GraphIR with styles

**Deterministic Layer**:
- Applies delta_ops to current graph state
- Computes stability metrics (flicker_index, mental_map_score)
- Renders GraphIR to Mermaid code

### 4.3 Mermaid Generation & Auto-Repair

#### Generation Flow

1. Build user prompt (dialogue text, session title, diagram type)
2. Call LLM with `temperature=0`
3. Extract Mermaid candidate (strip code fences, think traces)
4. Normalize (fix bare `--` edges, split chained statements, fix self-cycles)
5. **Compile check** (via configured `mmdc` command)
6. If compile fails: send error + broken code back to LLM for repair
7. If repair succeeds: use repaired version; else preserve last successful state

### 4.4 Multi-Model Support

Backend connects to multiple models via OpenAI-compatible protocol:

| Model | Interface | Usage |
|---|---|---|
| Kimi 2.5 (Moonshot) | Official API | Gate / Planner |
| Qwen 3.5 Series | DashScope compatible | Gate / Planner (fine-tuned) |
| MiniMax 2.5 | MiniMax compatible | Gate / Planner |
| DeepSeek Series | Compatibility API | Gate / Planner (optional) |

---

## 5 Frontend Features

### 5.1 Pages

| Route | Component | Description |
|---|---|---|
| `/` | home-page.tsx | Public landing page |
| `/login` | login-form.tsx | Admin login |
| `/app/realtime` | realtime-studio.tsx | **Core**: Realtime dialogue-to-diagram workspace |
| `/app/samples` | sample-compare-workbench.tsx | Dataset sample browser & dual-model comparison |
| `/app/reports` | reports-dashboard.tsx | Experiment report management |
| `/app/settings` | platform-settings.tsx | Platform settings (runtime config, voiceprints) |
| `/study/[code]` | study-workbench.tsx | Participant study workspace |

### 5.2 Realtime Workspace (realtime-studio.tsx)

Largest component (~188KB), providing:

- **Multiple input modes**:
  - Browser microphone (Web Speech API)
  - Manual text input
  - System audio capture (audio-helper)
  - Preset demo data

- **Multi-canvas support**: Auto-switch to new canvas when dialogue shifts

- **Mermaid rendering**:
  - mermaid@11.5.0
  - Supports flowchart, sequence, state, class, ER, requirement diagrams
  - Auto-repair on compile error with fallback to last successful render

- **Node drag relayout**: Drag nodes to trigger Planner reorganization

- **Pan/Zoom canvas**:
  - Zoom range 0.55x ~ 2.6x
  - Grid background
  - System hint overlays

- **State management**: XState state machine (realtime-machine.ts)

---

## 6 Dataset Construction

### 6.1 Construction Pipeline

```
Collect Mermaid diagrams (various types)
        ↓
Rule-based reverse dialogue generation (Expert/Editor style)
        ↓
License cleanup + compilation verification
        ↓
LLM high-quality regeneration (Kimi K2.5)
        ↓
Final filtering: compile success + valid license + 4-120 turns
```

### 6.2 Current Dataset

- **Version**: `release_v7_kimi_k25_fullregen_strict_20260313`
- **Samples**: 4,709
- **Diagram Types**: flowchart, sequence, state, class, ER, requirement
- **Splits**: train / validation / test
- **Features**: Strict stage boundaries, monotonic graph evolution, balanced type distribution

### 6.3 GraphIR Intermediate Representation

`GraphIR` dataclass serves as the canonical graph representation:
- `nodes`: Node list (id, label, parent)
- `edges`: Edge list (source, target, label)
- `groups`: Group list (id, label, parent)
- `styles`: Style directives (classDef, class, style, linkStyle)
- `metadata`: Metadata (diagram_type, stage)

---

## 7 Core Algorithms

### 7.1 Incremental Rendering & Stability

`IncrementalGraphRenderer` tracks:

| Metric | Meaning |
|---|---|
| `flicker_index` | Change magnitude between adjacent frames |
| `mental_map_score` | Whether user can maintain mental map |
| `mean_displacement` | Average node movement distance |
| `p95_displacement` | 95th percentile node movement |
| `unchanged_max_drift` | Maximum drift of unchanged nodes |

### 7.2 Multi-Canvas Auto-Switching

When Gate returns `SWITCH_CANVAS`:
- Creates new canvas and initializes
- Preserves old canvas for browsing
- Prevents infinite accumulation on one diagram

### 7.3 Language Detection

`detect_dominant_dialogue_language()` analyzes CJK vs Latin character ratio to determine the dominant language, then enforces label language consistency in generated Mermaid.

---

## 8 Evaluation & Results

### 8.1 Metrics

#### Structure Quality

| Metric | Meaning |
|---|---|
| `normalized_exact_match` | Normalized exact code match |
| `normalized_similarity` | Sequence similarity ratio |
| `diagram_type_match` | Diagram type match |
| `line_precision/recall/f1` | Line-level multiset PRF |
| `token_precision/recall/f1` | Token-level PRF |
| `node_precision/recall/f1` | Node-level PRF |
| `edge_precision/recall/f1` | Edge-level PRF |
| `label_precision/recall/f1` | Label-level PRF |
| `compile_success` | Mermaid compilation success rate |

#### Realtime Performance

| Metric | Meaning |
|---|---|
| P50/P95 Latency | End-to-end latency |
| `flicker_index` | Flicker index |
| `mental_map_score` | Mental map preservation rate |

### 8.2 General Model Baselines

Test set: 963 samples (test split)

| Model | First Pass Failures | Final Failures | Avg Latency(ms) | Norm Sim | Line F1 | Edge F1 | Compile Rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Kimi 2.5 | 39 | 0 | 87,830 | 0.4953 | 0.3759 | 0.6597 | 0.3001 |
| Qwen 3.5 Thinking Off | 0 | 0 | **6,681** | 0.4685 | 0.3742 | 0.6399 | 0.3032 |
| Qwen 3.5 Thinking On | 39 | 0 | 86,230 | 0.4464 | 0.3479 | 0.6267 | 0.2835 |
| MiniMax 2.5 | 3 | 0 | 22,253 | 0.3922 | 0.2828 | 0.5204 | 0.2690 |

**Key Findings**:
- Qwen 3.5 Thinking Off is fastest and most stable
- Qwen 3.5 Thinking On performs worse than Off (thinking mode adds cost without benefit here)

### 8.3 2x2 Ablation Study

On `public-clean` validation set (312 samples):

| Configuration | Strict Match | Canonicalized Match | Semantic F1 |
|---|---:|---:|---:|
| Gate FT + Planner FT | **0.0865** | **0.0962** | **0.4567** |
| Gate Base + Planner FT | 0.0737 | 0.0865 | 0.4329 |
| Gate FT + Planner Base | 0.0321 | 0.0545 | 0.3622 |
| Gate Base + Planner Base | 0.0224 | 0.0513 | 0.3325 |

**Core Findings**:
- Planner fine-tuning is the primary quality driver (+5.29pp strict match)
- Gate fine-tuning improves stage control stability and latency
- Dual FT > Single FT > Dual Base, showing clear complementarity

### 8.4 Final Combined Result (Test Set, Public Clean)

Using Qwen3.5-4B Gate FT + Qwen3.5-27B Planner FT:

- **Strict final match**: 10.86%
- **Canonicalized match**: 11.18%
- **Entity semantic F1**: 0.4584
- Significantly exceeds multiple general-purpose LLM baselines

---

## 9 Innovation Analysis

### 9.1 Task Definition

Formally defines "collaborative dialogue to graph construction" as an **Interactive External Representation Building** task, distinct from traditional one-shot text-to-diagram.

### 9.2 Architecture

**Gate-Planner heterogeneous分工**:
- Decouples "when to update" from "what to update"
- Small model handles timing (efficiency)
- Large model handles content (quality)
- Deterministic layer ensures state consistency

### 9.3 Dataset

From rule-based cold start to LLM high-quality regeneration, building a research dataset with strict stage boundaries and monotonic graph evolution.

### 9.4 Evaluation

Simultaneously evaluates final structure quality AND process stability, not just final output.

### 9.5 System

Complete interactive platform supporting:
- Realtime dialogue-to-diagram
- Node drag relayout
- Multi-canvas browsing
- Voiceprint speaker recognition
- User study workspace

---

## 10 Practical & Commercial Value

### 10.1 Use Cases

1. **Meeting transcription**: Auto-generate architecture/flow diagrams during meetings
2. **Teaching assistant**: Build knowledge graphs during classroom discussion
3. **Requirements analysis**: Produce system architecture during product discussions
4. **Brainstorming**: Visualize concept relationships in real time
5. **Technical documentation**: Generate Mermaid content as discussion progresses

### 10.2 Commercial Advantages

- **Reduces communication cost**: Discussion produces visualizations in real time
- **Prevents information loss**: Verbal discussion no longer relies on post-meeting memory
- **Improves collaboration**: Shared diagram as "external working memory"
- **Integrates with tools**: Mermaid format works directly with Markdown, Notion, Confluence

### 10.3 Technical Moats

- Gate-Planner dual-layer architecture
- Incremental rendering stability control
- Multi-model evaluation framework
- Voiceprint speaker recognition integration
- Large-scale high-quality dataset

---

## 11 Quick Start Guide

### 11.1 Prerequisites

- Node.js 20+
- Python 3.12
- pnpm
- Docker Desktop (for PostgreSQL)
- `mmdc` (Mermaid CLI) installed

### 11.2 One-Command Start

```powershell
cd E:\Desktop\stream2graph
pnpm dev:up:win
```

### 11.3 Common Commands

```powershell
pnpm dev:down:win       # Stop all services
pnpm dev:status:win     # Check service status
pnpm dev:restart:win    # Restart all services
```

### 11.4 Access URLs

| Service | URL |
|---|---|
| Frontend | http://127.0.0.1:3000 |
| API | http://127.0.0.1:8000 |
| API Docs | http://127.0.0.1:8000/docs |
| Health | http://127.0.0.1:8000/api/health |

### 11.5 Admin Credentials

- Username: `admin`
- Password: `admin123456`

---

## 12 Development Guide

### 12.1 Backend Development

```bash
pnpm api:dev       # Start API with hot reload
pnpm api:test      # Run backend tests
pnpm api:migrate   # Run database migrations
```

### 12.2 Frontend Development

```bash
pnpm dev:web       # Start frontend
pnpm build:web     # Build production version
```

### 12.3 Git Collaboration

- Main branch: `master`
- Run `pnpm api:test` and `pnpm lint:web` before committing
- Submit migration files to `apps/api/alembic/versions/`
- Do not commit sensitive information in `.env`

---

*This document is maintained by the project team. Please sync updates to the `docs/` directory.*
