import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { esES } from "./es-ES";
import { ptBR } from "./pt-BR";
import { deDE } from "./de-DE";
import { jaJP } from "./ja-JP";

type LocaleCode = "zh-CN" | "en-US" | "es-ES" | "pt-BR" | "de-DE" | "ja-JP";

export type I18nKey = keyof typeof zhCN;

type TranslationTable = Record<I18nKey, string>;

export const TRANSLATIONS = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "es-ES": esES,
  "pt-BR": ptBR,
  "de-DE": deDE,
  "ja-JP": jaJP,
} satisfies Record<LocaleCode, TranslationTable>;
