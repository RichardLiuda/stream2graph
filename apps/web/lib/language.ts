"use client";

import { useCallback, useEffect, useState } from "react";

import { TRANSLATIONS, type I18nKey } from "@/locales";

export type LanguagePreference = "zh-CN" | "en-US" | "es-ES" | "pt-BR" | "de-DE" | "ja-JP";

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

function formatTranslation(template: string, params?: Record<string, string | number>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value == null ? match : String(value);
  });
}

export function translate(
  language: LanguagePreference,
  key: I18nKey,
  params?: Record<string, string | number>,
) {
  const table = TRANSLATIONS[language] ?? TRANSLATIONS[DEFAULT_LANGUAGE];
  const fallback = TRANSLATIONS[DEFAULT_LANGUAGE][key] ?? key;
  return formatTranslation(table[key] ?? fallback, params);
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

export function useI18n() {
  const [language, setLanguage] = useLanguagePreference();
  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  );

  return { language, setLanguage, t } as const;
}

export type { I18nKey };
