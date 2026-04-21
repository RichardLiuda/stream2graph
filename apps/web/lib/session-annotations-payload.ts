import type { AnnotationEraseMaskStroke, AnnotationItem, AnnotationPayload } from "@/components/annotation-layer";
import { normalizeMaskStrokes } from "@/components/annotation-layer";

export type SessionAnnotationsPayload = {
  mermaid: AnnotationPayload;
  structure: AnnotationPayload;
};

const emptyPayload = (): AnnotationPayload => ({ items: [], maskStrokes: [] });

function canvasPayloadFromRaw(m: Record<string, unknown>): AnnotationPayload {
  const items = Array.isArray(m.items) ? (m.items as AnnotationItem[]) : [];
  const maskStrokesRaw = m.maskStrokes;
  const eraseRaw = m.eraseMaskPaths;
  const maskStrokes = normalizeMaskStrokes({
    items,
    maskStrokes: Array.isArray(maskStrokesRaw) ? (maskStrokesRaw as AnnotationPayload["maskStrokes"]) : undefined,
    eraseMaskPaths: Array.isArray(eraseRaw) ? (eraseRaw as AnnotationEraseMaskStroke[]) : undefined,
  });
  return { items, maskStrokes };
}

/** 将服务端 / 旧版 payload 规范为「主图 + 结构」双画布 */
export function normalizeSessionAnnotationsPayload(raw: unknown): SessionAnnotationsPayload {
  if (!raw || typeof raw !== "object") {
    return { mermaid: emptyPayload(), structure: emptyPayload() };
  }
  const r = raw as Record<string, unknown>;
  if (r.mermaid && typeof r.mermaid === "object" && r.structure && typeof r.structure === "object") {
    const m = r.mermaid as Record<string, unknown>;
    const s = r.structure as Record<string, unknown>;
    return {
      mermaid: canvasPayloadFromRaw(m),
      structure: canvasPayloadFromRaw(s),
    };
  }
  const legacyItems = Array.isArray(r.items) ? (r.items as AnnotationItem[]) : [];
  const legacyMask = Array.isArray(r.eraseMaskPaths) ? (r.eraseMaskPaths as AnnotationEraseMaskStroke[]) : [];
  return {
    mermaid: {
      items: legacyItems,
      maskStrokes: normalizeMaskStrokes({ eraseMaskPaths: legacyMask }),
    },
    structure: emptyPayload(),
  };
}
