"use client";

import { languageText, type LanguagePreference, type LocalizedText } from "@/lib/language";

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

function t(language: LanguagePreference, copy: LocalizedText) {
  return languageText(language, copy);
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
    return t(language, {
      zh: "系统声音（实验性）",
      en: "System Audio (experimental)",
      es: "Audio del sistema (experimental)",
      pt: "Áudio do sistema (experimental)",
      de: "Systemaudio (experimentell)",
      ja: "システム音声（実験的）",
    });
  }
  if (context.platform === "macos") {
    return t(language, {
      zh: "共享标签页/共享屏幕音频（实验性）",
      en: "Shared Tab / Screen Audio (experimental)",
      es: "Audio de pestaña / pantalla compartida (experimental)",
      pt: "Áudio de aba / tela compartilhada (experimental)",
      de: "Audio von geteiltem Tab / Bildschirm (experimentell)",
      ja: "共有タブ / 画面音声（実験的）",
    });
  }
  return t(language, {
    zh: "系统声音（实验性）",
    en: "System Audio (experimental)",
    es: "Audio del sistema (experimental)",
    pt: "Áudio do sistema (experimental)",
    de: "Systemaudio (experimentell)",
    ja: "システム音声（実験的）",
  });
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
    return t(language, {
      zh: "正在检测浏览器与平台能力。",
      en: "Detecting browser and platform capabilities.",
      es: "Detectando capacidades del navegador y la plataforma.",
      pt: "Detectando capacidades do navegador e da plataforma.",
      de: "Browser- und Plattformfunktionen werden erkannt.",
      ja: "ブラウザとプラットフォームの機能を確認しています。",
    });
  }
  if (!context.is_desktop) {
    return t(language, {
      zh: "移动端不支持系统声音采集。",
      en: "System audio capture is not available on mobile.",
      es: "La captura de audio del sistema no está disponible en móviles.",
      pt: "A captura de áudio do sistema não está disponível em dispositivos móveis.",
      de: "Systemaudioaufnahme ist auf Mobilgeräten nicht verfügbar.",
      ja: "モバイルではシステム音声のキャプチャを利用できません。",
    });
  }
  if (context.browser_family === "safari" || context.browser_family === "firefox") {
    return t(language, {
      zh: "当前仅计划在桌面 Chrome/Edge 上支持系统声音采集。",
      en: "System audio capture is currently planned for desktop Chrome/Edge only.",
      es: "La captura de audio del sistema solo está prevista para Chrome/Edge de escritorio.",
      pt: "A captura de áudio do sistema está prevista apenas para Chrome/Edge no desktop.",
      de: "Systemaudioaufnahme ist derzeit nur für Desktop-Chrome/Edge vorgesehen.",
      ja: "システム音声キャプチャは現在、デスクトップ版 Chrome/Edge のみを想定しています。",
    });
  }
  if (context.browser_family === "other") {
    return t(language, {
      zh: "当前浏览器不在正式支持范围内。",
      en: "This browser is outside the supported range.",
      es: "Este navegador está fuera del rango compatible.",
      pt: "Este navegador está fora da faixa suportada.",
      de: "Dieser Browser liegt außerhalb des unterstützten Bereichs.",
      ja: "このブラウザは正式なサポート範囲外です。",
    });
  }
  return t(language, {
    zh: "当前浏览器环境未开放系统声音能力。",
    en: "System audio capture is not exposed in this browser environment.",
    es: "La captura de audio del sistema no está expuesta en este navegador.",
    pt: "A captura de áudio do sistema não está exposta neste navegador.",
    de: "Systemaudioaufnahme ist in dieser Browserumgebung nicht freigegeben.",
    ja: "このブラウザ環境ではシステム音声キャプチャが公開されていません。",
  });
}

export function getInputSourceOptions(
  context: ClientAudioContext | null,
  language: LanguagePreference = "zh-CN",
): InputSourceOption[] {
  const demoOption: InputSourceOption = {
    source: "demo_mode",
    label: t(language, {
      zh: "演示模式",
      en: "Demo Mode",
      es: "Modo demo",
      pt: "Modo demo",
      de: "Demo-Modus",
      ja: "デモモード",
    }),
    description: t(language, {
      zh: "默认载入 6 组基于公开访谈、办事指南和活动通知整理的中文演示脚本，直接用文本完成成图演示。",
      en: "Load six prepared Chinese demo scripts based on public interviews, service guides, and event notices, then generate the graph from text.",
      es: "Carga seis guiones de demostración en chino basados en entrevistas públicas, guías de servicios y avisos de eventos, y genera el gráfico desde texto.",
      pt: "Carrega seis roteiros de demonstração em chinês baseados em entrevistas públicas, guias de serviço e avisos de eventos, e gera o grafo a partir do texto.",
      de: "Lädt sechs vorbereitete chinesische Demo-Skripte aus öffentlichen Interviews, Serviceleitfäden und Veranstaltungsmitteilungen und erzeugt daraus das Diagramm.",
      ja: "公開インタビュー、手続きガイド、イベント通知をもとにした中国語デモ台本を6件読み込み、テキストからグラフを生成します。",
    }),
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: t(language, {
      zh: "始终可用。",
      en: "Always available.",
      es: "Siempre disponible.",
      pt: "Sempre disponível.",
      de: "Immer verfügbar.",
      ja: "常に利用できます。",
    }),
  };

  const transcriptOption: InputSourceOption = {
    source: "transcript",
    label: t(language, {
      zh: "打字输入",
      en: "Typed Input",
      es: "Entrada escrita",
      pt: "Entrada digitada",
      de: "Texteingabe",
      ja: "テキスト入力",
    }),
    description: t(language, {
      zh: "自己打字，最稳定，适合演示和慢慢试。",
      en: "Type the transcript yourself. This is the most stable mode for demos and careful trials.",
      es: "Escribe la transcripción manualmente. Es el modo más estable para demos y pruebas cuidadosas.",
      pt: "Digite a transcrição manualmente. É o modo mais estável para demos e testes cuidadosos.",
      de: "Transkript selbst eingeben. Das ist der stabilste Modus für Demos und sorgfältige Tests.",
      ja: "自分で文字起こしを入力します。デモや丁寧な検証に最も安定したモードです。",
    }),
    capture_mode: "manual_text",
    capability_status: "supported",
    capability_reason: t(language, {
      zh: "始终可用。",
      en: "Always available.",
      es: "Siempre disponible.",
      pt: "Sempre disponível.",
      de: "Immer verfügbar.",
      ja: "常に利用できます。",
    }),
  };

  const microphoneOption: InputSourceOption = {
    source: "microphone_browser",
    label: t(language, {
      zh: "浏览器麦克风",
      en: "Browser Microphone",
      es: "Micrófono del navegador",
      pt: "Microfone do navegador",
      de: "Browser-Mikrofon",
      ja: "ブラウザマイク",
    }),
    description: t(language, {
      zh: "用麦克风，由浏览器听写，适合快速试一下。",
      en: "Use the microphone with browser dictation for quick trials.",
      es: "Usa el micrófono con dictado del navegador para pruebas rápidas.",
      pt: "Use o microfone com ditado do navegador para testes rápidos.",
      de: "Mikrofon mit Browser-Diktat für schnelle Tests verwenden.",
      ja: "マイクとブラウザの音声入力を使って素早く試せます。",
    }),
    capture_mode: "browser_speech",
    capability_status: context?.supports_speech_recognition ? "supported" : "limited",
    capability_reason: context?.supports_speech_recognition
      ? t(language, {
          zh: "当前浏览器支持 Web Speech API。",
          en: "This browser supports the Web Speech API.",
          es: "Este navegador admite la Web Speech API.",
          pt: "Este navegador oferece suporte à Web Speech API.",
          de: "Dieser Browser unterstützt die Web Speech API.",
          ja: "このブラウザは Web Speech API に対応しています。",
        })
      : t(language, {
          zh: "当前浏览器不支持或不稳定支持 Web Speech API。",
          en: "This browser does not support the Web Speech API reliably.",
          es: "Este navegador no admite la Web Speech API de forma fiable.",
          pt: "Este navegador não oferece suporte confiável à Web Speech API.",
          de: "Dieser Browser unterstützt die Web Speech API nicht zuverlässig.",
          ja: "このブラウザは Web Speech API の対応が不安定、または非対応です。",
        }),
  };

  const options: InputSourceOption[] = [demoOption, transcriptOption, microphoneOption];

  if (supportsSystemAudioExperimentalUi(context)) {
    options.push({
      source: "system_audio_browser_experimental",
      label: getSystemAudioExperimentalLabel(context, language),
      description: t(language, {
        zh: "只检查能不能抓到共享声音，不保证能稳定转成文字。",
        en: "Checks whether shared audio can be captured. Stable transcription is not guaranteed.",
        es: "Comprueba si se puede capturar audio compartido. No garantiza una transcripción estable.",
        pt: "Verifica se o áudio compartilhado pode ser capturado. A transcrição estável não é garantida.",
        de: "Prüft, ob geteiltes Audio erfasst werden kann. Eine stabile Transkription ist nicht garantiert.",
        ja: "共有音声を取得できるか確認します。安定した文字起こしは保証されません。",
      }),
      capture_mode: "browser_display_audio",
      capability_status: context?.supports_display_audio ? "limited" : "unsupported",
      capability_reason: context?.supports_display_audio
        ? t(language, {
            zh: "浏览器支持共享音频流，但当前版本仅用于验证可达性。",
            en: "The browser supports shared audio streams, but this version only verifies reachability.",
            es: "El navegador admite flujos de audio compartido, pero esta versión solo verifica la disponibilidad.",
            pt: "O navegador suporta fluxos de áudio compartilhado, mas esta versão apenas verifica a disponibilidade.",
            de: "Der Browser unterstützt geteilte Audiostreams, aber diese Version prüft nur die Erreichbarkeit.",
            ja: "ブラウザは共有音声ストリームに対応していますが、この版では到達性の確認のみ行います。",
          })
        : t(language, {
            zh: "当前浏览器不支持共享音频采集。",
            en: "This browser does not support shared audio capture.",
            es: "Este navegador no admite la captura de audio compartido.",
            pt: "Este navegador não oferece suporte à captura de áudio compartilhado.",
            de: "Dieser Browser unterstützt keine Aufnahme von geteiltem Audio.",
            ja: "このブラウザは共有音声キャプチャに対応していません。",
          }),
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
      label: t(language, {
        zh: "本机内录转写",
        en: "Local System Audio",
        es: "Audio local del sistema",
        pt: "Áudio local do sistema",
        de: "Lokales Systemaudio",
        ja: "ローカルシステム音声",
      }),
      description: t(language, {
        zh: "在电脑上跑小助手，抓取系统里播放的声音（内录），在本地分段转文字；需先启动 audio helper，适合会议、网课、视频等。",
        en: "Run the local helper to capture system playback and segment it into transcripts. Start the audio helper first; useful for meetings, courses, and videos.",
        es: "Ejecuta el asistente local para capturar el audio del sistema y segmentarlo en transcripciones. Inicia primero audio helper; útil para reuniones, cursos y videos.",
        pt: "Execute o assistente local para capturar a reprodução do sistema e segmentá-la em transcrições. Inicie o audio helper primeiro; útil para reuniões, cursos e vídeos.",
        de: "Lokalen Helper ausführen, um Systemwiedergabe zu erfassen und in Transkripte zu segmentieren. Zuerst den Audio Helper starten; nützlich für Meetings, Kurse und Videos.",
        ja: "ローカルヘルパーでシステム再生音を取得し、文字起こしに分割します。先に audio helper を起動してください。会議、講義、動画に適しています。",
      }),
      capture_mode: "helper_native_capture",
      capability_status: "limited",
      capability_reason: nonChromeEdgeDesktop
        ? t(language, {
            zh: "需要本机启动 audio helper。实验性共享音频验证入口仅在 Chrome / Edge 提供。",
            en: "Requires the local audio helper. The experimental shared-audio entry is only available in Chrome / Edge.",
            es: "Requiere el audio helper local. La entrada experimental de audio compartido solo está disponible en Chrome / Edge.",
            pt: "Requer o audio helper local. A entrada experimental de áudio compartilhado só está disponível no Chrome / Edge.",
            de: "Erfordert den lokalen Audio Helper. Der experimentelle Shared-Audio-Einstieg ist nur in Chrome / Edge verfügbar.",
            ja: "ローカル audio helper が必要です。実験的な共有音声入口は Chrome / Edge のみで利用できます。",
          })
        : t(language, {
            zh: "需要本机启动 audio helper，并准备好本地转写依赖。",
            en: "Requires the local audio helper and local transcription dependencies.",
            es: "Requiere el audio helper local y las dependencias locales de transcripción.",
            pt: "Requer o audio helper local e as dependências locais de transcrição.",
            de: "Erfordert den lokalen Audio Helper und lokale Transkriptionsabhängigkeiten.",
            ja: "ローカル audio helper とローカル文字起こし依存関係が必要です。",
          }),
    });
  }

  return options;
}

export function getSpeechRecognitionErrorMessage(errorCode?: string, language: LanguagePreference = "zh-CN") {
  switch (errorCode) {
    case "network":
      return t(language, {
        zh: "浏览器语音识别服务当前不可用。通常是网络、浏览器服务连接或地区环境导致。你可以先改用 Transcript 输入。",
        en: "The browser speech recognition service is unavailable. This is often caused by network, browser service, or regional limitations. Try Transcript input first.",
        es: "El servicio de reconocimiento de voz del navegador no está disponible. Suele deberse a red, servicio del navegador o restricciones regionales. Prueba primero la entrada Transcript.",
        pt: "O serviço de reconhecimento de fala do navegador está indisponível. Isso costuma ocorrer por rede, serviço do navegador ou limitações regionais. Tente primeiro a entrada Transcript.",
        de: "Der Spracherkennungsdienst des Browsers ist nicht verfügbar. Häufig liegt es an Netzwerk, Browserdienst oder regionalen Einschränkungen. Probiere zuerst die Transcript-Eingabe.",
        ja: "ブラウザの音声認識サービスを利用できません。ネットワーク、ブラウザサービス、地域制限が原因の場合があります。まず Transcript 入力を試してください。",
      });
    case "not-allowed":
    case "service-not-allowed":
      return t(language, {
        zh: "麦克风权限未开启，或浏览器禁止了语音识别服务。请检查站点权限后重试。",
        en: "Microphone permission is disabled, or the browser blocked speech recognition. Check site permissions and try again.",
        es: "El permiso del micrófono está desactivado o el navegador bloqueó el reconocimiento de voz. Revisa los permisos del sitio e inténtalo de nuevo.",
        pt: "A permissão do microfone está desativada ou o navegador bloqueou o reconhecimento de fala. Verifique as permissões do site e tente novamente.",
        de: "Die Mikrofonberechtigung ist deaktiviert oder der Browser hat die Spracherkennung blockiert. Prüfe die Website-Berechtigungen und versuche es erneut.",
        ja: "マイク権限が無効、またはブラウザが音声認識をブロックしています。サイト権限を確認して再試行してください。",
      });
    case "audio-capture":
      return t(language, {
        zh: "没有检测到可用麦克风设备。请确认系统输入设备和浏览器权限。",
        en: "No usable microphone was detected. Check your system input device and browser permissions.",
        es: "No se detectó un micrófono utilizable. Comprueba el dispositivo de entrada del sistema y los permisos del navegador.",
        pt: "Nenhum microfone utilizável foi detectado. Verifique o dispositivo de entrada do sistema e as permissões do navegador.",
        de: "Kein verwendbares Mikrofon erkannt. Prüfe Eingabegerät und Browserberechtigungen.",
        ja: "使用可能なマイクが検出されませんでした。システム入力デバイスとブラウザ権限を確認してください。",
      });
    case "no-speech":
      return t(language, {
        zh: "没有检测到有效语音输入。请靠近麦克风后重试。",
        en: "No valid speech input was detected. Move closer to the microphone and try again.",
        es: "No se detectó voz válida. Acércate al micrófono e inténtalo de nuevo.",
        pt: "Nenhuma fala válida foi detectada. Aproxime-se do microfone e tente novamente.",
        de: "Keine gültige Spracheingabe erkannt. Gehe näher ans Mikrofon und versuche es erneut.",
        ja: "有効な音声入力が検出されませんでした。マイクに近づいて再試行してください。",
      });
    case "aborted":
      return t(language, {
        zh: "语音识别已中断。",
        en: "Speech recognition was interrupted.",
        es: "El reconocimiento de voz se interrumpió.",
        pt: "O reconhecimento de fala foi interrompido.",
        de: "Spracherkennung wurde unterbrochen.",
        ja: "音声認識が中断されました。",
      });
    case "language-not-supported":
      return t(language, {
        zh: "当前浏览器不支持所选语音识别语言。",
        en: "The selected speech recognition language is not supported by this browser.",
        es: "Este navegador no admite el idioma seleccionado para el reconocimiento de voz.",
        pt: "O idioma de reconhecimento de fala selecionado não é suportado por este navegador.",
        de: "Die ausgewählte Sprache für Spracherkennung wird von diesem Browser nicht unterstützt.",
        ja: "選択した音声認識言語はこのブラウザでサポートされていません。",
      });
    default:
      return t(language, {
        zh: "语音识别失败。你可以先改用 Transcript 输入。",
        en: "Speech recognition failed. Try Transcript input first.",
        es: "Falló el reconocimiento de voz. Prueba primero la entrada Transcript.",
        pt: "O reconhecimento de fala falhou. Tente primeiro a entrada Transcript.",
        de: "Spracherkennung fehlgeschlagen. Probiere zuerst die Transcript-Eingabe.",
        ja: "音声認識に失敗しました。まず Transcript 入力を試してください。",
      });
  }
}

export function getDisplayAudioErrorMessage(errorName?: string, language: LanguagePreference = "zh-CN") {
  switch (errorName) {
    case "NotAllowedError":
      return t(language, {
        zh: "你取消了共享音频，或浏览器没有获得共享权限。",
        en: "You cancelled audio sharing, or the browser did not receive sharing permission.",
        es: "Cancelaste el uso compartido de audio o el navegador no recibió permiso para compartir.",
        pt: "Você cancelou o compartilhamento de áudio ou o navegador não recebeu permissão para compartilhar.",
        de: "Du hast die Audiofreigabe abgebrochen oder der Browser hat keine Freigabeberechtigung erhalten.",
        ja: "音声共有をキャンセルしたか、ブラウザに共有権限がありません。",
      });
    case "NotFoundError":
      return t(language, {
        zh: "当前浏览器没有提供可共享的音频来源。",
        en: "This browser did not provide a shareable audio source.",
        es: "Este navegador no proporcionó una fuente de audio compartible.",
        pt: "Este navegador não forneceu uma fonte de áudio compartilhável.",
        de: "Dieser Browser hat keine teilbare Audioquelle bereitgestellt.",
        ja: "このブラウザには共有可能な音声ソースがありません。",
      });
    case "AbortError":
      return t(language, {
        zh: "共享音频流程被中断。",
        en: "The shared-audio flow was interrupted.",
        es: "El flujo de audio compartido se interrumpió.",
        pt: "O fluxo de áudio compartilhado foi interrompido.",
        de: "Der Shared-Audio-Ablauf wurde unterbrochen.",
        ja: "共有音声の処理が中断されました。",
      });
    case "NotReadableError":
      return t(language, {
        zh: "浏览器无法读取共享音频。请检查系统权限和浏览器状态。",
        en: "The browser could not read shared audio. Check system permissions and browser state.",
        es: "El navegador no pudo leer el audio compartido. Revisa los permisos del sistema y el estado del navegador.",
        pt: "O navegador não conseguiu ler o áudio compartilhado. Verifique as permissões do sistema e o estado do navegador.",
        de: "Der Browser konnte geteiltes Audio nicht lesen. Prüfe Systemberechtigungen und Browserstatus.",
        ja: "ブラウザが共有音声を読み取れませんでした。システム権限とブラウザ状態を確認してください。",
      });
    default:
      return t(language, {
        zh: "无法开始共享音频验证。你可以先改用打字输入，或尝试本机内录转写。",
        en: "Could not start shared-audio validation. Try Typed Input or Local System Audio first.",
        es: "No se pudo iniciar la validación de audio compartido. Prueba primero Entrada escrita o Audio local del sistema.",
        pt: "Não foi possível iniciar a validação de áudio compartilhado. Tente primeiro Entrada digitada ou Áudio local do sistema.",
        de: "Shared-Audio-Prüfung konnte nicht gestartet werden. Probiere zuerst Texteingabe oder lokales Systemaudio.",
        ja: "共有音声の検証を開始できません。まずテキスト入力またはローカルシステム音声を試してください。",
      });
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
