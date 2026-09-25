// Fully synthesized Web Audio engine for The Carto-Rogue.
//
// There are no audio assets: every sound is assembled at play time from oscillators, one shared
// white-noise buffer and parameter envelopes. Each sound is a Voice, a small node graph that
// disconnects itself as soon as all of its sources have ended, so hundreds of footsteps never
// leak nodes. Signal flow:
//
//   voice -> [panner] -+-> master gain -> compressor (gentle limiter) -> destination
//                      +-> reverb send -> highpass -> convolver (synthetic room) -> return -> master
import type { AudioEngine, DiscoveryKind, SlopeClass } from './types';

export interface SynthAudioOptions {
  /** Builds the audio context on the first unlock(). Tests pass an OfflineAudioContext factory. */
  contextFactory?: () => BaseAudioContext;
}

const MUTE_STORAGE_KEY = 'carto-rogue:muted';
/** Master gain when unmuted (the compressor adds a little make-up gain after this). */
const MASTER_LEVEL = 0.72;
/** Time constant of the mute / unmute ramp in seconds (~90 ms to settle). */
const MUTE_TIME_CONSTANT = 0.018;
/**
 * Bounds of the scheduling lead (s): sounds start this far after currentTime so their envelopes never
 * begin in the past. The render position can jump by a whole device callback (~10 ms on desktop, more
 * on large-buffer devices) between reading currentTime and the new nodes reaching the audio thread, so
 * the lead is the device's base latency plus LEAD_MARGIN for building the sound, kept inside these bounds.
 */
const MIN_LEAD = 0.015;
const MAX_LEAD = 0.05;
const LEAD_MARGIN = 0.005;
/** Floor for exponential ramps, which can never reach 0. */
const EPS = 0.0001;
/** Sources keep running this long after their envelope reaches the floor. */
const SOURCE_TAIL = 0.01;
const NOISE_SECONDS = 2;
const REVERB_SECONDS = 1.8;
const REVERB_RETURN = 0.3;
const MAX_FOOTSTEP_VOICES = 4;
/** Soft cap on simultaneous voices; the oldest short voice is faded out beyond it. */
const MAX_VOICES = 40;
/** Voices whose sources should have ended this long ago are force-disposed (lost onended safety net). */
const STALE_VOICE_GRACE = 1.5;

// ---------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Frequency ratio of a pitch offset in cents. */
function cents(c: number): number {
  return Math.pow(2, c / 1200);
}

/** Equal-tempered frequency of a MIDI note number (A4 = 69 = 440 Hz). */
function midi(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** Uniform random number in [-1, 1). */
function bipolar(): number {
  return Math.random() * 2 - 1;
}

/**
 * Percussive envelope on `p`: 0 -> peak (linear attack) -> floor (exponential decay) -> 0.
 * Returns the time the envelope has finished.
 */
function perc(p: AudioParam, t: number, attack: number, peak: number, decay: number): number {
  const top = t + attack;
  const end = top + Math.max(decay, 0.005);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, EPS), top);
  p.exponentialRampToValueAtTime(EPS, end);
  p.setValueAtTime(0, end);
  return end;
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

function makeNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = bipolar();
  return buf;
}

/** Synthetic stereo room impulse: decaying noise whose tone darkens as it fades, after a short pre-delay. */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(2, Math.floor(rate * seconds));
  const pre = Math.min(length - 1, Math.floor(rate * 0.012));
  const buf = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < length; i++) {
      const x = (i - pre) / (length - pre);
      // One-pole lowpass whose cutoff falls over the tail, like air absorbing the highs.
      lp += (0.62 - 0.5 * x) * (bipolar() - lp);
      data[i] = lp * Math.pow(1 - x, 3);
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Voice: one self-cleaning node graph per sound
// ---------------------------------------------------------------------------

interface Bus {
  ctx: BaseAudioContext;
  master: GainNode;
  /**
   * Input of the shared reverb, or null when convolution is unavailable. It exists from the start, but
   * on a live context the convolver behind it is attached a moment later (see SynthAudio.attachReverb).
   */
  reverbIn: AudioNode | null;
  noise: AudioBuffer;
  /** Scheduling lead for new sounds (s); see MIN_LEAD. */
  lead: number;
}

interface VoiceOptions {
  /** Output level multiplier (default 1). */
  level?: number;
  /** Stereo position -1..1 for the whole voice. */
  pan?: number;
  /** Amount sent to the shared reverb, 0..1. */
  reverb?: number;
  /** Long voices (fanfare, drone, swells) are faded out by stopAll(). */
  long?: boolean;
}

class Voice {
  readonly ctx: BaseAudioContext;
  readonly out: GainNode;
  readonly long: boolean;
  /** Context time by which every source is scheduled to have stopped. */
  endAt: number;
  private readonly bus: Bus;
  private readonly onDispose: (voice: Voice) => void;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private pending = 0;
  private released = false;
  private disposed = false;

  constructor(bus: Bus, opts: VoiceOptions, onDispose: (voice: Voice) => void) {
    this.bus = bus;
    this.ctx = bus.ctx;
    this.onDispose = onDispose;
    this.long = opts.long ?? false;
    this.endAt = bus.ctx.currentTime;
    this.out = this.gain(null, opts.level ?? 1);
    const tail = opts.pan ? this.panner(opts.pan, bus.master) : bus.master;
    this.out.connect(tail);
    if (bus.reverbIn && opts.reverb && opts.reverb > 0) {
      this.out.connect(this.gain(bus.reverbIn, opts.reverb));
    }
  }

  get isReleased(): boolean {
    return this.released || this.disposed;
  }

  gain(dest: AudioNode | null, value = 0): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  }

  /** Stereo panner feeding `dest`; falls back to `dest` itself where StereoPannerNode is missing. */
  panner(pan: number, dest: AudioNode): AudioNode {
    if (typeof this.ctx.createStereoPanner !== 'function') return dest;
    const p = this.track(this.ctx.createStereoPanner());
    p.pan.value = clamp(pan, -1, 1);
    p.connect(dest);
    return p;
  }

  osc(type: OscillatorType, freq: number, start: number, stop: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    o.connect(dest);
    o.start(start);
    this.adopt(o, stop + SOURCE_TAIL);
    return o;
  }

  /** Burst of the shared white noise, starting at a random point of the (looping) buffer. */
  noise(start: number, stop: number, dest: AudioNode): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.bus.noise;
    s.loop = true;
    s.connect(dest);
    s.start(start, Math.random() * this.bus.noise.duration * 0.9);
    this.adopt(s, stop + SOURCE_TAIL);
    return s;
  }

  /** Fade the whole voice out over roughly `fade` seconds and stop its sources. */
  release(fade: number): void {
    if (this.released || this.disposed) return;
    this.released = true;
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(0, now, fade / 4);
    const stopAt = now + fade;
    for (const s of this.sources) {
      try {
        s.stop(stopAt);
      } catch {
        // Already stopped: nothing to do.
      }
    }
    this.endAt = Math.min(this.endAt, stopAt);
  }

  /** Stop and disconnect every node of the chain. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // Already stopped.
      }
      s.disconnect();
    }
    for (const n of this.nodes) n.disconnect();
    this.sources.length = 0;
    this.nodes.length = 0;
    this.onDispose(this);
  }

  private track<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  private adopt(src: AudioScheduledSourceNode, stopAt: number): void {
    this.sources.push(src);
    this.pending++;
    this.endAt = Math.max(this.endAt, stopAt);
    src.onended = () => {
      src.onended = null;
      this.pending--;
      if (this.pending <= 0) this.dispose();
    };
    src.stop(stopAt);
  }
}

// ---------------------------------------------------------------------------
// Instruments (each schedules into a voice and returns its end time)
// ---------------------------------------------------------------------------

interface BellPartial {
  ratio: number;
  type: OscillatorType;
  amp: number;
  decay: number;
}

/** Bell-like spectrum: sine fundamental, triangle octave, an inharmonic shimmer partial and a strike glint. */
const BELL_PARTIALS: readonly BellPartial[] = [
  { ratio: 1, type: 'sine', amp: 1, decay: 1 },
  { ratio: 2, type: 'triangle', amp: 0.3, decay: 0.55 },
  { ratio: 2.76, type: 'sine', amp: 0.18, decay: 0.32 },
  { ratio: 5.4, type: 'sine', amp: 0.07, decay: 0.16 },
];

interface BellOptions {
  freq: number;
  t: number;
  peak: number;
  decay: number;
  attack?: number;
  pan?: number;
  /** Adds a slightly sharp twin of the fundamental that beats slowly against it. */
  shimmer?: boolean;
}

function bell(v: Voice, o: BellOptions): number {
  const dest = o.pan === undefined ? v.out : v.panner(o.pan, v.out);
  const attack = o.attack ?? 0.003;
  const ceiling = v.ctx.sampleRate * 0.45;
  let end = o.t;
  for (const p of BELL_PARTIALS) {
    const f = o.freq * p.ratio;
    if (f >= ceiling) continue;
    const g = v.gain(dest);
    const stop = perc(g.gain, o.t, attack, o.peak * p.amp, o.decay * p.decay);
    v.osc(p.type, f, o.t, stop, g);
    end = Math.max(end, stop);
  }
  if (o.shimmer) {
    const g = v.gain(dest);
    const stop = perc(g.gain, o.t, attack * 4, o.peak * 0.4, o.decay * 0.9);
    v.osc('sine', o.freq * cents(7), o.t, stop, g);
    end = Math.max(end, stop);
  }
  return end;
}

interface BrassOptions {
  freq: number;
  t: number;
  /** Time from note-on to release start. */
  dur: number;
  peak: number;
  release?: number;
  /** Multiplies the filter cutoffs (melody voices are brighter than chord pads). */
  bright?: number;
  pan?: number;
  vibrato?: boolean;
}

/** Brass-like voice: two detuned sawtooths through a lowpass whose envelope gives the "blat" of the attack. */
function brass(v: Voice, o: BrassOptions): number {
  const release = o.release ?? 0.16;
  const bright = o.bright ?? 1;
  const hold = o.t + Math.max(o.dur, 0.06);
  const end = hold + release;
  const dest = o.pan === undefined ? v.out : v.panner(o.pan, v.out);

  // Amplitude: quick swell, slight decay to a sustain level, exponential release.
  const amp = v.gain(dest);
  const level = o.peak * 0.5; // two oscillators sum to twice this
  const sustain = level * 0.72;
  const attack = 0.028;
  amp.gain.setValueAtTime(0, o.t);
  amp.gain.linearRampToValueAtTime(level, o.t + attack);
  amp.gain.exponentialRampToValueAtTime(sustain, Math.min(o.t + attack + 0.16, hold));
  amp.gain.setValueAtTime(sustain, hold);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  amp.gain.setValueAtTime(0, end);

  // Filter: opens fast on the attack, settles, then closes with the release. (Lowpass Q is in dB.)
  const lp = v.filter('lowpass', 1000, 2.5, amp);
  const closed = clamp(o.freq * 1.3, 150, 3000);
  const open = clamp(o.freq * 7 * bright, 700, 9000);
  const settled = clamp(o.freq * 4 * bright, 500, 6500);
  const fq = lp.frequency;
  fq.setValueAtTime(closed, o.t);
  fq.exponentialRampToValueAtTime(open, o.t + 0.05);
  fq.exponentialRampToValueAtTime(settled, Math.min(o.t + 0.3, hold));
  fq.setValueAtTime(settled, hold);
  fq.exponentialRampToValueAtTime(closed, end);

  let depth: GainNode | null = null;
  if (o.vibrato) {
    // Delayed vibrato (cents) so long notes bloom instead of sitting static.
    depth = v.gain(null);
    depth.gain.setValueAtTime(0, o.t + 0.25);
    depth.gain.linearRampToValueAtTime(11, o.t + 0.75);
    v.osc('sine', 5.2, o.t, end, depth);
  }
  for (const detune of [-7, 7]) {
    const s = v.osc('sawtooth', o.freq, o.t, end, lp);
    s.detune.value = detune;
    if (depth) depth.connect(s.detune);
  }
  return end;
}

interface PadOptions {
  notes: readonly number[];
  t: number;
  attack: number;
  hold: number;
  release: number;
  /** Per-oscillator peak (each note uses two detuned oscillators). */
  peak: number;
  cutoff: number;
  type?: OscillatorType;
  pan?: number;
}

/** Soft sustained chord: detuned oscillator pairs through a gentle lowpass with a slow swell. */
function pad(v: Voice, o: PadOptions): number {
  const end = o.t + o.attack + o.hold + o.release;
  const dest = o.pan === undefined ? v.out : v.panner(o.pan, v.out);
  const amp = v.gain(dest);
  amp.gain.setValueAtTime(0, o.t);
  amp.gain.linearRampToValueAtTime(o.peak, o.t + o.attack);
  amp.gain.setValueAtTime(o.peak, o.t + o.attack + o.hold);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  amp.gain.setValueAtTime(0, end);
  const lp = v.filter('lowpass', o.cutoff, 0.7, amp);
  for (const note of o.notes) {
    for (const detune of [-6, 6]) {
      const s = v.osc(o.type ?? 'triangle', midi(note), o.t, end, lp);
      s.detune.value = detune;
    }
  }
  return end;
}

/** Sine whose pitch falls from f0 to f1: drums, thuds, heartbeats. */
function thump(v: Voice, t: number, f0: number, f1: number, peak: number, decay: number, attack = 0.004): number {
  const g = v.gain(v.out);
  const end = perc(g.gain, t, attack, peak, decay);
  const o = v.osc('sine', f0, t, end, g);
  o.frequency.exponentialRampToValueAtTime(f1, t + attack + decay * 0.7);
  return end;
}

/** Filtered noise grain. */
function grain(
  v: Voice,
  t: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  attack: number,
  decay: number,
): number {
  const g = v.gain(v.out);
  const f = v.filter(type, freq, q, g);
  const end = perc(g.gain, t, attack, peak, decay);
  v.noise(t, end, f);
  return end;
}

// ---------------------------------------------------------------------------
// Footstep presets by slope class
// ---------------------------------------------------------------------------

interface StepPreset {
  /** Noise burst decay (s). */
  dur: number;
  /** Bandpass Q (lower = broader, heavier). */
  q: number;
  /** Bandpass centre as a multiple of the elevation pitch. */
  band: number;
  noise: number;
  blip: number;
  /** Blip pitch as a multiple of the elevation pitch. */
  blipRatio: number;
  /** Low body thump level (0 = none). */
  thump: number;
  /** Second scrape grain level (0 = none). */
  scrape: number;
}

/**
 * Flat steps are the most common sound and carry the elevation pitch, so they are about as loud as gentle
 * ones and long enough for the pitch to register; steeper ground is longer, heavier and a few dB louder.
 */
const STEP_PRESETS: Readonly<Record<'flat' | 'gentle' | 'steep', StepPreset>> = {
  flat: { dur: 0.065, q: 3.2, band: 2.2, noise: 1.7, blip: 0.07, blipRatio: 1, thump: 0, scrape: 0 },
  gentle: { dur: 0.068, q: 2, band: 1.8, noise: 1.1, blip: 0.055, blipRatio: 0.9, thump: 0.06, scrape: 0 },
  steep: { dur: 0.072, q: 1.1, band: 1.4, noise: 1.05, blip: 0.068, blipRatio: 0.8, thump: 0.11, scrape: 0.8 },
};

// ---------------------------------------------------------------------------
// Context + preference plumbing
// ---------------------------------------------------------------------------

/** A real AudioContext (webkit-prefixed on old Safari), or null where Web Audio does not exist. */
function defaultContextFactory(): BaseAudioContext | null {
  const g = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Ctor = typeof g.AudioContext === 'function' ? g.AudioContext : g.webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

function isOffline(ctx: BaseAudioContext): boolean {
  return 'startRendering' in ctx;
}

/** Scheduling lead for `ctx`: one device callback plus a build margin (offline contexts have no latency). */
function schedulingLead(ctx: BaseAudioContext): number {
  const base = 'baseLatency' in ctx ? Number(ctx.baseLatency) : 0;
  return clamp((Number.isFinite(base) ? base : 0) + LEAD_MARGIN, MIN_LEAD, MAX_LEAD);
}

function readMutePreference(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMutePreference(muted: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // Storage blocked (private mode, sandboxed frame): the preference is simply not remembered.
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SynthAudio implements AudioEngine {
  private readonly factory: () => BaseAudioContext | null;
  private bus: Bus | null = null;
  private unavailable = false;
  private isMuted: boolean;
  private readonly voices = new Set<Voice>();
  private readonly footsteps: Voice[] = [];
  /** Context time each sound last started, for per-sound retrigger limits. */
  private readonly lastPlayed = new Map<string, number>();

  constructor(options: SynthAudioOptions = {}) {
    this.factory = options.contextFactory ?? defaultContextFactory;
    this.isMuted = readMutePreference();
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /** Number of live voices; returns to 0 once every sound has finished (diagnostics and tests). */
  get activeVoices(): number {
    return this.voices.size;
  }

  unlock(): void {
    try {
      if (!this.bus && !this.unavailable) this.init();
      const ctx = this.bus?.ctx;
      if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || isOffline(ctx)) return;
      const resumable = ctx as BaseAudioContext & { resume?: () => Promise<void> };
      const pending = resumable.resume?.();
      if (pending) pending.catch(() => undefined);
    } catch {
      // Web Audio refused (no device, too many contexts): stay silent.
    }
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    writeMutePreference(this.isMuted);
    const bus = this.bus;
    if (bus) {
      try {
        const now = bus.ctx.currentTime;
        const g = bus.master.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.setTargetAtTime(this.isMuted ? 0 : MASTER_LEVEL, now, MUTE_TIME_CONSTANT);
      } catch {
        // Context gone: the flag alone still governs whether new sounds are made.
      }
    }
    return this.isMuted;
  }

  footstep(elevation: number, slope: SlopeClass): void {
    this.play('footstep', 0.02, (t) => {
      const e = clamp(Number.isFinite(elevation) ? elevation : 0.3, 0, 1);
      const p = slope === 'steep' || slope === 'cliff' ? STEP_PRESETS.steep : STEP_PRESETS[slope];
      // Exponential elevation map: sea level ~220 Hz, the highest ground ~880 Hz, +-35 cents of scatter.
      const pitch = 220 * Math.pow(4, e) * cents(bipolar() * 35);
      // A band at a higher centre passes more noise energy; tilt the level so every altitude sounds equally subtle.
      const noise = p.noise * Math.pow(220 / pitch, 0.7) * (0.9 + Math.random() * 0.2);
      const v = this.footstepVoice();

      // Band-passed noise burst: boot on ground.
      grain(v, t, 'bandpass', pitch * p.band * cents(bipolar() * 60), p.q, noise, 0.0015, p.dur);

      // Tiny pitched blip with a fast downward chirp.
      const bg = v.gain(v.out);
      const blipEnd = perc(bg.gain, t, 0.0015, p.blip, p.dur * 0.8);
      const blip = v.osc('triangle', pitch * p.blipRatio * 1.6, t, blipEnd, bg);
      blip.frequency.exponentialRampToValueAtTime(pitch * p.blipRatio, t + 0.02);

      // Heavier slopes add body and a second scrape of loose rock.
      if (p.thump > 0) thump(v, t, 105, 58, p.thump, p.dur + 0.008);
      if (p.scrape > 0) {
        grain(v, t + 0.022, 'bandpass', pitch * 2.6, 0.8, noise * p.scrape, 0.006, 0.045);
      }
    });
  }

  bump(): void {
    this.play('bump', 0.06, (t) => {
      const v = this.voice({});
      // Padded-drum body falling 110 -> 45 Hz, plus an overtone kept above ~170 Hz so it reads on small speakers.
      thump(v, t, 110, 45, 0.3, 0.145, 0.004);
      thump(v, t, 260, 170, 0.16, 0.075, 0.003);
      // A scuff of dirt, in the band laptop and phone speakers play well.
      grain(v, t, 'bandpass', 700, 1, 0.8, 0.002, 0.06);
    });
  }

  cacheCollected(): void {
    this.play('cacheCollected', 0.05, (t) => {
      const v = this.voice({ reverb: 0.3 });
      // C6 E6 G6 C7 arpeggio, spreading left to right.
      const notes = [84, 88, 91, 96];
      notes.forEach((note, i) => {
        const last = i === notes.length - 1;
        bell(v, {
          freq: midi(note),
          t: t + i * 0.065,
          peak: last ? 0.2 : 0.17,
          decay: last ? 0.5 : 0.3,
          pan: -0.24 + i * 0.16,
          shimmer: last,
        });
      });
      // A faint sparkle over the top.
      bell(v, { freq: midi(103), t: t + 0.25, peak: 0.04, decay: 0.3, pan: 0.32 });
    });
  }

  discovery(kind: DiscoveryKind): void {
    this.play(`discovery:${kind}`, 0.1, (t) => {
      switch (kind) {
        case 'peak':
          this.peakChime(t);
          break;
        case 'summit':
          this.summitMotif(t);
          break;
        case 'cache':
          this.cachePing(t);
          break;
        case 'panorama':
          this.panoramaSwell(t);
          break;
      }
    });
  }

  lowStamina(): void {
    // At most one heartbeat per ~0.9 s however fast the player moves.
    this.play('lowStamina', 0.85, (t) => {
      const v = this.voice({ level: 0.8 });
      // Lub-dub, starting just after the footstep of the same move so the step does not mask the lub.
      const lub = t + 0.07;
      this.heartbeat(v, lub, 64, 0.26);
      this.heartbeat(v, lub + 0.19, 57, 0.18);
    });
  }

  victory(): void {
    this.play('victory', 0.5, (t) => {
      this.releaseLong(0.3);
      const v = this.voice({ reverb: 0.32, long: true });
      const beat = 0.42;

      // I - IV - V - I in C, voiced for smooth voice leading, over a moving bass.
      const chords: { at: number; dur: number; bass: readonly number[]; notes: readonly number[] }[] = [
        { at: 0, dur: beat - 0.05, bass: [48], notes: [64, 67, 72] },
        { at: beat, dur: beat - 0.05, bass: [41], notes: [65, 69, 72] },
        { at: beat * 2, dur: beat - 0.05, bass: [43], notes: [62, 67, 71] },
        { at: beat * 3, dur: 1.38, bass: [36, 48], notes: [55, 64, 67, 72] },
      ];
      chords.forEach((c, ci) => {
        const final = ci === chords.length - 1;
        const release = final ? 0.42 : 0.12;
        for (const b of c.bass) brass(v, { freq: midi(b), t: t + c.at, dur: c.dur, peak: 0.13, release, bright: 0.8 });
        c.notes.forEach((n, i) => {
          brass(v, {
            freq: midi(n),
            t: t + c.at + i * 0.008,
            dur: c.dur,
            peak: 0.11,
            release,
            pan: (i - (c.notes.length - 1) / 2) * 0.28,
          });
        });
        // Timpani on every chord change, a bigger hit on the last.
        thump(v, t + c.at, final ? 92 : 98, 50, final ? 0.42 : 0.3, final ? 0.6 : 0.28);
      });

      // Melody: pickup pairs climbing through each chord, resolving D6 -> C6 on the final tonic.
      const melody: readonly (readonly [number, number, number])[] = [
        [76, 0, 0.11],
        [79, 0.14, 0.22],
        [81, beat, 0.11],
        [84, beat + 0.14, 0.22],
        [83, beat * 2, 0.11],
        [86, beat * 2 + 0.14, 0.22],
        [84, beat * 3, 1.38],
      ];
      melody.forEach(([note, at, dur], i) => {
        const final = i === melody.length - 1;
        brass(v, {
          freq: midi(note),
          t: t + at,
          dur,
          peak: 0.19,
          release: final ? 0.45 : 0.08,
          bright: 1.35,
          vibrato: final,
        });
      });

      // Sparkle and a soft cymbal wash on the final chord.
      const shine = t + beat * 3;
      [91, 96, 100].forEach((note, i) => {
        bell(v, { freq: midi(note), t: shine + 0.05 + i * 0.06, peak: 0.06, decay: 0.9, pan: -0.3 + i * 0.3 });
      });
      grain(v, shine, 'highpass', 5200, 0.7, 0.08, 0.012, 1.3);
    });
  }

  defeat(): void {
    this.play('defeat', 0.5, (t) => {
      this.releaseLong(0.3);
      const v = this.voice({ reverb: 0.22, long: true });
      const end = t + 3.55;

      // Drone amplitude: slow swell, brief hold, then a long fade that stays audible almost to the end.
      const amp = v.gain(v.out);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(0.25, t + 0.35);
      amp.gain.setValueAtTime(0.25, t + 1.1);
      amp.gain.exponentialRampToValueAtTime(0.012, t + 3.3);
      amp.gain.exponentialRampToValueAtTime(EPS, end);
      amp.gain.setValueAtTime(0, end);

      // Resonant lowpass sweeping down: the colour draining out of the ink.
      const lp = v.filter('lowpass', 950, 4, amp);
      lp.frequency.setValueAtTime(950, t);
      lp.frequency.exponentialRampToValueAtTime(85, t + 3.3);

      // A1 and a slightly sharp partner beating slowly, a sub octave, and a faint minor third.
      const layers: readonly (readonly [OscillatorType, number, number])[] = [
        ['sawtooth', 55, 0.5],
        ['sawtooth', 55 * cents(17), 0.45],
        ['sine', 27.5, 0.45],
        ['triangle', midi(36), 0.22],
      ];
      for (const [type, freq, level] of layers) {
        const g = v.gain(lp, level);
        const o = v.osc(type, freq, t, end, g);
        // Slow pitch sag over the whole drone.
        o.detune.setValueAtTime(0, t);
        o.detune.linearRampToValueAtTime(-140, end);
      }

      // Dark hush of noise, like ink soaking into paper.
      const ng = v.gain(v.out);
      const nlp = v.filter('lowpass', 700, 0.5, ng);
      nlp.frequency.setValueAtTime(700, t);
      nlp.frequency.exponentialRampToValueAtTime(140, t + 3.2);
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(0.3, t + 0.6);
      ng.gain.exponentialRampToValueAtTime(EPS, t + 3.4);
      ng.gain.setValueAtTime(0, t + 3.4);
      v.noise(t, t + 3.4, nlp);

      // One low toll to mark the moment.
      bell(v, { freq: midi(45), t, peak: 0.12, decay: 2.4, attack: 0.008 });
    });
  }

  expeditionStart(): void {
    this.play('expeditionStart', 0.1, (t) => {
      const v = this.voice({ reverb: 0.28 });
      // Pen tick on paper: nib down, then a lighter lift.
      grain(v, t, 'highpass', 3400, 0.7, 0.34, 0.001, 0.014);
      grain(v, t + 0.045, 'highpass', 4200, 0.7, 0.16, 0.001, 0.01);
      // Ascending open-interval bells: E5 A5 E6.
      bell(v, { freq: midi(76), t: t + 0.09, peak: 0.12, decay: 0.24, pan: -0.15 });
      bell(v, { freq: midi(81), t: t + 0.2, peak: 0.12, decay: 0.26, pan: 0 });
      bell(v, { freq: midi(88), t: t + 0.31, peak: 0.13, decay: 0.55, pan: 0.15, shimmer: true });
    });
  }

  stopAll(): void {
    try {
      this.releaseLong(0.12);
      this.lastPlayed.delete('victory');
      this.lastPlayed.delete('defeat');
    } catch {
      // Nothing playing that can be stopped.
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private init(): void {
    try {
      const ctx = this.factory();
      if (!ctx) {
        this.unavailable = true;
        return;
      }
      const master = ctx.createGain();
      master.gain.value = this.isMuted ? 0 : MASTER_LEVEL;
      // Gentle limiter: only the loudest moments (fanfare, drone) touch it.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -9;
      comp.knee.value = 8;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      // A new compressor starts fully clamped (-13 dB at 10 ms, -3 dB at 80 ms) and would swallow the start
      // jingle that the unlocking keydown plays, so it releases fast for its first moments.
      comp.release.setValueAtTime(0.005, ctx.currentTime);
      comp.release.setValueAtTime(0.22, ctx.currentTime + 0.05);
      master.connect(comp);
      comp.connect(ctx.destination);
      // The reverb input is cheap and exists at once so every voice can send to it.
      const reverbIn = ctx.createBiquadFilter();
      reverbIn.type = 'highpass';
      reverbIn.frequency.value = 280;
      const bus: Bus = { ctx, master, reverbIn, noise: makeNoise(ctx, NOISE_SECONDS), lead: schedulingLead(ctx) };
      this.bus = bus;
      // Synthesising the room impulse and handing it to the convolver takes ~16 ms, so on a live context
      // it runs after the keydown that unlocked audio instead of holding it up; whatever is sent before
      // then stays dry. Offline renders have no gesture to protect and attach it at once.
      if (isOffline(ctx)) this.attachReverb(bus, reverbIn);
      else setTimeout(() => this.attachReverb(bus, reverbIn), 0);
    } catch {
      this.unavailable = true;
      this.bus = null;
    }
  }

  /** Put the shared room reverb behind `input`, or drop the bus's send if convolution is unavailable. */
  private attachReverb(bus: Bus, input: AudioNode): void {
    try {
      const conv = bus.ctx.createConvolver();
      conv.buffer = makeImpulse(bus.ctx, REVERB_SECONDS);
      const ret = bus.ctx.createGain();
      ret.gain.value = REVERB_RETURN;
      conv.connect(ret);
      ret.connect(bus.master);
      input.connect(conv);
    } catch {
      // Voices built from now on skip the send and stay dry.
      bus.reverbIn = null;
    }
  }

  /** Run a sound recipe if audio is live and unmuted, honouring a per-sound retrigger gap. Never throws. */
  private play(key: string, minGap: number, build: (t: number) => void): void {
    const bus = this.bus;
    if (!bus || this.isMuted || bus.ctx.state === 'closed') return;
    try {
      const now = bus.ctx.currentTime;
      const last = this.lastPlayed.get(key);
      if (last !== undefined && now >= last && now - last < minGap) return;
      this.lastPlayed.set(key, now);
      this.sweep(now);
      build(now + bus.lead);
    } catch {
      // A failed sound must never interrupt the game.
    }
  }

  private voice(opts: VoiceOptions): Voice {
    const bus = this.bus;
    if (!bus) throw new Error('audio not initialised');
    if (this.voices.size >= MAX_VOICES) {
      for (const old of this.voices) {
        if (!old.long && !old.isReleased) {
          old.release(0.02);
          break;
        }
      }
    }
    const v = new Voice(bus, opts, (done) => this.forget(done));
    this.voices.add(v);
    return v;
  }

  /** Footsteps share a small pool: the oldest is choked when the cap is reached. */
  private footstepVoice(): Voice {
    while (this.footsteps.length >= MAX_FOOTSTEP_VOICES) {
      this.footsteps.shift()?.release(0.012);
    }
    const v = this.voice({});
    this.footsteps.push(v);
    return v;
  }

  private forget(v: Voice): void {
    this.voices.delete(v);
    const i = this.footsteps.indexOf(v);
    if (i >= 0) this.footsteps.splice(i, 1);
  }

  private releaseLong(fade: number): void {
    for (const v of this.voices) if (v.long) v.release(fade);
  }

  /** Force-dispose voices whose sources are long overdue (in case an onended event was lost). */
  private sweep(now: number): void {
    for (const v of this.voices) if (v.endAt + STALE_VOICE_GRACE < now) v.dispose();
  }

  // -------------------------------------------------------------------------
  // Recipes used by discovery() / lowStamina()
  // -------------------------------------------------------------------------

  /** Two-note rising bell (G5 -> D6) with shimmer. */
  private peakChime(t: number): void {
    const v = this.voice({ reverb: 0.45 });
    bell(v, { freq: midi(79), t, peak: 0.16, decay: 0.55, pan: -0.12, shimmer: true });
    bell(v, { freq: midi(86), t: t + 0.14, peak: 0.18, decay: 0.85, pan: 0.12, shimmer: true });
  }

  /** The Ancient Trig Pillar sighted: a five-note climb to C6 over a warm open-fifth pad. */
  private summitMotif(t: number): void {
    const v = this.voice({ reverb: 0.5, long: true });
    const motif: readonly (readonly [number, number, number])[] = [
      [67, 0, 0.45],
      [72, 0.13, 0.45],
      [76, 0.26, 0.5],
      [79, 0.39, 0.65],
      [84, 0.56, 1.7],
    ];
    motif.forEach(([note, at, decay], i) => {
      const last = i === motif.length - 1;
      bell(v, {
        freq: midi(note),
        t: t + at,
        peak: last ? 0.22 : 0.16,
        decay,
        pan: -0.3 + i * 0.15,
        shimmer: i >= 3,
      });
    });
    pad(v, { notes: [48, 55, 60, 67], t: t + 0.45, attack: 0.5, hold: 0.55, release: 1.1, peak: 0.032, cutoff: 1500 });
    [100, 103, 108].forEach((note, i) => {
      bell(v, { freq: midi(note), t: t + 0.64 + i * 0.09, peak: 0.04, decay: 0.45, pan: 0.35 - i * 0.2 });
    });
  }

  /** First sighting of a supply cache: one soft ping. */
  private cachePing(t: number): void {
    const v = this.voice({ reverb: 0.35 });
    bell(v, { freq: midi(88), t, peak: 0.1, decay: 0.4, attack: 0.005 });
  }

  /** Panoramic survey burst: a wind-like filtered noise sweep with open-fifth and major-chord bells. */
  private panoramaSwell(t: number): void {
    const v = this.voice({ reverb: 0.55, long: true });

    const ng = v.gain(v.out);
    const bp = v.filter('bandpass', 320, 0.9, ng);
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + 0.9);
    bp.frequency.exponentialRampToValueAtTime(1100, t + 1.9);
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.4, t + 0.75);
    ng.gain.exponentialRampToValueAtTime(EPS, t + 1.95);
    ng.gain.setValueAtTime(0, t + 1.95);
    v.noise(t, t + 1.95, bp);

    // Airy sine chord swelling with the wind (C5 E5 G5).
    pad(v, { notes: [72, 76, 79], t, attack: 0.7, hold: 0.25, release: 0.95, peak: 0.018, cutoff: 2600, type: 'sine' });

    // Open fifth, then the major-chord bells above it.
    bell(v, { freq: midi(72), t: t + 0.32, peak: 0.07, decay: 0.9, pan: -0.3 });
    bell(v, { freq: midi(79), t: t + 0.4, peak: 0.07, decay: 0.9, pan: 0.3 });
    bell(v, { freq: midi(84), t: t + 0.56, peak: 0.06, decay: 1.0, pan: -0.12, shimmer: true });
    bell(v, { freq: midi(88), t: t + 0.64, peak: 0.055, decay: 1.1, pan: 0.12, shimmer: true });
  }

  /** One "lub" of the heartbeat: sub-bass body plus a mid-band knock that small speakers can play. */
  private heartbeat(v: Voice, t: number, freq: number, peak: number): void {
    thump(v, t, freq, freq * 0.64, peak, 0.15, 0.01);
    thump(v, t, freq * 2, freq * 1.3, peak * 0.3, 0.07, 0.008);
    thump(v, t, freq * 5, freq * 3.5, peak * 0.6, 0.06, 0.004);
  }
}
