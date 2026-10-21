/** Browser SpeechSynthesis TTS (option #19): speak the assistant's reply with a stop control. */

const MAX_CHUNK = 160;

function chunkForSpeech(text: string): string[] {
  const sentences = text.replace(/\u3010[^】]*】|```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`~|]/g, ' ')
    .split(/(?<=[.!?؟。！？])\s+|\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (current.length + piece.length + 1 <= MAX_CHUNK) {
      current = current ? `${current} ${piece}` : piece;
    } else {
      if (current) chunks.push(current);
      current = piece.length > MAX_CHUNK * 2 ? chunkForSpeech(piece).join(' ') : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.getVoices !== undefined;
}

export function isSpeaking(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.speaking;
}

export function speak(text: string, opts?: { lang?: string }): void {
  if (!speechAvailable() || !text.trim()) return;
  stopSpeaking();
  const synth = window.speechSynthesis;
  for (const chunk of chunkForSpeech(text)) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (opts?.lang) utterance.lang = opts.lang;
    synth.speak(utterance);
  }
}

export function stopSpeaking(): void {
  if (typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined') {
    window.speechSynthesis.cancel();
  }
}
