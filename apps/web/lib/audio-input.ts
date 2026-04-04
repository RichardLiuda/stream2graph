"use client";

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

/** 实验性「共享屏幕 / 标签页音频」采集入口，仅在桌面 Chrome / Edge 展示。 */
export function supportsSystemAudioExperimentalUi(context: ClientAudioContext | null) {
  if (!context) return false;
  return context.is_desktop && (context.browser_family === "chrome" || context.browser_family === "edge");
}

/** 与 {@link supportsSystemAudioExperimentalUi} 等价，保留旧导出名。 */
export function supportsSystemAudioUi(context: ClientAudioContext | null) {
  return supportsSystemAudioExperimentalUi(context);
}

/** 桌面端可展示「增强模式」（本机 helper）；与浏览器是否为 Chrome/Edge 无关。 */
export function supportsHelperSystemAudioUi(context: ClientAudioContext | null) {
  return Boolean(context?.is_desktop);
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
  const demoOption: InputSourceOption = {
    source: "demo_mode",
    label: "演示模式",
    description: "默认载入 4 组来自公开访谈与活动通知的真实演示脚本，适合快速成图、多画布切换和不同图型展示。",
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: "始终可用。",
  };

  const transcriptOption: InputSourceOption = {
    source: "transcript",
    label: "打字输入",
    description: "自己打字，最稳定，适合演示和慢慢试。",
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: "始终可用。",
  };

  const microphoneOption: InputSourceOption = {
    source: "microphone_browser",
    label: "浏览器麦克风",
    description: "用麦克风，由浏览器听写，适合快速试一下。",
    capture_mode: "browser_speech",
    capability_status: context?.supports_speech_recognition ? "supported" : "limited",
    capability_reason: context?.supports_speech_recognition
      ? "当前浏览器支持 Web Speech API。"
      : "当前浏览器不支持或不稳定支持 Web Speech API。",
  };

  const options: InputSourceOption[] = [demoOption, transcriptOption, microphoneOption];

  if (supportsSystemAudioExperimentalUi(context)) {
    options.push({
      source: "system_audio_browser_experimental",
      label: getSystemAudioExperimentalLabel(context),
      description: "只检查能不能抓到共享声音，不保证能稳定转成文字。",
      capture_mode: "browser_display_audio",
      capability_status: context?.supports_display_audio ? "limited" : "unsupported",
      capability_reason: context?.supports_display_audio
        ? "浏览器支持共享音频流，但当前版本仅用于验证可达性。"
        : "当前浏览器不支持共享音频采集。",
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
      label: "系统声音（增强模式）",
      description: "用本机小助手接收系统声音并在电脑里转成文字，推荐正式使用。",
      capture_mode: "helper_native_capture",
      capability_status: "limited",
      capability_reason: nonChromeEdgeDesktop
        ? "需要本机启动 audio helper。实验性共享音频验证入口仅在 Chrome / Edge 提供。"
        : "需要本机启动 audio helper，并准备好本地转写依赖。",
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
