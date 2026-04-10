import { ENV } from "./env";

export type TranscribeOptions = {
  audioUrl: string;
  language?: string;
  prompt?: string;
};

export type WhisperSegment = {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
};

export type WhisperResponse = {
  task: "transcribe";
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
};

export type TranscriptionResponse = WhisperResponse;

export type TranscriptionError = {
  error: string;
  code: "FILE_TOO_LARGE" | "INVALID_FORMAT" | "TRANSCRIPTION_FAILED" | "UPLOAD_FAILED" | "SERVICE_ERROR";
  details?: string;
};

export async function transcribeAudio(options: TranscribeOptions): Promise<TranscriptionResponse | TranscriptionError> {
  try {
    if (!ENV.forgeApiUrl) return { error: "Voice transcription service is not configured", code: "SERVICE_ERROR" };
    if (!ENV.forgeApiKey) return { error: "Voice transcription service authentication is missing", code: "SERVICE_ERROR" };
    let audioBuffer: Buffer; let mimeType: string;
    try {
      const response = await fetch(options.audioUrl);
      if (!response.ok) return { error: "Failed to download audio file", code: "INVALID_FORMAT" };
      audioBuffer = Buffer.from(await response.arrayBuffer());
      mimeType = response.headers.get('content-type') || 'audio/mpeg';
      if (audioBuffer.length / (1024 * 1024) > 16) return { error: "Audio file exceeds maximum size limit", code: "FILE_TOO_LARGE" };
    } catch (error) {
      return { error: "Failed to fetch audio file", code: "SERVICE_ERROR" };
    }
    const formData = new FormData();
    const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    formData.append("file", audioBlob, "audio.mp3");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    formData.append("prompt", options.prompt || "Transcribe the user's voice to text");
    const baseUrl = ENV.forgeApiUrl.endsWith("/") ? ENV.forgeApiUrl : `${ENV.forgeApiUrl}/`;
    const fullUrl = new URL("v1/audio/transcriptions", baseUrl).toString();
    const response = await fetch(fullUrl, { method: "POST", headers: { authorization: `Bearer ${ENV.forgeApiKey}` }, body: formData });
    if (!response.ok) { const err = await response.text().catch(() => ""); return { error: "Transcription service request failed", code: "TRANSCRIPTION_FAILED", details: err }; }
    const whisperResponse = await response.json() as WhisperResponse;
    if (!whisperResponse.text || typeof whisperResponse.text !== 'string') return { error: "Invalid transcription response", code: "SERVICE_ERROR" };
    return whisperResponse;
  } catch (error) {
    return { error: "Voice transcription failed", code: "SERVICE_ERROR", details: error instanceof Error ? error.message : "Unknown" };
  }
}
