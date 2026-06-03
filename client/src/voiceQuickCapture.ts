interface SpeechAlternativeLike {
  transcript?: string;
}

interface SpeechResultLike {
  length?: number;
  item?: (index: number) => SpeechAlternativeLike | null;
  [index: number]: SpeechAlternativeLike | undefined;
}

interface SpeechResultListLike {
  length: number;
  [index: number]: SpeechResultLike | undefined;
}

interface SpeechRecognitionEventLike {
  results: SpeechResultListLike;
}

interface SpeechRecognitionErrorLike {
  error?: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface SpeechWindowLike {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  navigator?: { language?: string };
}

function speechWindow(windowLike?: SpeechWindowLike): SpeechWindowLike {
  return windowLike ?? (globalThis as unknown as SpeechWindowLike);
}

function speechConstructor(windowLike?: SpeechWindowLike): SpeechRecognitionCtor | null {
  const runtime = speechWindow(windowLike);
  return runtime.SpeechRecognition ?? runtime.webkitSpeechRecognition ?? null;
}

function transcriptFrom(event: SpeechRecognitionEventLike): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i += 1) {
    const result = event.results[i];
    const first = result?.[0] ?? result?.item?.(0);
    if (first?.transcript) parts.push(first.transcript.trim());
  }
  return parts.filter(Boolean).join(' ').trim();
}

export function voiceCaptureAvailable(windowLike?: SpeechWindowLike): boolean {
  return Boolean(speechConstructor(windowLike));
}

export function captureVoiceText(windowLike?: SpeechWindowLike): Promise<string> {
  const Ctor = speechConstructor(windowLike);
  if (!Ctor) return Promise.reject(new Error('voice_capture_unsupported'));
  const runtime = speechWindow(windowLike);
  const recognition = new Ctor();
  recognition.lang = runtime.navigator?.language || 'zh-CN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    recognition.onresult = (event) => {
      const text = transcriptFrom(event);
      if (!text) return;
      settle(() => resolve(text));
    };
    recognition.onerror = (event) => {
      settle(() => reject(new Error(event.error || event.message || 'voice_capture_failed')));
    };
    recognition.onend = () => {
      settle(() => reject(new Error('voice_capture_empty')));
    };
    try {
      recognition.start();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error('voice_capture_failed')));
    }
  });
}
