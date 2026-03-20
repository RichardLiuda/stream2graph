"use client";

export type InputSource =
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

export function getSystemAudioExperimentalLabel(context: ClientAudioContext | null) {
  if (!context) return "系统声音（实验性）";
  if (context.platform === "macos") return "共享标签页/共享屏幕音频（实验性）";
  return "系统声音（实验性）";
}

export function supportsSystemAudioUi(context: ClientAudioContext | null) {
  if (!context) return false;
  return context.is_desktop && (context.browser_family === "chrome" || context.browser_family === "edge");
}

export function getSystemAudioUnavailableReason(context: ClientAudioContext | null) {
  if (!context) return "正在检测浏览器与平台能力。";
  if (!context.is_desktop) return "移动端不支持系统声音采集。";
  if (context.browser_family === "safari" || context.browser_family === "firefox") {
    return "当前仅计划在桌面 Chrome/Edge 上支持系统声音采集。";
  }
  if (context.browser_family === "other") {
    return "当前浏览器不在正式支持范围内。";
  }
  return "当前浏览器环境未开放系统声音能力。";
}

export function getInputSourceOptions(context: ClientAudioContext | null): InputSourceOption[] {
  const transcriptOption: InputSourceOption = {
    source: "transcript",
    label: "Transcript 输入",
    description: "最稳定的输入方式，适合演示、回放和手工控制节奏。",
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: "始终可用。",
  };

  const microphoneOption: InputSourceOption = {
    source: "microphone_browser",
    label: "浏览器麦克风",
    description: "使用浏览器自带语音识别服务，适合快速验证。",
    capture_mode: "browser_speech",
    capability_status: context?.supports_speech_recognition ? "supported" : "limited",
    capability_reason: context?.supports_speech_recognition
      ? "当前浏览器支持 Web Speech API。"
      : "当前浏览器不支持或不稳定支持 Web Speech API。",
  };

  const options: InputSourceOption[] = [transcriptOption, microphoneOption];

  if (supportsSystemAudioUi(context)) {
    options.push({
      source: "system_audio_browser_experimental",
      label: getSystemAudioExperimentalLabel(context),
      description: "只做浏览器原生能力验证，不承诺稳定转成文本。",
      capture_mode: "browser_display_audio",
      capability_status: context?.supports_display_audio ? "limited" : "unsupported",
      capability_reason: context?.supports_display_audio
        ? "浏览器支持共享音频流，但当前版本仅用于验证可达性。"
        : "当前浏览器不支持共享音频采集。",
    });
    options.push({
      source: "system_audio_helper",
      label: "系统声音（增强模式）",
      description: "通过本地辅助层桥接系统声音，是正式交付目标路线。",
      capture_mode: "helper_native_capture",
      capability_status: "limited",
      capability_reason: "需要本机启动 audio helper，并接入原生采集驱动。",
    });
  }

  return options;
}

export function getSpeechRecognitionErrorMessage(errorCode?: string) {
  switch (errorCode) {
    case "network":
      return "浏览器语音识别服务当前不可用。通常是网络、浏览器服务连接或地区环境导致。你可以先改用 Transcript 输入。";
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未开启，或浏览器禁止了语音识别服务。请检查站点权限后重试。";
    case "audio-capture":
      return "没有检测到可用麦克风设备。请确认系统输入设备和浏览器权限。";
    case "no-speech":
      return "没有检测到有效语音输入。请靠近麦克风后重试。";
    case "aborted":
      return "语音识别已中断。";
    case "language-not-supported":
      return "当前浏览器不支持所选语音识别语言。";
    default:
      return "语音识别失败。你可以先改用 Transcript 输入。";
  }
}

export function getDisplayAudioErrorMessage(errorName?: string) {
  switch (errorName) {
    case "NotAllowedError":
      return "你取消了共享音频，或浏览器没有获得共享权限。";
    case "NotFoundError":
      return "当前浏览器没有提供可共享的音频来源。";
    case "AbortError":
      return "共享音频流程被中断。";
    case "NotReadableError":
      return "浏览器无法读取共享音频。请检查系统权限和浏览器状态。";
    default:
      return "无法开始共享音频验证。你可以先改用 Transcript 输入，或尝试增强模式。";
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
      params.selectedSource === "transcript"
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
