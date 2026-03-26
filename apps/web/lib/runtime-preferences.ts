"use client";

export type RuntimeProfileOption = {
  id: string;
  models: string[];
  default_model?: string | null;
};

export type RuntimeOptionsPayload = {
  llm_profiles: RuntimeProfileOption[];
  stt_profiles: RuntimeProfileOption[];
};

export type RuntimePreferences = {
  llmProfileId: string;
  llmModel: string;
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
    return JSON.parse(raw) as Partial<RuntimePreferences>;
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
  const llmProfile =
    options.llm_profiles.find((item) => item.id === seed?.llmProfileId) || options.llm_profiles[0];
  const sttProfile =
    options.stt_profiles.find((item) => item.id === seed?.sttProfileId) || options.stt_profiles[0];

  return {
    llmProfileId: llmProfile?.id || "",
    llmModel: pickModel(llmProfile, seed?.llmModel),
    sttProfileId: sttProfile?.id || "",
    sttModel: pickModel(sttProfile, seed?.sttModel),
    diagramMode: seed?.diagramMode === "dual_view" ? "dual_view" : "mermaid_primary",
  };
}
