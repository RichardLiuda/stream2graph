const ACTION_LABELS = {
  propose: "提出",
  clarify: "澄清",
  challenge: "反驳",
  agree: "同意",
  question: "追问",
  summarize: "总结",
};

const BOUNDARY_LABELS = {
  sentence_end: "句末触发",
  discourse_marker: "话语标记",
  silence_gap: "停顿边界",
  max_window_ms: "窗口上限",
  token_budget: "token 上限",
  stream_end: "流结束",
};

const RELATION_LABELS = {
  sequence: "顺承",
  dependency: "依赖",
  support: "支撑",
  contrast: "对比",
  question: "追问",
  authored: "陈述",
  focus: "聚焦",
};

const state = {
  pipelineResult: null,
  prepared: null,
  evaluationResult: null,
  unifiedResult: null,
  reportList: [],
  playbackTimer: null,
  live: {
    sessionId: null,
    recognition: null,
    micActive: false,
    startWallMs: 0,
    sendQueue: Promise.resolve(),
  },
  ui: {
    viewMode: "work",
    currentFrameIndex: -1,
    filters: {
      speaker: "all",
      action: "all",
    },
    selection: {
      type: "none",
      eventIndex: -1,
      nodeId: null,
      conflictEntityId: null,
      relatedSpeakers: [],
    },
  },
};

const refs = {
  transcriptInput: document.getElementById("transcript-input"),
  primaryAction: document.getElementById("btn-primary-action"),
  voiceAction: document.getElementById("btn-voice-action"),
  moreActionsMenu: document.getElementById("more-actions-menu"),
  datasetDir: document.getElementById("dataset-dir"),
  maxFiles: document.getElementById("max-files"),
  realtimeMode: document.getElementById("realtime-mode"),
  timeScale: document.getElementById("time-scale"),
  baseWaitK: document.getElementById("base-wait-k"),
  maxWaitK: document.getElementById("max-wait-k"),
  speechLang: document.getElementById("speech-lang"),
  liveStatus: document.getElementById("live-session-status"),
  liveTranscriptLog: document.getElementById("live-transcript-log"),
  speakerFilter: document.getElementById("speaker-filter"),
  actionFilter: document.getElementById("action-filter"),
  spineCount: document.getElementById("spine-count"),
  spineCaption: document.getElementById("spine-caption"),
  conversationSpine: document.getElementById("conversation-spine"),
  selectionSummary: document.getElementById("selection-summary"),
  stageSubtitle: document.getElementById("stage-subtitle"),
  timelineCaption: document.getElementById("timeline-caption"),
  scrubberValue: document.getElementById("scrubber-value"),
  scrubber: document.getElementById("scrubber"),
  timelineTrack: document.getElementById("timeline-track"),
  currentFocus: document.getElementById("current-focus"),
  conflictList: document.getElementById("conflict-list"),
  consensusList: document.getElementById("consensus-list"),
  openBranchesList: document.getElementById("open-branches-list"),
  nextPromptsList: document.getElementById("next-prompts-list"),
  evalSummary: document.getElementById("eval-summary"),
  unifiedSummary: document.getElementById("unified-summary"),
  reportSummary: document.getElementById("report-summary"),
  reportTitle: document.getElementById("report-title"),
  reportNotes: document.getElementById("report-notes"),
  toast: document.getElementById("toast"),
  svg: document.getElementById("graph-svg"),
  mE2EP95: document.getElementById("m-e2e-p95"),
  mIntentAcc: document.getElementById("m-intent-acc"),
  mFlicker: document.getElementById("m-flicker"),
  mMental: document.getElementById("m-mental"),
  btnViewWork: document.getElementById("btn-view-work"),
  btnViewPerspective: document.getElementById("btn-view-perspective"),
  btnViewReplay: document.getElementById("btn-view-replay"),
};

const sampleTranscript = [
  "facilitator|先把数据摄取流程作为主干，从采集到解析再到路由。|sequential",
  "architect|网关应该单独作为一个模块挂在解析前面。|structural",
  "pm|等等，网关是不是更像鉴权入口，而不是解析前置？|contrastive",
  "architect|对，我澄清一下，网关负责鉴权和限流，解析服务放在后面。|structural",
  "analyst|那用户画像和订单关系要不要单独画成实体关系？|relational",
  "facilitator|好，总结一下：主链路保留，网关和解析拆开，实体关系补充在侧边。|structural",
].join("\n");

function showToast(msg) {
  refs.toast.textContent = msg;
  refs.toast.classList.add("show");
  window.clearTimeout(refs.toast._timer);
  refs.toast._timer = window.setTimeout(() => refs.toast.classList.remove("show"), 2200);
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function setSessionStatus(text) {
  refs.liveStatus.textContent = text;
  updateQuickActions();
}

function closeMoreActionsMenu() {
  refs.moreActionsMenu?.removeAttribute("open");
}

function updateQuickActions() {
  if (!refs.primaryAction || !refs.voiceAction) return;
  const hasLiveSession = Boolean(state.live.sessionId);
  refs.primaryAction.textContent = hasLiveSession ? "结束会话" : "开始整理";
  refs.voiceAction.textContent = state.live.micActive ? "停止语音" : "开始语音";
  refs.voiceAction.classList.toggle("primary", state.live.micActive);
  refs.voiceAction.classList.toggle("secondary", !state.live.micActive);
  refs.voiceAction.classList.toggle("ghost", false);
}

function appendLiveLog(line) {
  const prev = refs.liveTranscriptLog.value;
  refs.liveTranscriptLog.value = prev ? `${prev}\n${line}` : line;
  refs.liveTranscriptLog.scrollTop = refs.liveTranscriptLog.scrollHeight;
}

function summarizeText(text, max = 68) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function formatSpeakerInitial(name) {
  const raw = String(name || "U").trim();
  if (!raw) return "U";
  const pieces = raw.split(/[\s_-]+/).filter(Boolean);
  if (pieces.length >= 2) {
    return `${pieces[0][0] || ""}${pieces[1][0] || ""}`.toUpperCase();
  }
  return raw.slice(0, 2).toUpperCase();
}

function formatMsRange(startMs, endMs) {
  const start = Number(startMs || 0) / 1000;
  const end = Number(endMs || startMs || 0) / 1000;
  if (Math.abs(end - start) < 0.05) return `${start.toFixed(1)}s`;
  return `${start.toFixed(1)}s - ${end.toFixed(1)}s`;
}

function mapSemanticActionLabel(action) {
  return ACTION_LABELS[action] || ACTION_LABELS.propose;
}

function mapBoundaryLabel(reason) {
  return BOUNDARY_LABELS[reason] || "自动边界";
}

function inferSemanticAction(text, intentType) {
  const raw = String(text || "").toLowerCase();
  if (!raw) return "propose";
  if (
    raw.includes("?") ||
    raw.includes("？") ||
    ["如何", "怎么", "是否", "why", "what", "how"].some((token) => raw.includes(token))
  ) {
    return "question";
  }
  if (["总结", "总之", "最终", "overall", "in summary"].some((token) => raw.includes(token))) {
    return "summarize";
  }
  if (["同意", "赞成", "没错", "agree", "exactly", "sounds good"].some((token) => raw.includes(token))) {
    return "agree";
  }
  if (["澄清", "具体", "补充", "clarify", "specifically", "more precisely"].some((token) => raw.includes(token))) {
    return "clarify";
  }
  if (
    intentType === "contrastive" ||
    ["但是", "不过", "相反", "不是", "however", "but", "instead", "rather than"].some((token) =>
      raw.includes(token),
    )
  ) {
    return "challenge";
  }
  return "propose";
}

function fallbackNodeStatus(action, hadPriorMention = false) {
  if (action === "question") return "pending";
  if (action === "challenge" && hadPriorMention) return "contested";
  if ((action === "agree" || action === "summarize") && hadPriorMention) return "consensus";
  return hadPriorMention ? "neutral" : "new";
}

function fallbackRelationType(intentType, action) {
  if (action === "question") return "question";
  if (action === "challenge" || intentType === "contrastive") return "contrast";
  if (intentType === "sequential") return "sequence";
  if (intentType === "structural" || intentType === "relational") return "dependency";
  return "support";
}

function parseTranscriptLines(text) {
  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const chunks = [];
  lines.forEach((line, idx) => {
    const parts = line.split("|").map((p) => p.trim());
    let speaker = "user";
    let msg = "";
    let expectedIntent = null;
    if (parts.length === 1) {
      msg = parts[0];
    } else if (parts.length === 2) {
      speaker = parts[0] || "user";
      msg = parts[1];
    } else {
      speaker = parts[0] || "user";
      msg = parts[1];
      expectedIntent = parts[2] || null;
    }
    if (!msg) return;
    chunks.push({
      timestamp_ms: idx * 520,
      text: msg,
      speaker,
      expected_intent: expectedIntent,
      is_final: true,
    });
  });
  return chunks;
}

async function apiPost(path, payload) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

async function apiGet(path) {
  const resp = await fetch(path);
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function initSVG() {
  refs.svg.innerHTML = `
    <defs>
      <marker id="arrow-blue" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
        <path d="M0,0 L12,6 L0,12 Z" fill="rgba(20, 100, 192, 0.82)"></path>
      </marker>
      <marker id="arrow-slate" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
        <path d="M0,0 L12,6 L0,12 Z" fill="rgba(73, 110, 144, 0.72)"></path>
      </marker>
      <marker id="arrow-red" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
        <path d="M0,0 L12,6 L0,12 Z" fill="rgba(203, 79, 58, 0.82)"></path>
      </marker>
      <marker id="arrow-teal" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
        <path d="M0,0 L12,6 L0,12 Z" fill="rgba(15, 142, 144, 0.82)"></path>
      </marker>
      <filter id="nodeShadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="rgba(15,84,146,0.18)" />
      </filter>
    </defs>
    <g id="edges-layer"></g>
    <g id="nodes-layer"></g>
  `;
}

function normalizeAnnotationEntities(values, operationLabels) {
  if (!Array.isArray(values)) return [];
  return values
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { id: item, label: operationLabels.get(item) || item };
      }
      const id = String(item.id || item.label || "").trim();
      if (!id) return null;
      return {
        id,
        label: String(item.label || operationLabels.get(id) || id),
      };
    })
    .filter(Boolean);
}

function deriveFallbackAnnotations(eventLike, context) {
  const focusEntities = eventLike.focusEntities || [];
  const operations = eventLike.operations || [];
  const sourceText = eventLike.transcriptText || "";
  const entityLabels = new Map();
  operations.forEach((op) => {
    if (op.op === "add_node") entityLabels.set(op.id, op.label || op.id);
  });

  const contested = [];
  const consensus = [];
  focusEntities.forEach((entityId) => {
    const mentionCount = context.entityMentions.get(entityId) || 0;
    const label = entityLabels.get(entityId) || context.nodeLabels.get(entityId) || entityId;
    const op = operations.find((item) => item.op === "add_node" && item.id === entityId);
    const status = op?.status || fallbackNodeStatus(eventLike.semanticAction, mentionCount > 0);
    if (status === "contested" || (eventLike.semanticAction === "challenge" && mentionCount > 0)) {
      contested.push({ id: entityId, label });
    }
    if (status === "consensus" || ((eventLike.semanticAction === "agree" || eventLike.semanticAction === "summarize") && mentionCount > 0)) {
      consensus.push({ id: entityId, label });
    }
  });

  const openQuestions =
    eventLike.semanticAction === "question"
      ? [`待澄清：${summarizeText(sourceText, 42)}`]
      : [];

  const focusLabels = focusEntities.map((entityId) => entityLabels.get(entityId) || context.nodeLabels.get(entityId) || entityId);
  const nextPrompts = [];
  if (eventLike.semanticAction === "challenge" && focusLabels.length) {
    nextPrompts.push(`谁来明确 ${focusLabels.slice(0, 2).join(" / ")} 的取舍依据？`);
  } else if (eventLike.semanticAction === "question" && focusLabels.length) {
    nextPrompts.push(`谁来补充 ${focusLabels.slice(0, 2).join(" / ")} 的缺失信息？`);
  } else if (eventLike.semanticAction === "propose" && focusLabels.length >= 2) {
    nextPrompts.push(`${focusLabels[0]} 和 ${focusLabels[1]} 的关系还需要再明确吗？`);
  }

  return {
    contested_entities: contested,
    consensus_entities: consensus,
    open_questions: openQuestions,
    next_prompts: uniq(nextPrompts),
  };
}

function buildDeltaChips(event) {
  const nodeOps = event.operations.filter((op) => op.op === "add_node");
  const edgeOps = event.operations.filter((op) => op.op === "add_edge");
  const newNodeCount = nodeOps.filter((op) => op.is_new !== false).length;
  const touchedNodes = Math.max(0, nodeOps.length - newNodeCount);
  const pendingCount = nodeOps.filter((op) => op.status === "pending").length;
  const chips = [];
  if (newNodeCount > 0) chips.push({ label: `新增节点 ${newNodeCount}`, tone: "blue" });
  if (edgeOps.length > 0) chips.push({ label: `新增关系 ${edgeOps.length}`, tone: "slate" });
  if (touchedNodes > 0) chips.push({ label: `补充标签 ${touchedNodes}`, tone: "green" });
  if (pendingCount > 0 || event.annotations.open_questions.length > 0) {
    chips.push({ label: `待确认 ${Math.max(pendingCount, event.annotations.open_questions.length)}`, tone: "orange" });
  }
  if (!chips.length) chips.push({ label: "暂无结构变更", tone: "slate" });
  return chips;
}

function registerEventContext(context, event) {
  event.operations.forEach((op) => {
    if (op.op === "add_node") {
      context.nodeLabels.set(op.id, op.label || op.id);
    }
  });
  event.focusEntities.forEach((entityId) => {
    context.entityMentions.set(entityId, (context.entityMentions.get(entityId) || 0) + 1);
    const speakers = new Set(context.entitySpeakers.get(entityId) || []);
    event.speakers.forEach((speaker) => speakers.add(speaker));
    context.entitySpeakers.set(entityId, Array.from(speakers));
  });
}

function normalizeEvent(rawEvent, index, context) {
  const update = rawEvent?.update || {};
  const sourceChunks = Array.isArray(update.source_chunks) && update.source_chunks.length
    ? update.source_chunks
        .map((item) => ({
          timestamp_ms: Number(item.timestamp_ms ?? update.start_ms ?? index * 520),
          speaker: String(item.speaker || "user"),
          text: String(item.text || "").trim(),
        }))
        .filter((item) => item.text)
    : [
        {
          timestamp_ms: Number(update.start_ms ?? index * 520),
          speaker: String(update.primary_speaker || "user"),
          text: String(update.transcript_text || "").trim(),
        },
      ].filter((item) => item.text);

  const transcriptText =
    String(update.transcript_text || sourceChunks.map((chunk) => chunk.text).join(" ").trim());
  const speakers = uniq(
    Array.isArray(update.speakers) && update.speakers.length
      ? update.speakers.map((speaker) => String(speaker))
      : sourceChunks.map((chunk) => chunk.speaker),
  );
  const primarySpeaker = String(update.primary_speaker || speakers[0] || "user");
  const semanticAction = String(update.semantic_action || inferSemanticAction(transcriptText, update.intent_type || "generic"));
  const operations = (Array.isArray(update.operations) ? update.operations : []).map((op) => {
    if (op.op === "add_node") {
      const hadPriorMention = (context.entityMentions.get(String(op.id || "")) || 0) > 0;
      return {
        ...op,
        id: String(op.id || ""),
        label: String(op.label || op.id || ""),
        status: String(op.status || fallbackNodeStatus(semanticAction, hadPriorMention)),
        is_new: op.is_new !== false,
      };
    }
    if (op.op === "add_edge") {
      return {
        ...op,
        from: String(op.from || ""),
        to: String(op.to || ""),
        relation_type: String(op.relation_type || fallbackRelationType(update.intent_type || "generic", semanticAction)),
      };
    }
    return { ...op };
  });

  const operationLabels = new Map();
  operations.forEach((op) => {
    if (op.op === "add_node") operationLabels.set(op.id, op.label || op.id);
  });
  const focusEntities = uniq(
    Array.isArray(update.focus_entities) && update.focus_entities.length
      ? update.focus_entities.map((id) => String(id))
      : operations.filter((op) => op.op === "add_node").map((op) => op.id),
  );
  const rawAnnotations = update.annotations && typeof update.annotations === "object" ? update.annotations : null;
  const annotations = rawAnnotations
    ? {
        contested_entities: normalizeAnnotationEntities(rawAnnotations.contested_entities, operationLabels),
        consensus_entities: normalizeAnnotationEntities(rawAnnotations.consensus_entities, operationLabels),
        open_questions: Array.isArray(rawAnnotations.open_questions)
          ? rawAnnotations.open_questions.map((item) => String(item)).filter(Boolean)
          : [],
        next_prompts: Array.isArray(rawAnnotations.next_prompts)
          ? uniq(rawAnnotations.next_prompts.map((item) => String(item)).filter(Boolean))
          : [],
      }
    : deriveFallbackAnnotations(
        {
          semanticAction,
          focusEntities,
          operations,
          transcriptText,
        },
        context,
      );

  const focusLabels = focusEntities.map((entityId) => operationLabels.get(entityId) || context.nodeLabels.get(entityId) || entityId);
  const event = {
    id: Number(update.update_id || index + 1),
    index,
    primarySpeaker,
    speakers,
    semanticAction,
    semanticLabel: mapSemanticActionLabel(semanticAction),
    intentType: String(update.intent_type || "generic"),
    boundaryReason: String(update.boundary_reason || "auto"),
    boundaryLabel: mapBoundaryLabel(update.boundary_reason),
    confidence: Number(update.intent_confidence || 0),
    transcriptText,
    summaryText: summarizeText(transcriptText, 86),
    sourceChunks,
    operations,
    focusEntities,
    focusLabels,
    annotations,
    deltaChips: [],
    startMs: Number(update.start_ms || index * 520),
    endMs: Number(update.end_ms || update.start_ms || index * 520),
    timeLabel: formatMsRange(update.start_ms, update.end_ms),
    e2eLatencyMs: Number(rawEvent?.e2e_latency_ms || 0),
    renderLatencyMs: Number(rawEvent?.render_latency_ms || 0),
    flicker: Number(rawEvent?.render_frame?.flicker_index || 0),
    mentalMap: Number(rawEvent?.render_frame?.mental_map_score || 0),
    goldIntent: rawEvent?.gold_intent || null,
    intentCorrect: rawEvent?.intent_correct ?? null,
  };
  event.deltaChips = buildDeltaChips(event);
  registerEventContext(context, event);
  return event;
}

function createWorkGraphModel() {
  return {
    nodes: new Map(),
    edges: new Map(),
    laneCounts: new Map(),
    anchorChildren: new Map(),
    annotations: {
      contested: new Map(),
      consensus: new Map(),
      openQuestions: [],
      nextPrompts: [],
    },
  };
}

function calcNodeWidth(label, type = "entity") {
  const clean = String(label || "");
  const base = type === "speaker" ? 54 : type === "claim" ? 120 : 110;
  return Math.min(180, Math.max(base, clean.length * 11 + 34));
}

function resolveCollision(graph, x, y, minDistance = 94) {
  let candidateX = x;
  let candidateY = y;
  let tries = 0;
  while (tries < 24) {
    let collided = false;
    for (const node of graph.nodes.values()) {
      const dist = Math.hypot(candidateX - node.x, candidateY - node.y);
      if (dist < minDistance) {
        const angle = ((tries + 1) * 53 * Math.PI) / 180;
        const radius = 28 + tries * 8;
        candidateX = x + Math.cos(angle) * radius;
        candidateY = y + Math.sin(angle) * radius;
        collided = true;
        break;
      }
    }
    if (!collided) break;
    tries += 1;
  }
  return {
    x: clamp(candidateX, 86, 1110),
    y: clamp(candidateY, 86, 620),
  };
}

function placeWorkNode(graph, nodeId, event, relationType, anchorId) {
  if (anchorId && graph.nodes.has(anchorId)) {
    const anchor = graph.nodes.get(anchorId);
    const childIndex = graph.anchorChildren.get(anchorId) || 0;
    graph.anchorChildren.set(anchorId, childIndex + 1);
    let x = anchor.x + 160;
    let y = anchor.y;
    if (relationType === "sequence") {
      y = anchor.y + ((childIndex % 3) - 1) * 48;
    } else if (relationType === "contrast") {
      y = anchor.y + (childIndex % 2 === 0 ? -130 : 130) + Math.floor(childIndex / 2) * 16;
    } else if (relationType === "question") {
      x = anchor.x + 125;
      y = anchor.y - 150 + childIndex * 26;
    } else {
      const angles = [-90, -35, 35, 90, 145, -145];
      const angle = angles[childIndex % angles.length] + Math.floor(childIndex / angles.length) * 16;
      const radius = 138 + Math.floor(childIndex / angles.length) * 26;
      x = anchor.x + Math.cos((angle * Math.PI) / 180) * radius;
      y = anchor.y + Math.sin((angle * Math.PI) / 180) * radius;
    }
    return resolveCollision(graph, x, y);
  }

  const laneY = {
    sequential: 140,
    structural: 270,
    classification: 210,
    relational: 440,
    contrastive: 560,
    generic: 340,
  };
  const laneKey = event.intentType in laneY ? event.intentType : "generic";
  const laneIndex = graph.laneCounts.get(laneKey) || 0;
  graph.laneCounts.set(laneKey, laneIndex + 1);
  return resolveCollision(graph, 110 + laneIndex * 170, laneY[laneKey]);
}

function mergeNodeStatus(current, next) {
  if (next === "consensus") return "consensus";
  if (next === "contested") return "contested";
  if (next === "pending" && current !== "consensus" && current !== "contested") return "pending";
  if (!current || current === "neutral" || current === "new") return next || current || "neutral";
  return current;
}

function snapshotEntityInfo(entityId, graph) {
  const node = graph.nodes.get(entityId);
  if (!node) return { id: entityId, label: entityId, speakers: [] };
  return {
    id: entityId,
    label: node.label,
    speakers: Array.from(node.speakers),
    eventCount: node.provenance.size,
  };
}

function uniquePush(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function applyWorkEvent(graph, event, eventIndex) {
  const anchorMap = new Map();
  event.operations
    .filter((op) => op.op === "add_edge")
    .forEach((op) => {
      if (!anchorMap.has(op.to)) anchorMap.set(op.to, op.from);
      if (!anchorMap.has(op.from) && graph.nodes.has(op.to)) anchorMap.set(op.from, op.to);
    });

  event.operations
    .filter((op) => op.op === "add_node")
    .forEach((op) => {
      let node = graph.nodes.get(op.id);
      if (!node) {
        const relationType =
          event.operations.find((edge) => edge.op === "add_edge" && edge.to === op.id)?.relation_type || "support";
        const anchorId = anchorMap.get(op.id);
        const pos = placeWorkNode(graph, op.id, event, relationType, anchorId);
        node = {
          id: op.id,
          type: "entity",
          label: op.label || op.id,
          x: pos.x,
          y: pos.y,
          width: calcNodeWidth(op.label || op.id),
          height: 46,
          status: op.status || "neutral",
          provenance: new Set(),
          speakers: new Set(),
          createdIndex: eventIndex,
          lastAction: event.semanticAction,
        };
        graph.nodes.set(op.id, node);
      }
      node.label = op.label || node.label;
      node.width = calcNodeWidth(node.label);
      node.status = mergeNodeStatus(node.status, op.status);
      node.provenance.add(eventIndex);
      event.speakers.forEach((speaker) => node.speakers.add(speaker));
      node.lastAction = event.semanticAction;
    });

  event.operations
    .filter((op) => op.op === "add_edge")
    .forEach((op) => {
      if (!graph.nodes.has(op.from)) {
        const pos = placeWorkNode(graph, op.from, event, op.relation_type || "support", op.to);
        graph.nodes.set(op.from, {
          id: op.from,
          type: "entity",
          label: op.from,
          x: pos.x,
          y: pos.y,
          width: calcNodeWidth(op.from),
          height: 46,
          status: "neutral",
          provenance: new Set([eventIndex]),
          speakers: new Set(event.speakers),
          createdIndex: eventIndex,
          lastAction: event.semanticAction,
        });
      }
      if (!graph.nodes.has(op.to)) {
        const pos = placeWorkNode(graph, op.to, event, op.relation_type || "support", op.from);
        graph.nodes.set(op.to, {
          id: op.to,
          type: "entity",
          label: op.to,
          x: pos.x,
          y: pos.y,
          width: calcNodeWidth(op.to),
          height: 46,
          status: "neutral",
          provenance: new Set([eventIndex]),
          speakers: new Set(event.speakers),
          createdIndex: eventIndex,
          lastAction: event.semanticAction,
        });
      }
      const relationType = op.relation_type || "support";
      const key = `${op.from}__${op.to}__${relationType}`;
      let edge = graph.edges.get(key);
      if (!edge) {
        edge = {
          key,
          from: op.from,
          to: op.to,
          relationType,
          provenance: new Set(),
          createdIndex: eventIndex,
        };
        graph.edges.set(key, edge);
      }
      edge.provenance.add(eventIndex);
    });

  event.annotations.contested_entities.forEach((entity) => {
    const node = graph.nodes.get(entity.id);
    if (!node) return;
    node.status = "contested";
    graph.annotations.consensus.delete(entity.id);
    graph.annotations.contested.set(entity.id, snapshotEntityInfo(entity.id, graph));
  });

  event.annotations.consensus_entities.forEach((entity) => {
    const node = graph.nodes.get(entity.id);
    if (!node) return;
    node.status = "consensus";
    graph.annotations.contested.delete(entity.id);
    graph.annotations.consensus.set(entity.id, snapshotEntityInfo(entity.id, graph));
  });

  if (event.semanticAction === "question") {
    event.focusEntities.forEach((entityId) => {
      const node = graph.nodes.get(entityId);
      if (node && node.status !== "consensus" && node.status !== "contested") node.status = "pending";
    });
  }

  event.annotations.open_questions.forEach((question) => uniquePush(graph.annotations.openQuestions, question));
  event.annotations.next_prompts.forEach((prompt) => uniquePush(graph.annotations.nextPrompts, prompt));
}

function serializeGraphSnapshot(graph, eventIndex) {
  const nodes = Array.from(graph.nodes.values())
    .map((node) => ({
      ...node,
      provenance: Array.from(node.provenance),
      speakers: Array.from(node.speakers),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const edges = Array.from(graph.edges.values()).map((edge) => ({
    ...edge,
    provenance: Array.from(edge.provenance),
  }));

  return {
    eventIndex,
    nodes,
    edges,
    contestedEntities: Array.from(graph.annotations.contested.values()).sort((a, b) => a.label.localeCompare(b.label)),
    consensusEntities: Array.from(graph.annotations.consensus.values()).sort((a, b) => a.label.localeCompare(b.label)),
    openQuestions: graph.annotations.openQuestions.slice(),
    nextPrompts: graph.annotations.nextPrompts.slice(-6),
  };
}

function buildWorkSnapshots(events) {
  const graph = createWorkGraphModel();
  const snapshots = [];
  events.forEach((event, eventIndex) => {
    applyWorkEvent(graph, event, eventIndex);
    snapshots.push(serializeGraphSnapshot(graph, eventIndex));
  });
  return snapshots;
}

function createPerspectiveGraphModel() {
  return {
    nodes: new Map(),
    edges: new Map(),
    speakerOrder: new Map(),
    entityOrder: new Map(),
    lastClaimByEntity: new Map(),
  };
}

function ensurePerspectiveSpeakerNode(graph, speaker) {
  const speakerId = `speaker:${speaker}`;
  if (graph.nodes.has(speakerId)) return speakerId;
  const idx = graph.speakerOrder.size;
  graph.speakerOrder.set(speakerId, idx);
  graph.nodes.set(speakerId, {
    id: speakerId,
    type: "speaker",
    label: summarizeText(speaker, 10),
    rawLabel: speaker,
    x: 118,
    y: 110 + idx * 102,
    width: 54,
    height: 54,
    status: "neutral",
    provenance: [idx],
    speakers: [speaker],
  });
  return speakerId;
}

function ensurePerspectiveEntityNode(graph, entityId, workSnapshot) {
  if (graph.nodes.has(entityId)) return entityId;
  const workNode = workSnapshot?.nodes?.find((node) => node.id === entityId);
  const idx = graph.entityOrder.size;
  graph.entityOrder.set(entityId, idx);
  graph.nodes.set(entityId, {
    id: entityId,
    type: "entity",
    label: workNode?.label || entityId,
    x: 920 + (idx % 2) * 122,
    y: workNode?.y || 110 + idx * 84,
    width: calcNodeWidth(workNode?.label || entityId),
    height: 46,
    status: workNode?.status || "neutral",
    provenance: workNode?.provenance || [],
    speakers: workNode?.speakers || [],
  });
  return entityId;
}

function addPerspectiveEdge(graph, from, to, relationType, eventIndex) {
  const key = `${from}__${to}__${relationType}`;
  if (graph.edges.has(key)) {
    graph.edges.get(key).provenance.push(eventIndex);
    return;
  }
  graph.edges.set(key, {
    key,
    from,
    to,
    relationType,
    provenance: [eventIndex],
    createdIndex: eventIndex,
  });
}

function buildPerspectiveSnapshots(events, workSnapshots) {
  const graph = createPerspectiveGraphModel();
  const snapshots = [];

  events.forEach((event, eventIndex) => {
    const workSnapshot = workSnapshots[eventIndex];
    const speakerId = ensurePerspectiveSpeakerNode(graph, event.primarySpeaker);
    const claimId = `claim:${event.id}`;
    graph.nodes.set(claimId, {
      id: claimId,
      type: "claim",
      label: summarizeText(event.transcriptText, 26),
      x: 420 + Math.floor(eventIndex / 6) * 160,
      y: 108 + (eventIndex % 6) * 88,
      width: calcNodeWidth(summarizeText(event.transcriptText, 22), "claim"),
      height: 44,
      status: event.semanticAction === "challenge" ? "contested" : event.semanticAction === "question" ? "pending" : "neutral",
      provenance: [eventIndex],
      speakers: [event.primarySpeaker],
      claimEventIndex: eventIndex,
    });
    addPerspectiveEdge(graph, speakerId, claimId, "authored", eventIndex);

    event.focusEntities.forEach((entityId) => {
      ensurePerspectiveEntityNode(graph, entityId, workSnapshot);
      addPerspectiveEdge(
        graph,
        claimId,
        entityId,
        event.semanticAction === "question"
          ? "question"
          : event.semanticAction === "challenge"
            ? "contrast"
            : "focus",
        eventIndex,
      );
      const previousClaim = graph.lastClaimByEntity.get(entityId);
      if (
        previousClaim &&
        previousClaim !== claimId &&
        ["challenge", "agree", "clarify", "question"].includes(event.semanticAction)
      ) {
        addPerspectiveEdge(
          graph,
          claimId,
          previousClaim,
          event.semanticAction === "agree" ? "support" : event.semanticAction === "clarify" ? "dependency" : event.semanticAction === "question" ? "question" : "contrast",
          eventIndex,
        );
      }
      graph.lastClaimByEntity.set(entityId, claimId);
    });

    snapshots.push({
      eventIndex,
      nodes: Array.from(graph.nodes.values()).map((node) => ({
        ...node,
        provenance: Array.isArray(node.provenance) ? node.provenance.slice() : [],
        speakers: Array.isArray(node.speakers) ? node.speakers.slice() : [],
      })),
      edges: Array.from(graph.edges.values()).map((edge) => ({
        ...edge,
        provenance: edge.provenance.slice(),
      })),
      contestedEntities: workSnapshot?.contestedEntities || [],
      consensusEntities: workSnapshot?.consensusEntities || [],
      openQuestions: workSnapshot?.openQuestions || [],
      nextPrompts: workSnapshot?.nextPrompts || [],
    });
  });

  return snapshots;
}

function preparePipelineData(pipeline) {
  const rawEvents = Array.isArray(pipeline?.events) ? pipeline.events : [];
  const context = {
    entityMentions: new Map(),
    entitySpeakers: new Map(),
    nodeLabels: new Map(),
  };
  const events = rawEvents.map((rawEvent, index) => normalizeEvent(rawEvent, index, context));
  const workSnapshots = buildWorkSnapshots(events);
  const perspectiveSnapshots = buildPerspectiveSnapshots(events, workSnapshots);

  return {
    events,
    workSnapshots,
    perspectiveSnapshots,
    speakers: uniq(events.flatMap((event) => event.speakers)).sort((a, b) => a.localeCompare(b)),
    actions: uniq(events.map((event) => event.semanticAction)),
  };
}

function updateMetricCardsFromSummary(summary, evalMetrics = null) {
  refs.mE2EP95.textContent =
    evalMetrics?.e2e_latency_p95_ms != null
      ? `${Number(evalMetrics.e2e_latency_p95_ms).toFixed(1)} ms`
      : `${Number(summary?.latency_e2e_ms?.p95 || 0).toFixed(1)} ms`;
  refs.mIntentAcc.textContent =
    evalMetrics?.intent_accuracy != null
      ? `${(Number(evalMetrics.intent_accuracy) * 100).toFixed(1)}%`
      : summary?.intent_labeled_accuracy != null
        ? `${(Number(summary.intent_labeled_accuracy) * 100).toFixed(1)}%`
        : "-";
  refs.mFlicker.textContent = Number(summary?.renderer_stability?.flicker_index?.mean || 0).toFixed(3);
  refs.mMental.textContent = Number(summary?.renderer_stability?.mental_map_score?.mean || 0).toFixed(3);
}

function updateMetricCards() {
  const summary = state.pipelineResult?.summary || {};
  const metrics = state.evaluationResult?.metrics || null;
  updateMetricCardsFromSummary(summary, metrics);
}

function setReportSummary(payload) {
  refs.reportSummary.textContent = pretty(payload || {});
}

function buildReportSavePayload() {
  return {
    title: (refs.reportTitle.value || "").trim() || "realtime_ui_run",
    notes: (refs.reportNotes.value || "").trim(),
    session_id: state.live.sessionId || null,
    pipeline_result: state.pipelineResult,
    realtime_evaluation: state.evaluationResult,
    unified_evaluation: state.unifiedResult,
    latency_p95_threshold_ms: 2000,
    flicker_mean_threshold: 6.0,
    mental_map_min: 0.85,
    intent_accuracy_threshold: 0.8,
  };
}

async function refreshReportList(limit = 8) {
  const data = await apiGet(`/api/report/list?limit=${encodeURIComponent(limit)}`);
  state.reportList = data.reports || [];
  const latest = state.reportList[0] || null;
  setReportSummary({
    latest,
    report_count: data.count || state.reportList.length,
  });
}

function ensurePipelineResultContainer() {
  if (!state.pipelineResult) {
    state.pipelineResult = {
      meta: { mode: "live_session" },
      summary: {},
      events: [],
    };
  }
  if (!Array.isArray(state.pipelineResult.events)) {
    state.pipelineResult.events = [];
  }
}

function getCurrentWorkSnapshot() {
  if (!state.prepared?.workSnapshots?.length || state.ui.currentFrameIndex < 0) return null;
  return state.prepared.workSnapshots[clamp(state.ui.currentFrameIndex, 0, state.prepared.workSnapshots.length - 1)];
}

function getCurrentPerspectiveSnapshot() {
  if (!state.prepared?.perspectiveSnapshots?.length || state.ui.currentFrameIndex < 0) return null;
  return state.prepared.perspectiveSnapshots[clamp(state.ui.currentFrameIndex, 0, state.prepared.perspectiveSnapshots.length - 1)];
}

function getActiveStageSnapshot() {
  if (state.ui.viewMode === "perspective") return getCurrentPerspectiveSnapshot();
  return getCurrentWorkSnapshot();
}

function activeEvent() {
  if (!state.prepared?.events?.length) return null;
  const idx =
    state.ui.selection.type === "event" && state.ui.selection.eventIndex >= 0
      ? state.ui.selection.eventIndex
      : state.ui.currentFrameIndex;
  return state.prepared.events[clamp(idx, 0, state.prepared.events.length - 1)];
}

function latestEventIndexForNode(nodeId, maxIndex = state.ui.currentFrameIndex) {
  const snapshot = getCurrentWorkSnapshot();
  const node = snapshot?.nodes?.find((item) => item.id === nodeId);
  if (!node?.provenance?.length) return -1;
  return [...node.provenance].filter((idx) => idx <= maxIndex).sort((a, b) => b - a)[0] ?? -1;
}

function syncPreparedState() {
  state.prepared = preparePipelineData(state.pipelineResult);
  const eventCount = state.prepared.events.length;
  if (!eventCount) {
    state.ui.currentFrameIndex = -1;
    state.ui.selection = {
      type: "none",
      eventIndex: -1,
      nodeId: null,
      conflictEntityId: null,
      relatedSpeakers: [],
    };
    return;
  }
  if (state.ui.currentFrameIndex < 0 || state.ui.currentFrameIndex >= eventCount) {
    state.ui.currentFrameIndex = eventCount - 1;
  }
  if (
    state.ui.selection.type === "none" ||
    state.ui.selection.eventIndex < 0 ||
    state.ui.selection.eventIndex >= eventCount
  ) {
    state.ui.selection = {
      type: "event",
      eventIndex: state.ui.currentFrameIndex,
      nodeId: null,
      conflictEntityId: null,
      relatedSpeakers: [],
    };
  }
}

function ingestPipelineResult(pipeline, evaluationResult = state.evaluationResult) {
  state.pipelineResult = pipeline;
  state.evaluationResult = evaluationResult;
  syncPreparedState();
  renderAll();
}

function appendLiveEvents(events, summary = null) {
  ensurePipelineResultContainer();
  events.forEach((event) => state.pipelineResult.events.push(event));
  if (summary) {
    state.pipelineResult.summary = {
      ...state.pipelineResult.summary,
      ...summary,
    };
  }
  syncPreparedState();
  state.ui.currentFrameIndex = state.prepared.events.length - 1;
  state.ui.selection = {
    type: "event",
    eventIndex: state.ui.currentFrameIndex,
    nodeId: null,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  renderAll();
}

function populateSelect(selectEl, options, currentValue, labelMap = null) {
  const nextOptions = [
    { value: "all", label: "全部" },
    ...options.map((value) => ({
      value,
      label: labelMap ? labelMap(value) : value,
    })),
  ];
  selectEl.innerHTML = nextOptions
    .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
    .join("");
  selectEl.value = nextOptions.some((item) => item.value === currentValue) ? currentValue : "all";
}

function updateFilterControls() {
  populateSelect(refs.speakerFilter, state.prepared?.speakers || [], state.ui.filters.speaker);
  populateSelect(
    refs.actionFilter,
    state.prepared?.actions || [],
    state.ui.filters.action,
    (value) => mapSemanticActionLabel(value),
  );
}

function getVisibleEventIndices() {
  const events = state.prepared?.events || [];
  return events
    .map((event) => event.index)
    .filter((index) => {
      const event = events[index];
      if (state.ui.filters.speaker !== "all" && !event.speakers.includes(state.ui.filters.speaker)) return false;
      if (state.ui.filters.action !== "all" && event.semanticAction !== state.ui.filters.action) return false;
      if (
        state.ui.selection.type === "conflict" &&
        state.ui.selection.relatedSpeakers?.length &&
        !event.focusEntities.includes(state.ui.selection.conflictEntityId) &&
        !event.speakers.some((speaker) => state.ui.selection.relatedSpeakers.includes(speaker))
      ) {
        return false;
      }
      return true;
    });
}

function scrollSpineCard(index) {
  window.requestAnimationFrame(() => {
    const el = refs.conversationSpine.querySelector(`[data-event-index="${index}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function focusEvent(index, options = {}) {
  stopPlayback();
  state.ui.currentFrameIndex = clamp(index, 0, state.prepared.events.length - 1);
  state.ui.selection = {
    type: "event",
    eventIndex: state.ui.currentFrameIndex,
    nodeId: null,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  if (options.viewMode) state.ui.viewMode = options.viewMode;
  renderAll();
  scrollSpineCard(index);
}

function focusNode(nodeId) {
  stopPlayback();
  const latestIndex = latestEventIndexForNode(nodeId);
  if (latestIndex >= 0) {
    state.ui.currentFrameIndex = latestIndex;
  }
  state.ui.selection = {
    type: "node",
    eventIndex: latestIndex,
    nodeId,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  renderAll();
  if (latestIndex >= 0) scrollSpineCard(latestIndex);
}

function focusConflict(entityId) {
  stopPlayback();
  const snapshot = getCurrentWorkSnapshot();
  const node = snapshot?.nodes?.find((item) => item.id === entityId);
  const latestIndex = latestEventIndexForNode(entityId);
  if (latestIndex >= 0) state.ui.currentFrameIndex = latestIndex;
  state.ui.selection = {
    type: "conflict",
    eventIndex: latestIndex,
    nodeId: entityId,
    conflictEntityId: entityId,
    relatedSpeakers: node?.speakers || [],
  };
  renderAll();
  if (latestIndex >= 0) scrollSpineCard(latestIndex);
}

function clearFocus() {
  if (!state.prepared?.events?.length) return;
  state.ui.selection = {
    type: "event",
    eventIndex: state.ui.currentFrameIndex,
    nodeId: null,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  renderAll();
}

function renderConversationSpine() {
  const events = state.prepared?.events || [];
  const visibleIndices = getVisibleEventIndices();
  const selectionType = state.ui.selection.type;
  const relevantEventSet = new Set();
  let relevantSpeakers = [];

  if (selectionType === "event" && state.ui.selection.eventIndex >= 0) {
    relevantEventSet.add(state.ui.selection.eventIndex);
  } else if (selectionType === "node" || selectionType === "conflict") {
    const snapshot = getCurrentWorkSnapshot();
    const node = snapshot?.nodes?.find((item) => item.id === state.ui.selection.nodeId);
    (node?.provenance || []).forEach((idx) => relevantEventSet.add(idx));
    relevantSpeakers = node?.speakers || state.ui.selection.relatedSpeakers || [];
  }

  refs.spineCount.textContent = String(visibleIndices.length);
  if (!events.length) {
    refs.spineCaption.textContent = "当前还没有梳理片段";
    refs.conversationSpine.innerHTML = '<div class="insight-item empty">开始整理后，这里会按发言顺序长出讨论脉络。</div>';
    return;
  }

  refs.spineCaption.textContent =
    selectionType === "conflict" && state.ui.selection.relatedSpeakers?.length
      ? `已过滤为 ${state.ui.selection.relatedSpeakers.join(" / ")} 的相关发言`
      : visibleIndices.length === events.length
        ? "显示全部发言片段"
        : `已筛出 ${visibleIndices.length} / ${events.length} 条发言片段`;

  refs.conversationSpine.innerHTML = visibleIndices
    .map((index) => {
      const event = events[index];
      const isActive = state.ui.selection.type === "event" && state.ui.selection.eventIndex === index;
      const isRelated =
        relevantEventSet.has(index) ||
        (selectionType !== "event" && relevantSpeakers.length && event.speakers.some((speaker) => relevantSpeakers.includes(speaker)));
      const shouldDim =
        (selectionType === "node" || selectionType === "conflict") &&
        !isRelated &&
        !event.focusEntities.includes(state.ui.selection.nodeId);

      return `
        <article class="spine-card ${isActive ? "active" : ""} ${isRelated && !isActive ? "related" : ""} ${shouldDim ? "dimmed" : ""}" data-event-index="${index}">
          <div class="spine-card-head">
            <div class="speaker-badge">
              <div class="speaker-avatar">${escapeHtml(formatSpeakerInitial(event.primarySpeaker))}</div>
              <div class="speaker-meta">
                <strong>${escapeHtml(event.primarySpeaker)}</strong>
                <span>${escapeHtml(event.semanticLabel)} · ${escapeHtml(event.timeLabel)}</span>
              </div>
            </div>
            <div class="time-pill">#${event.id}</div>
          </div>
          <p>${escapeHtml(event.summaryText)}</p>
          <div class="chip-row">
            ${event.deltaChips
              .map((chip) => `<span class="chip ${escapeHtml(chip.tone)}">${escapeHtml(chip.label)}</span>`)
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");

  refs.conversationSpine.querySelectorAll(".spine-card").forEach((card) => {
    card.addEventListener("click", () => {
      const index = Number(card.dataset.eventIndex || 0);
      focusEvent(index);
    });
  });
}

function currentSelectionSummaryHtml() {
  const events = state.prepared?.events || [];
  if (!events.length) {
    return "等待第一批整理结果到来。可以先用示例体验一下讨论画布如何逐步长出来。";
  }

  if (state.ui.selection.type === "node" || state.ui.selection.type === "conflict") {
    const snapshot = getCurrentWorkSnapshot();
    const node = snapshot?.nodes?.find((item) => item.id === state.ui.selection.nodeId);
    if (!node) return "当前聚焦的节点还没有进入舞台。";
    return `
      <strong>${escapeHtml(node.label)}</strong> 当前状态为 <strong>${escapeHtml(node.status)}</strong>，
      相关 speaker 有 ${escapeHtml(node.speakers.join(" / ") || "unknown")}；
      它在 <strong>${escapeHtml(String(node.provenance.length))}</strong> 轮整理中被提及。
    `;
  }

  const event = activeEvent();
  if (!event) return "请选择一轮整理结果查看。";
  return `
    <strong>${escapeHtml(event.primarySpeaker)}</strong> 以 <strong>${escapeHtml(event.semanticLabel)}</strong> 推动了第
    <strong>#${event.id}</strong> 轮发言整理。当前舞台停留在 ${escapeHtml(event.timeLabel)}，
    本次主要影响 ${escapeHtml(event.focusLabels.slice(0, 3).join(" / ") || "当前分支")}。
  `;
}

function currentHighlights(snapshot) {
  const highlightNodeIds = new Set();
  const highlightEdgeKeys = new Set();
  if (!snapshot) return { highlightNodeIds, highlightEdgeKeys };

  if (state.ui.selection.type === "node" || state.ui.selection.type === "conflict") {
    highlightNodeIds.add(state.ui.selection.nodeId);
    snapshot.edges.forEach((edge) => {
      if (edge.from === state.ui.selection.nodeId || edge.to === state.ui.selection.nodeId) {
        highlightEdgeKeys.add(edge.key);
      }
    });
    return { highlightNodeIds, highlightEdgeKeys };
  }

  const event = activeEvent();
  if (!event) return { highlightNodeIds, highlightEdgeKeys };
  event.focusEntities.forEach((entityId) => highlightNodeIds.add(entityId));
  event.operations
    .filter((op) => op.op === "add_edge")
    .forEach((op) => highlightEdgeKeys.add(`${op.from}__${op.to}__${op.relation_type || fallbackRelationType(event.intentType, event.semanticAction)}`));
  return { highlightNodeIds, highlightEdgeKeys };
}

function relationMarkerId(relationType) {
  if (relationType === "sequence") return "arrow-blue";
  if (relationType === "contrast") return "arrow-red";
  if (relationType === "question") return "arrow-teal";
  return "arrow-slate";
}

function buildEdgePath(src, dst, relationType) {
  const curve =
    relationType === "contrast"
      ? 40
      : relationType === "question"
        ? -42
        : relationType === "authored"
          ? -20
          : relationType === "focus"
            ? 18
            : 0;
  if (curve === 0) return `M ${src.x} ${src.y} L ${dst.x} ${dst.y}`;
  const mx = (src.x + dst.x) / 2;
  const my = (src.y + dst.y) / 2 + curve;
  return `M ${src.x} ${src.y} Q ${mx} ${my} ${dst.x} ${dst.y}`;
}

function renderEmptyStage(message) {
  initSVG();
  const nodeLayer = refs.svg.querySelector("#nodes-layer");
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", "600");
  text.setAttribute("y", "350");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#6b8297");
  text.setAttribute("font-size", "20");
  text.textContent = message;
  nodeLayer.appendChild(text);
}

function renderGraphSnapshot(snapshot) {
  if (!snapshot || !snapshot.nodes?.length) {
    renderEmptyStage("等待第一轮图结构出现");
    return;
  }

  initSVG();
  const edgeLayer = refs.svg.querySelector("#edges-layer");
  const nodeLayer = refs.svg.querySelector("#nodes-layer");
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const { highlightNodeIds, highlightEdgeKeys } = currentHighlights(snapshot);
  const activeEventIndex = activeEvent()?.index ?? state.ui.currentFrameIndex;

  snapshot.edges.forEach((edge) => {
    const src = nodeMap.get(edge.from);
    const dst = nodeMap.get(edge.to);
    if (!src || !dst) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", buildEdgePath(src, dst, edge.relationType || "support"));
    path.setAttribute(
      "class",
      `edge-line edge-${edge.relationType || "support"} ${highlightEdgeKeys.has(edge.key) ? "edge-active" : ""}`,
    );
    path.setAttribute("marker-end", `url(#${relationMarkerId(edge.relationType)})`);
    edgeLayer.appendChild(path);
  });

  snapshot.nodes.forEach((node) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const nodeType = node.type || "entity";
    const isActiveNode =
      highlightNodeIds.has(node.id) ||
      (state.ui.selection.type === "event" && Array.isArray(node.provenance) && node.provenance.includes(activeEventIndex));
    const isHighlighted = highlightNodeIds.has(node.id);
    g.setAttribute(
      "class",
      `node-group node-${nodeType} status-${node.status || "neutral"} ${isHighlighted ? "node-highlight" : ""} ${
        isActiveNode ? "node-active" : ""
      }`,
    );
    g.setAttribute("transform", `translate(${node.x}, ${node.y})`);

    if ((nodeType === "entity" || nodeType === "claim") && node.createdIndex === activeEventIndex) {
      const outline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      outline.setAttribute("x", String(-node.width / 2 - 6));
      outline.setAttribute("y", String(-node.height / 2 - 6));
      outline.setAttribute("width", String(node.width + 12));
      outline.setAttribute("height", String(node.height + 12));
      outline.setAttribute("rx", "18");
      outline.setAttribute("class", "node-outline");
      g.appendChild(outline);
    }

    if (nodeType === "speaker") {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", "28");
      circle.setAttribute("class", "node-body");
      circle.setAttribute("filter", "url(#nodeShadow)");
      g.appendChild(circle);
    } else {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(-node.width / 2));
      rect.setAttribute("y", String(-node.height / 2));
      rect.setAttribute("width", String(node.width));
      rect.setAttribute("height", String(node.height));
      rect.setAttribute("rx", "16");
      rect.setAttribute("class", "node-body");
      rect.setAttribute("filter", "url(#nodeShadow)");
      g.appendChild(rect);
    }

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "node-label");
    text.textContent = summarizeText(node.rawLabel || node.label, node.type === "claim" ? 26 : 16);
    g.appendChild(text);

    g.addEventListener("click", () => {
      if (node.type === "claim" && Number.isInteger(node.claimEventIndex)) {
        focusEvent(node.claimEventIndex, { viewMode: "perspective" });
      } else if (node.type === "entity") {
        focusNode(node.id);
      }
    });
    nodeLayer.appendChild(g);
  });
}

function renderStage() {
  const snapshot = getActiveStageSnapshot();
  refs.selectionSummary.innerHTML = currentSelectionSummaryHtml();
  refs.stageSubtitle.textContent =
    state.ui.viewMode === "perspective"
      ? "观点图从同一批发言派生，强调人物、观点和实体之间的关系"
      : state.ui.viewMode === "replay"
        ? "回放模式会把舞台锁定到当前时间点，便于观察图是如何长出来的"
        : "工作图保持布局稳定，默认只高亮本轮发言真正推动的部分";

  refs.btnViewWork.classList.toggle("active", state.ui.viewMode === "work");
  refs.btnViewPerspective.classList.toggle("active", state.ui.viewMode === "perspective");
  refs.btnViewReplay.classList.toggle("active", state.ui.viewMode === "replay");

  renderGraphSnapshot(snapshot);
  renderScrubber();
}

function renderScrubber() {
  const events = state.prepared?.events || [];
  if (!events.length) {
    refs.timelineCaption.textContent = "等待整理结果";
    refs.scrubberValue.textContent = "0 / 0";
    refs.scrubber.min = "0";
    refs.scrubber.max = "0";
    refs.scrubber.value = "0";
    refs.scrubber.disabled = true;
    refs.timelineTrack.innerHTML = "";
    return;
  }

  const frameIndex = clamp(state.ui.currentFrameIndex, 0, events.length - 1);
  const event = events[frameIndex];
  refs.scrubber.disabled = false;
  refs.scrubber.min = "0";
  refs.scrubber.max = String(events.length - 1);
  refs.scrubber.value = String(frameIndex);
  refs.timelineCaption.textContent = `第 #${event.id} 步 · ${event.primarySpeaker} · ${event.semanticLabel}`;
  refs.scrubberValue.textContent = `${frameIndex + 1} / ${events.length}`;

  refs.timelineTrack.innerHTML = events
    .map(
      (item, index) => `
        <button
          class="timeline-tick ${index === frameIndex ? "active" : ""}"
          data-event-index="${index}"
          title="${escapeHtml(
            `${item.primarySpeaker} · ${item.semanticLabel} · ${item.summaryText} · flicker ${item.flicker.toFixed(3)} · latency ${item.e2eLatencyMs.toFixed(1)}ms`,
          )}"
        >
          <div class="tick-top">
            <span>#${item.id}</span>
            <span>${escapeHtml(item.timeLabel)}</span>
          </div>
          <strong>${escapeHtml(item.semanticLabel)}</strong>
          <span>${escapeHtml(summarizeText(item.primarySpeaker, 12))}</span>
        </button>
      `,
    )
    .join("");

  refs.timelineTrack.querySelectorAll(".timeline-tick").forEach((tick) => {
    tick.addEventListener("click", () => {
      const index = Number(tick.dataset.eventIndex || 0);
      focusEvent(index, { viewMode: state.ui.viewMode });
    });
  });
}

function renderCurrentFocus() {
  const events = state.prepared?.events || [];
  if (!events.length) {
    refs.currentFocus.innerHTML = '<div class="insight-item empty">等待第一轮整理结果出现。</div>';
    return;
  }

  if (state.ui.selection.type === "node" || state.ui.selection.type === "conflict") {
    const snapshot = getCurrentWorkSnapshot();
    const node = snapshot?.nodes?.find((item) => item.id === state.ui.selection.nodeId);
    if (!node) {
      refs.currentFocus.innerHTML = '<div class="insight-item empty">当前节点还没有出现在工作图中。</div>';
      return;
    }
    refs.currentFocus.innerHTML = `
      <p><strong>${escapeHtml(node.label)}</strong> 当前状态：<strong>${escapeHtml(node.status)}</strong></p>
      <p>相关 speaker：${escapeHtml(node.speakers.join(" / ") || "unknown")}</p>
      <p>涉及轮次：${escapeHtml(node.provenance.map((idx) => `#${events[idx]?.id || idx + 1}`).join(", "))}</p>
    `;
    return;
  }

  const event = activeEvent();
  if (!event) {
    refs.currentFocus.innerHTML = '<div class="insight-item empty">请选择一轮整理结果。</div>';
    return;
  }

  refs.currentFocus.innerHTML = `
    <p><strong>${escapeHtml(event.primarySpeaker)}</strong> 以 <strong>${escapeHtml(event.semanticLabel)}</strong> 推动了当前这一轮整理。</p>
    <p>原话：${escapeHtml(event.summaryText)}</p>
    <div class="tag-row">
      <span class="insight-chip">${escapeHtml(event.boundaryLabel)}</span>
      <span class="insight-chip">${escapeHtml(event.timeLabel)}</span>
    </div>
    <div class="entity-row">
      ${event.focusLabels.map((label) => `<span class="entity-pill">${escapeHtml(label)}</span>`).join("")}
    </div>
  `;
}

function renderEntityList(container, items, emptyText) {
  if (!items.length) {
    container.innerHTML = `<div class="insight-item empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
        <button class="insight-item actionable" data-entity-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.label)}</strong>
          <div>${escapeHtml(item.speakers?.join(" / ") || "related speakers unavailable")}</div>
        </button>
      `,
    )
    .join("");

  container.querySelectorAll("[data-entity-id]").forEach((el) => {
    el.addEventListener("click", () => {
      focusConflict(String(el.dataset.entityId || ""));
    });
  });
}

function renderInsights() {
  renderCurrentFocus();
  const snapshot = getCurrentWorkSnapshot();
  if (!snapshot) {
    renderEntityList(refs.conflictList, [], "暂时没有分歧实体");
    renderEntityList(refs.consensusList, [], "暂时没有共识实体");
    refs.openBranchesList.innerHTML = '<div class="insight-item empty">暂无未闭合分支</div>';
    refs.nextPromptsList.innerHTML = '<div class="prompt-item empty">等待会话给出下一步建议</div>';
    return;
  }

  renderEntityList(refs.conflictList, snapshot.contestedEntities || [], "当前还没有显性分歧");
  renderEntityList(refs.consensusList, snapshot.consensusEntities || [], "当前还没有稳定共识");

  refs.openBranchesList.innerHTML = (snapshot.openQuestions || []).length
    ? snapshot.openQuestions.map((item) => `<div class="insight-item">${escapeHtml(item)}</div>`).join("")
    : '<div class="insight-item empty">当前没有待澄清问题</div>';

  const promptSource = activeEvent()?.annotations?.next_prompts?.length
    ? activeEvent().annotations.next_prompts
    : snapshot.nextPrompts || [];
  refs.nextPromptsList.innerHTML = promptSource.length
    ? promptSource.map((item) => `<div class="prompt-item">${escapeHtml(item)}</div>`).join("")
    : '<div class="prompt-item empty">系统暂时没有额外建议，继续推进当前分支即可。</div>';
}

function renderAll() {
  updateQuickActions();
  updateFilterControls();
  renderConversationSpine();
  renderStage();
  renderInsights();
  updateMetricCards();
}

async function runPipelineAndRender() {
  const chunks = parseTranscriptLines(refs.transcriptInput.value);
  if (!chunks.length) {
    showToast("请先输入 transcript");
    return;
  }
  showToast("正在整理当前内容...");
  const payload = {
    chunks,
    realtime: refs.realtimeMode.value === "true",
    time_scale: Number(refs.timeScale.value || 1),
    base_wait_k: Number(refs.baseWaitK.value || 2),
    max_wait_k: Number(refs.maxWaitK.value || 4),
  };
  const data = await apiPost("/api/pipeline/run", payload);
  state.unifiedResult = null;
  refs.evalSummary.textContent = pretty({
    mode: data.result?.meta?.mode,
    updates_emitted: data.result?.summary?.updates_emitted,
    latency_e2e_ms: data.result?.summary?.latency_e2e_ms,
    boundary_distribution: data.result?.summary?.boundary_distribution,
  });
  ingestPipelineResult(data.result, null);
  setReportSummary({
    status: "result_ready_not_saved",
    source: "pipeline_run",
    updates_emitted: data.result?.summary?.updates_emitted,
  });
  showToast("整理完成");
}

async function runRealtimeEvaluation() {
  const chunks = parseTranscriptLines(refs.transcriptInput.value);
  if (!chunks.length) {
    showToast("请先输入 transcript");
    return;
  }
  showToast("正在生成系统评估...");
  const payload = {
    chunks,
    realtime: refs.realtimeMode.value === "true",
    time_scale: Number(refs.timeScale.value || 1),
    base_wait_k: Number(refs.baseWaitK.value || 2),
    max_wait_k: Number(refs.maxWaitK.value || 4),
    latency_p95_threshold_ms: 2000,
    flicker_mean_threshold: 6.0,
    mental_map_min: 0.85,
    intent_accuracy_threshold: 0.8,
  };
  const data = await apiPost("/api/pipeline/evaluate", payload);
  state.unifiedResult = null;
  refs.evalSummary.textContent = pretty(data.evaluation);
  ingestPipelineResult(data.pipeline, data.evaluation);
  setReportSummary({
    status: "result_ready_not_saved",
    source: "realtime_eval",
    realtime_eval_pass: data.evaluation?.realtime_eval_pass,
  });
  showToast(`系统评估完成: ${data.evaluation?.realtime_eval_pass ? "通过" : "未通过"}`);
}

async function runUnifiedEval() {
  if (!state.evaluationResult) {
    showToast("请先生成系统评估，再执行统一评测");
    return;
  }
  showToast("正在运行统一评测...");
  const payload = {
    dataset_dir: refs.datasetDir.value.trim(),
    max_files: Number(refs.maxFiles.value || 0),
    realtime_evaluation: state.evaluationResult,
  };
  const data = await apiPost("/api/pretrain/unified", payload);
  state.unifiedResult = data;
  refs.unifiedSummary.textContent = pretty(data);
  setReportSummary({
    status: "result_ready_not_saved",
    source: "unified_eval",
    recommendation: data.pretrain_readiness?.recommendation,
    score: data.pretrain_readiness?.overall_pretrain_readiness_score,
  });
  showToast(`统一评测完成: ${data.pretrain_readiness?.recommendation || "ok"}`);
}

async function createLiveSession() {
  if (state.live.sessionId) return state.live.sessionId;
  const payload = {
    min_wait_k: 1,
    base_wait_k: Number(refs.baseWaitK.value || 2),
    max_wait_k: Number(refs.maxWaitK.value || 4),
  };
  const data = await apiPost("/api/session/create", payload);
  state.live.sessionId = data.session_id;
  state.live.startWallMs = Date.now();
  setSessionStatus("进行中");
  ensurePipelineResultContainer();
  return data.session_id;
}

async function closeLiveSession() {
  if (!state.live.sessionId) return;
  try {
    await apiPost("/api/session/close", { session_id: state.live.sessionId });
  } catch (_err) {
    // ignore
  }
  state.live.sessionId = null;
  setSessionStatus("未启动");
}

async function sendLiveChunk(text) {
  const sessionId = await createLiveSession();
  const ts = Math.max(0, Date.now() - state.live.startWallMs);
  const data = await apiPost("/api/session/chunk", {
    session_id: sessionId,
    text,
    speaker: "expert",
    timestamp_ms: ts,
    is_final: true,
  });

  if (data.emitted_events?.length) {
    appendLiveEvents(data.emitted_events, data.session_summary || null);
  } else if (data.session_summary) {
    ensurePipelineResultContainer();
    state.pipelineResult.summary = { ...state.pipelineResult.summary, ...data.session_summary };
    syncPreparedState();
    renderAll();
  }

  refs.evalSummary.textContent = pretty({
    mode: "live_session",
    events_total: data.events_total,
    updates_emitted: data.session_summary?.updates_emitted,
    latency_e2e_ms: data.session_summary?.latency_e2e_ms,
    boundary_distribution: data.session_summary?.boundary_distribution,
  });
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function startMicrophoneCapture() {
  if (state.live.micActive) {
    showToast("麦克风已经在运行");
    return;
  }
  const SR = getSpeechRecognitionCtor();
  if (!SR) {
    showToast("当前浏览器不支持 Web Speech API");
    return;
  }

  await createLiveSession();
  state.live.micActive = true;
  setSessionStatus("正在听");
  appendLiveLog(`[system] mic started: ${new Date().toLocaleTimeString()}`);

  const rec = new SR();
  rec.lang = refs.speechLang.value || "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = (result[0]?.transcript || "").trim();
      if (!text) continue;
      if (result.isFinal) {
        appendLiveLog(`[final] ${text}`);
        state.live.sendQueue = state.live.sendQueue
          .then(() => sendLiveChunk(text))
          .catch((err) => showToast(`实时发送失败: ${err.message}`));
      } else {
        interim += `${text} `;
      }
    }
    if (interim) {
      setSessionStatus(`正在听 · ${interim.trim().slice(0, 18)}...`);
    }
  };

  rec.onerror = (event) => {
    appendLiveLog(`[error] ${event.error || "speech_error"}`);
    showToast(`语音识别错误: ${event.error || "unknown"}`);
  };

  rec.onend = () => {
    if (state.live.micActive) {
      try {
        rec.start();
      } catch (_err) {
        // ignore temporary failures
      }
    }
  };

  state.live.recognition = rec;
  try {
    rec.start();
  } catch (err) {
    state.live.micActive = false;
    showToast(`无法启动麦克风: ${err.message}`);
  }
}

function stopMicrophoneCapture(silent = false) {
  if (!state.live.micActive) {
    if (!silent) showToast("麦克风未运行");
    return;
  }
  state.live.micActive = false;
  if (state.live.recognition) {
    try {
      state.live.recognition.stop();
    } catch (_err) {
      // ignore
    }
  }
  setSessionStatus(state.live.sessionId ? "已暂停" : "未启动");
  appendLiveLog(`[system] mic stopped: ${new Date().toLocaleTimeString()}`);
}

async function flushLiveSessionAndEvaluate() {
  if (!state.live.sessionId) {
    showToast("没有活跃会话");
    return;
  }
  stopMicrophoneCapture(true);
  await state.live.sendQueue;
  showToast("正在结束会话...");

  const data = await apiPost("/api/session/flush", {
    session_id: state.live.sessionId,
    close_after_flush: true,
    latency_p95_threshold_ms: 2000,
    flicker_mean_threshold: 6.0,
    mental_map_min: 0.85,
    intent_accuracy_threshold: 0.8,
  });

  refs.evalSummary.textContent = pretty(data.evaluation || {});
  state.live.sessionId = null;
  setSessionStatus("未启动");
  ingestPipelineResult(data.pipeline, data.evaluation);
  setReportSummary({
    status: "result_ready_not_saved",
    source: "live_session_flush",
    realtime_eval_pass: data.evaluation?.realtime_eval_pass,
  });
  showToast(`会话已结束: ${data.evaluation?.realtime_eval_pass ? "系统通过检查" : "可继续优化"}`);
}

async function snapshotLiveSession() {
  if (!state.live.sessionId) {
    showToast("当前没有活跃会话");
    return;
  }
  await state.live.sendQueue;
  const data = await apiPost("/api/session/snapshot", {
    session_id: state.live.sessionId,
    include_evaluation: true,
    latency_p95_threshold_ms: 2000,
    flicker_mean_threshold: 6.0,
    mental_map_min: 0.85,
    intent_accuracy_threshold: 0.8,
  });
  refs.evalSummary.textContent = pretty(data.evaluation || {});
  ingestPipelineResult(data.pipeline, data.evaluation);
  showToast("进度已保存");
}

async function saveExperimentReport() {
  if (!state.pipelineResult && !state.live.sessionId) {
    showToast("还没有可导出的结果");
    return;
  }
  if (state.live.sessionId && !state.evaluationResult) {
    await snapshotLiveSession();
  }
  const payload = buildReportSavePayload();
  const data = await apiPost("/api/report/save", payload);
  setReportSummary({
    saved: true,
    files: data.files,
    summary: data.report?.summary || {},
  });
  await refreshReportList(8);
  showToast("报告已导出");
}

function stopPlayback() {
  if (state.playbackTimer) {
    clearInterval(state.playbackTimer);
    state.playbackTimer = null;
  }
}

function startPlayback() {
  const events = state.prepared?.events || [];
  if (!events.length) {
    showToast("没有可播放的事件");
    return;
  }
  stopPlayback();
  state.ui.viewMode = "replay";
  if (state.ui.currentFrameIndex >= events.length - 1) {
    state.ui.currentFrameIndex = 0;
  }
  state.ui.selection = {
    type: "event",
    eventIndex: state.ui.currentFrameIndex,
    nodeId: null,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  renderAll();
  state.playbackTimer = window.setInterval(() => {
    if (!state.prepared?.events?.length) {
      stopPlayback();
      return;
    }
    if (state.ui.currentFrameIndex >= state.prepared.events.length - 1) {
      stopPlayback();
      return;
    }
    state.ui.currentFrameIndex += 1;
    state.ui.selection = {
      type: "event",
      eventIndex: state.ui.currentFrameIndex,
      nodeId: null,
      conflictEntityId: null,
      relatedSpeakers: [],
    };
    renderAll();
  }, 900);
}

function resetPlayback() {
  stopPlayback();
  if (!state.prepared?.events?.length) return;
  state.ui.currentFrameIndex = 0;
  state.ui.selection = {
    type: "event",
    eventIndex: 0,
    nodeId: null,
    conflictEntityId: null,
    relatedSpeakers: [],
  };
  state.ui.viewMode = "replay";
  renderAll();
}

function bindEvents() {
  document.getElementById("btn-load-sample").addEventListener("click", () => {
    refs.transcriptInput.value = sampleTranscript;
    closeMoreActionsMenu();
    showToast("示例已加载");
  });
  refs.primaryAction.addEventListener("click", async () => {
    try {
      if (state.live.sessionId) {
        await flushLiveSessionAndEvaluate();
      } else {
        await runPipelineAndRender();
      }
    } catch (err) {
      showToast(`操作失败: ${err.message}`);
    }
  });
  refs.voiceAction.addEventListener("click", async () => {
    try {
      if (state.live.micActive) {
        stopMicrophoneCapture();
      } else {
        await startMicrophoneCapture();
      }
    } catch (err) {
      showToast(`语音操作失败: ${err.message}`);
    }
  });
  document.getElementById("btn-run-eval").addEventListener("click", async () => {
    try {
      await runRealtimeEvaluation();
      closeMoreActionsMenu();
    } catch (err) {
      showToast(`评测失败: ${err.message}`);
    }
  });
  document.getElementById("btn-unified-eval").addEventListener("click", async () => {
    try {
      await runUnifiedEval();
    } catch (err) {
      showToast(`统一评测失败: ${err.message}`);
    }
  });

  document.getElementById("btn-stop-mic").addEventListener("click", () => {
    stopMicrophoneCapture();
    closeMoreActionsMenu();
  });
  document.getElementById("btn-live-snapshot").addEventListener("click", async () => {
    try {
      await snapshotLiveSession();
      closeMoreActionsMenu();
    } catch (err) {
      showToast(`会话快照失败: ${err.message}`);
    }
  });
  document.getElementById("btn-save-report").addEventListener("click", async () => {
    try {
      await saveExperimentReport();
      closeMoreActionsMenu();
    } catch (err) {
      showToast(`保存报告失败: ${err.message}`);
    }
  });

  document.getElementById("btn-play").addEventListener("click", startPlayback);
  document.getElementById("btn-pause").addEventListener("click", stopPlayback);
  document.getElementById("btn-reset").addEventListener("click", resetPlayback);
  document.getElementById("btn-clear-focus").addEventListener("click", clearFocus);

  refs.btnViewWork.addEventListener("click", () => {
    state.ui.viewMode = "work";
    renderAll();
  });
  refs.btnViewPerspective.addEventListener("click", () => {
    state.ui.viewMode = "perspective";
    renderAll();
  });
  refs.btnViewReplay.addEventListener("click", () => {
    state.ui.viewMode = "replay";
    renderAll();
  });

  refs.speakerFilter.addEventListener("change", () => {
    state.ui.filters.speaker = refs.speakerFilter.value;
    renderConversationSpine();
  });
  refs.actionFilter.addEventListener("change", () => {
    state.ui.filters.action = refs.actionFilter.value;
    renderConversationSpine();
  });
  refs.scrubber.addEventListener("input", () => {
    if (!state.prepared?.events?.length) return;
    stopPlayback();
    state.ui.currentFrameIndex = Number(refs.scrubber.value || 0);
    state.ui.selection = {
      type: "event",
      eventIndex: state.ui.currentFrameIndex,
      nodeId: null,
      conflictEntityId: null,
      relatedSpeakers: [],
    };
    renderAll();
  });
}

async function boot() {
  initSVG();
  refs.transcriptInput.value = sampleTranscript;
  refs.evalSummary.textContent = "{}";
  refs.unifiedSummary.textContent = "{}";
  refs.reportSummary.textContent = "{}";
  refs.liveTranscriptLog.value = "";
  setSessionStatus("未启动");
  bindEvents();
  renderAll();

  try {
    const resp = await fetch("/api/config");
    const conf = await resp.json();
    if (conf.ok && conf.default_dataset_dir) {
      refs.datasetDir.value = conf.default_dataset_dir;
    }
  } catch (_err) {
    showToast("配置读取失败，使用默认参数");
  }
  try {
    await refreshReportList(8);
  } catch (_err) {
    setReportSummary({ warning: "report_list_unavailable" });
  }
}

boot();
