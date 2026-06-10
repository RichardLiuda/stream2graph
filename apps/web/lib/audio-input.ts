"use client";

import { translate, type I18nKey, type LanguagePreference } from "@/lib/language";

export type InputSource =
  | "demo_mode"
  | "transcript"
  | "microphone_browser"
  | "system_audio_browser_experimental"
  | "system_audio_helper";

export type PlatformFamily = "macos" | "windows" | "linux" | "other";
export type BrowserFamily = "chrome" | "edge" | "safari" | "firefox" | "other";
export type CapabilityStatus = "supported" | "limited" | "unsupported";
export type CaptureMode = "manual_text" | "browser_speech" | "browser_display_audio" | "helper_native_capture";

export interface ClientAudioContext {
  platform: PlatformFamily;
  browser_family: BrowserFamily;
  is_desktop: boolean;
  supports_speech_recognition: boolean;
  supports_display_audio: boolean;
}

export interface InputSourceOption {
  source: InputSource;
  label: string;
  description: string;
  capture_mode: CaptureMode;
  capability_status: CapabilityStatus;
  capability_reason: string;
}

function t(language: LanguagePreference, key: I18nKey) {
  return translate(language, key);
}

function detectPlatform(ua: string): PlatformFamily {
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

function detectBrowser(ua: string): BrowserFamily {
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "safari";
  return "other";
}

export function detectClientAudioContext(): ClientAudioContext {
  const ua = window.navigator.userAgent;
  const supportsSpeechRecognition = Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const supportsDisplayAudio = Boolean(window.navigator.mediaDevices?.getDisplayMedia);

  return {
    platform: detectPlatform(ua),
    browser_family: detectBrowser(ua),
    is_desktop: !/Android|iPhone|iPad|Mobile/.test(ua),
    supports_speech_recognition: supportsSpeechRecognition,
    supports_display_audio: supportsDisplayAudio,
  };
}

export function getSystemAudioExperimentalLabel(
  context: ClientAudioContext | null,
  language: LanguagePreference = "zh-CN",
) {
  if (!context) {
    return t(language, "audioInput.text001");
  }
  if (context.platform === "macos") {
    return t(language, "audioInput.text002");
  }
  return t(language, "audioInput.text001");
}

/** 实验性「共享屏幕 / 标签页音频」采集入口，仅在桌面 Chrome / Edge 展示。 */
export function supportsSystemAudioExperimentalUi(context: ClientAudioContext | null) {
  if (!context) return false;
  return context.is_desktop && (context.browser_family === "chrome" || context.browser_family === "edge");
}

/** 与 {@link supportsSystemAudioExperimentalUi} 等价，保留旧导出名。 */
export function supportsSystemAudioUi(context: ClientAudioContext | null) {
  return supportsSystemAudioExperimentalUi(context);
}

/** 桌面端可展示「本机内录转写」（本机 helper）；与浏览器是否为 Chrome/Edge 无关。 */
export function supportsHelperSystemAudioUi(context: ClientAudioContext | null) {
  return Boolean(context?.is_desktop);
}

export function getSystemAudioUnavailableReason(
  context: ClientAudioContext | null,
  language: LanguagePreference = "zh-CN",
) {
  if (!context) {
    return t(language, "audioInput.text003");
  }
  if (!context.is_desktop) {
    return t(language, "audioInput.text004");
  }
  if (context.browser_family === "safari" || context.browser_family === "firefox") {
    return t(language, "audioInput.text005");
  }
  if (context.browser_family === "other") {
    return t(language, "audioInput.text006");
  }
  return t(language, "audioInput.text007");
}

export function getInputSourceOptions(
  context: ClientAudioContext | null,
  language: LanguagePreference = "zh-CN",
): InputSourceOption[] {
  const demoOption: InputSourceOption = {
    source: "demo_mode",
    label: t(language, "audioInput.text008"),
    description: t(language, "audioInput.text009"),
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: t(language, "audioInput.text010"),
  };

  const transcriptOption: InputSourceOption = {
    source: "transcript",
    label: t(language, "audioInput.text011"),
    description: t(language, "audioInput.text012"),
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: t(language, "audioInput.text010"),
  };

  const microphoneOption: InputSourceOption = {
    source: "microphone_browser",
    label: t(language, "audioInput.text013"),
    description: t(language, "audioInput.text014"),
    capture_mode: "browser_speech",
    capability_status: context?.supports_speech_recognition ? "supported" : "limited",
    capability_reason: context?.supports_speech_recognition
      ? t(language, "audioInput.text015")
      : t(language, "audioInput.text016"),
  };

  const options: InputSourceOption[] = [microphoneOption, demoOption, transcriptOption];

  if (supportsSystemAudioExperimentalUi(context)) {
    options.push({
      source: "system_audio_browser_experimental",
      label: getSystemAudioExperimentalLabel(context, language),
      description: t(language, "audioInput.text017"),
      capture_mode: "browser_display_audio",
      capability_status: context?.supports_display_audio ? "limited" : "unsupported",
      capability_reason: context?.supports_display_audio
        ? t(language, "audioInput.text018")
        : t(language, "audioInput.text019"),
    });
  }

  if (supportsHelperSystemAudioUi(context)) {
    const nonChromeEdgeDesktop =
      context &&
      (context.browser_family === "safari" ||
        context.browser_family === "firefox" ||
        context.browser_family === "other");
    options.push({
      source: "system_audio_helper",
      label: t(language, "audioInput.text020"),
      description: t(language, "audioInput.text021"),
      capture_mode: "helper_native_capture",
      capability_status: "limited",
      capability_reason: nonChromeEdgeDesktop
        ? t(language, "audioInput.text022")
        : t(language, "audioInput.text023"),
    });
  }

  return options;
}

export function getSpeechRecognitionErrorMessage(errorCode?: string, language: LanguagePreference = "zh-CN") {
  switch (errorCode) {
    case "network":
      return t(language, "audioInput.text024");
    case "not-allowed":
    case "service-not-allowed":
      return t(language, "audioInput.text025");
    case "audio-capture":
      return t(language, "audioInput.text026");
    case "no-speech":
      return t(language, "audioInput.text027");
    case "aborted":
      return t(language, "audioInput.text028");
    case "language-not-supported":
      return t(language, "audioInput.text029");
    default:
      return t(language, "audioInput.text030");
  }
}

export function getDisplayAudioErrorMessage(errorName?: string, language: LanguagePreference = "zh-CN") {
  switch (errorName) {
    case "NotAllowedError":
      return t(language, "audioInput.text031");
    case "NotFoundError":
      return t(language, "audioInput.text032");
    case "AbortError":
      return t(language, "audioInput.text033");
    case "NotReadableError":
      return t(language, "audioInput.text034");
    default:
      return t(language, "audioInput.text035");
  }
}

export function buildRealtimeClientContext(params: {
  selectedSource: InputSource;
  context: ClientAudioContext | null;
  capabilityStatus: CapabilityStatus;
  capabilityReason: string;
  helperAvailable: boolean;
}) {
  return {
    input_source: params.selectedSource,
    capture_mode:
      params.selectedSource === "demo_mode" || params.selectedSource === "transcript"
        ? "manual_text"
        : params.selectedSource === "microphone_browser"
          ? "browser_speech"
          : params.selectedSource === "system_audio_browser_experimental"
            ? "browser_display_audio"
            : "helper_native_capture",
    platform: params.context?.platform ?? "other",
    browser_family: params.context?.browser_family ?? "other",
    capability_status: params.capabilityStatus,
    capability_reason: params.capabilityReason,
    helper_available: params.helperAvailable,
  };
}
