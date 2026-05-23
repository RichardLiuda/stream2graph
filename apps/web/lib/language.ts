"use client";

import { useEffect, useState } from "react";

export type LanguagePreference = "zh-CN" | "en-US" | "es-ES" | "pt-BR" | "de-DE" | "ja-JP";

export type LocalizedText = {
  zh: string;
  en: string;
  es: string;
  pt: string;
  de: string;
  ja: string;
};

export const DEFAULT_LANGUAGE: LanguagePreference = "zh-CN";

export const LANGUAGE_OPTIONS: Array<{
  value: LanguagePreference;
  label: string;
  nativeLabel: string;
}> = [
  { value: "zh-CN", label: "Chinese", nativeLabel: "中文" },
  { value: "en-US", label: "English", nativeLabel: "English" },
  { value: "es-ES", label: "Spanish", nativeLabel: "Español" },
  { value: "pt-BR", label: "Portuguese", nativeLabel: "Português" },
  { value: "de-DE", label: "German", nativeLabel: "Deutsch" },
  { value: "ja-JP", label: "Japanese", nativeLabel: "日本語" },
];

const STORAGE_KEY = "s2g:language-preference";
const CHANGE_EVENT = "s2g:language-preference-change";

function normalizeLanguage(value: unknown): LanguagePreference {
  if (
    value === "zh-CN" ||
    value === "en-US" ||
    value === "es-ES" ||
    value === "pt-BR" ||
    value === "de-DE" ||
    value === "ja-JP"
  ) {
    return value;
  }
  return DEFAULT_LANGUAGE;
}

export function languageText(language: LanguagePreference, copy: LocalizedText) {
  switch (language) {
    case "en-US":
      return copy.en;
    case "es-ES":
      return copy.es;
    case "pt-BR":
      return copy.pt;
    case "de-DE":
      return copy.de;
    case "ja-JP":
      return copy.ja;
    default:
      return copy.zh;
  }
}

export function loadLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
}

export function saveLanguagePreference(language: LanguagePreference) {
  if (typeof window === "undefined") return;
  const normalized = normalizeLanguage(language);
  window.localStorage.setItem(STORAGE_KEY, normalized);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { language: normalized } }));
}

export function useLanguagePreference() {
  const [language, setLanguageState] = useState<LanguagePreference>(DEFAULT_LANGUAGE);

  useEffect(() => {
    setLanguageState(loadLanguagePreference());

    const onLanguageChange = (event: Event) => {
      const next =
        event instanceof CustomEvent
          ? normalizeLanguage((event.detail as { language?: unknown } | null)?.language)
          : loadLanguagePreference();
      setLanguageState(next);
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setLanguageState(normalizeLanguage(event.newValue));
    };

    window.addEventListener(CHANGE_EVENT, onLanguageChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onLanguageChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setLanguage = (next: LanguagePreference) => {
    const normalized = normalizeLanguage(next);
    setLanguageState(normalized);
    saveLanguagePreference(normalized);
  };

  return [language, setLanguage] as const;
}
