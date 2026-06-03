import { captureVoiceText, voiceCaptureAvailable } from '../client/src/voiceQuickCapture';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

class FakeRecognition {
  static instance: FakeRecognition | null = null;
  lang = '';
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instance = this;
  }

  start() {
    this.onresult?.({ results: [{ 0: { transcript: ' captured task ' }, length: 1 }] });
    this.onend?.();
  }
}

class ErrorRecognition extends FakeRecognition {
  start() {
    this.onerror?.({ error: 'not_allowed' });
  }
}

async function main() {
  assert(voiceCaptureAvailable({ SpeechRecognition: FakeRecognition, navigator: { language: 'en-US' } }), 'voice capture should be available');
  assert(!voiceCaptureAvailable({}), 'voice capture should be unavailable without SpeechRecognition');

  const text = await captureVoiceText({ SpeechRecognition: FakeRecognition, navigator: { language: 'en-US' } });
  assert(text === 'captured task', `transcript mismatch: ${text}`);
  assert(FakeRecognition.instance?.lang === 'en-US', 'language should come from runtime navigator');
  assert(FakeRecognition.instance?.interimResults === false, 'interim results should be disabled');
  assert(FakeRecognition.instance?.maxAlternatives === 1, 'max alternatives should be one');

  const unsupported = await captureVoiceText({}).catch((err) => (err as Error).message);
  assert(unsupported === 'voice_capture_unsupported', 'unsupported runtime should reject clearly');

  const denied = await captureVoiceText({ SpeechRecognition: ErrorRecognition }).catch((err) => (err as Error).message);
  assert(denied === 'not_allowed', 'speech recognition error should surface');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
