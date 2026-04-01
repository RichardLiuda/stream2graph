"use client";

export type RuntimeProfileOption = {
  id: string;
  models: string[];
  default_model?: string | null;
};

export type RuntimeOptionsPayload = {
  gate_profiles: RuntimeProfileOption[];
  planner_profiles: RuntimeProfileOption[];
  stt_profiles: RuntimeProfileOption[];
};

export type RuntimePreferences = {
  gateProfileId: string;
  gateModel: string;
  plannerProfileId: string;
  plannerModel: string;
  sttProfileId: string;
  sttModel: string;
  diagramMode: "mermaid_primary" | "dual_view";
};

const STORAGE_KEY = "s2g:runtime-preferences";

function pickModel(profile: RuntimeProfileOption | undefined, requested: string | null | undefined) {
  if (!profile) return "";
  if (requested && profile.models.includes(requested)) return requested;
  return profile.default_model || profile.models[0] || "";
}

export function loadRuntimePreferences() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Partial<RuntimePreferences>;
  } catch {
    return null;
  }
}

export function saveRuntimePreferences(preferences: RuntimePreferences) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function resolveRuntimePreferences(
  options: RuntimeOptionsPayload,
  seed?: Partial<RuntimePreferences> | null,
): RuntimePreferences {
  const safeSeed = seed ?? {};
  const legacySeed = safeSeed as Partial<RuntimePreferences> & {
    llmProfileId?: string;
    llmModel?: string;
  };
  const gateSeedId = safeSeed.gateProfileId || legacySeed.llmProfileId;
  const gateSeedModel = safeSeed.gateModel || legacySeed.llmModel;
  const plannerSeedId = safeSeed.plannerProfileId || legacySeed.llmProfileId;
  const plannerSeedModel = safeSeed.plannerModel || legacySeed.llmModel;
  const gateProfile =
    options.gate_profiles.find((item) => item.id === gateSeedId) || options.gate_profiles[0];
  const plannerProfile =
    options.planner_profiles.find((item) => item.id === plannerSeedId) || options.planner_profiles[0];
  const sttProfile =
    options.stt_profiles.find((item) => item.id === safeSeed.sttProfileId) || options.stt_profiles[0];

  return {
    gateProfileId: gateProfile?.id || "",
    gateModel: pickModel(gateProfile, gateSeedModel),
    plannerProfileId: plannerProfile?.id || "",
    plannerModel: pickModel(plannerProfile, plannerSeedModel),
    sttProfileId: sttProfile?.id || "",
    sttModel: pickModel(sttProfile, safeSeed.sttModel),
    diagramMode: safeSeed.diagramMode === "dual_view" ? "dual_view" : "mermaid_primary",
  };
}
