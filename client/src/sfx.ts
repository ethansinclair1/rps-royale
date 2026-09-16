// Lightweight synthesized sound effects via the Web Audio API - no audio
// files to host or license, and it works the instant the game does.

let ctx: AudioContext | null = null;
let muted = localStorage.getItem("rps-royale-muted") === "1";

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function isMuted() {
  return muted;
}

export function setMuted(value: boolean) {
  muted = value;
  localStorage.setItem("rps-royale-muted", value ? "1" : "0");
}

function tone(freq: number, startOffset: number, duration: number, type: OscillatorType, gainLevel: number) {
  if (muted) return;
  const c = getCtx();
  if (!c) return;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);

  const t0 = c.currentTime + startOffset;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(gainLevel, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playClick() {
  tone(600, 0, 0.05, "square", 0.06);
}

export function playPick() {
  tone(520, 0, 0.08, "triangle", 0.1);
}

export function playReveal() {
  tone(300, 0, 0.09, "sine", 0.09);
  tone(520, 0.07, 0.1, "sine", 0.09);
}

export function playWin() {
  tone(523.25, 0, 0.12, "square", 0.11);
  tone(659.25, 0.1, 0.12, "square", 0.11);
  tone(783.99, 0.2, 0.22, "square", 0.13);
}

export function playLose() {
  tone(392, 0, 0.16, "sawtooth", 0.09);
  tone(311.13, 0.14, 0.2, "sawtooth", 0.09);
  tone(261.63, 0.28, 0.32, "sawtooth", 0.09);
}

export function playDraw() {
  tone(440, 0, 0.09, "triangle", 0.09);
  tone(440, 0.12, 0.09, "triangle", 0.09);
}

export function playAbility() {
  tone(880, 0, 0.05, "square", 0.09);
  tone(1108.73, 0.05, 0.07, "square", 0.09);
  tone(1318.5, 0.11, 0.12, "square", 0.09);
}

export function playChampionFanfare() {
  const notes: [number, number][] = [
    [523.25, 0],
    [523.25, 0.13],
    [523.25, 0.26],
    [659.25, 0.39],
    [783.99, 0.52],
    [1046.5, 0.68],
  ];
  for (const [freq, offset] of notes) {
    tone(freq, offset, 0.28, "square", 0.12);
  }
}
