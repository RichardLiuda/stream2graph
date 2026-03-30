"use client";

export function encodeFloat32ToBase64Pcm16(samples: Float32Array) {
  const pcm16 = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] || 0));
    pcm16[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}

export async function decodeAudioFileToVoiceprintPayload(file: File) {
  const buffer = await file.arrayBuffer();
  const audioContext = new window.AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(buffer.slice(0));
    const targetSampleRate = 16000;
    const frameCount = Math.max(1, Math.ceil(decoded.duration * targetSampleRate));
    const offline = new window.OfflineAudioContext(1, frameCount, targetSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const mono = rendered.getChannelData(0);
    return {
      pcm_s16le_base64: encodeFloat32ToBase64Pcm16(mono),
      sample_rate: targetSampleRate,
      channel_count: 1,
      duration_ms: Math.round((mono.length / targetSampleRate) * 1000),
    };
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}
