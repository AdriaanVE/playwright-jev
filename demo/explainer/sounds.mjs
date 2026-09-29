// Synthesizes the explainer's sound effects into a WAV file, from cues the page exports (window.soundCues).
// Everything is generated from sine waves and seeded noise, so there are no audio assets and every render is
// identical. Levels are kept low: the effects mark events, they are not a soundtrack.
import { writeFileSync } from "node:fs"

const RATE = 48_000
const PEAK = 0.5 // about -6 dBFS before the soft limiter

// Each sound writes into `out` starting at sample `start`.
const sounds = {
  // A short, soft blip per LLM token. Pitch wanders slightly so a run of them does not buzz.
  tick(out, start, index) {
    const freq = 2200 + ((index * 137) % 5) * 60
    tone(out, start, { freq, seconds: 0.03, gain: 0.05, decay: 90 })
  },
  // JEV answers: two quick rising bell notes.
  chime(out, start) {
    bell(out, start, { freq: 880, gain: 0.14 })
    bell(out, start + Math.round(0.07 * RATE), { freq: 1318.5, gain: 0.12 })
  },
  // The LLM finally answers: a low, dull knock.
  thud(out, start) {
    for (let i = 0; i < 0.35 * RATE; i++) {
      const t = i / RATE
      const freq = 70 + 60 * Math.exp(-t * 18)
      add(out, start + i, 0.28 * Math.exp(-t * 11) * Math.sin(2 * Math.PI * freq * t))
    }
  },
  // A caught bug: two soft falling notes.
  bug(out, start) {
    tone(out, start, { freq: 523.3, seconds: 0.22, gain: 0.1, decay: 9, harmonic: 0.25 })
    tone(out, start + Math.round(0.16 * RATE), { freq: 392, seconds: 0.4, gain: 0.1, decay: 6, harmonic: 0.25 })
  },
  // Scene change: a faint band of noise that swells and fades.
  whoosh(out, start) {
    const seconds = 0.5
    let seed = start
    let low = 0
    let band = 0
    for (let i = 0; i < seconds * RATE; i++) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const noise = seed / 2 ** 31 - 1
      // Two one-pole filters make a band that sweeps upward.
      const cutoff = 0.02 + 0.08 * (i / (seconds * RATE))
      low += cutoff * (noise - low)
      band += 0.5 * cutoff * (low - band)
      const envelope = Math.sin(Math.PI * (i / (seconds * RATE))) ** 2
      add(out, start + i, 0.35 * envelope * (low - band))
    }
  },
  // Headline results and the end card: a soft major chord.
  resolve(out, start) {
    for (const [freq, gain] of [
      [523.3, 0.07],
      [659.3, 0.055],
      [784, 0.05],
      [1046.5, 0.03],
    ]) {
      tone(out, start, { freq, seconds: 1.8, gain, decay: 2.2, attack: 0.04 })
    }
  },
}

function tone(out, start, { freq, seconds, gain, decay, attack = 0.004, harmonic = 0 }) {
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i / RATE
    const envelope = Math.min(1, t / attack) * Math.exp(-t * decay)
    const wave = Math.sin(2 * Math.PI * freq * t) + harmonic * Math.sin(2 * Math.PI * 2 * freq * t)
    add(out, start + i, gain * envelope * wave)
  }
}

function bell(out, start, { freq, gain }) {
  // A bell's partials decay at different rates; two are enough for a clean chime.
  tone(out, start, { freq, seconds: 0.9, gain, decay: 5 })
  tone(out, start, { freq: freq * 2.76, seconds: 0.4, gain: gain * 0.25, decay: 12 })
}

function add(out, index, value) {
  if (index >= 0 && index < out.length) out[index] += value
}

/** Renders `cues` ({ at, sound }) over `duration` seconds to a 48 kHz, 16-bit stereo WAV at `path`. */
export function writeSoundtrack(cues, duration, path) {
  const mono = new Float32Array(Math.ceil(duration * RATE))
  const counts = {}
  for (const { at, sound } of cues) {
    counts[sound] = (counts[sound] ?? 0) + 1
    sounds[sound](mono, Math.round(at * RATE), counts[sound])
  }

  const data = Buffer.alloc(mono.length * 4)
  for (let i = 0; i < mono.length; i++) {
    // Soft limiter: gentle above PEAK, never clips.
    const sample = Math.round(PEAK * Math.tanh(mono[i] / PEAK) * 32_767)
    data.writeInt16LE(sample, i * 4)
    data.writeInt16LE(sample, i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(2, 22) // stereo
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}
