import { useEffect, useRef, useState } from 'react';
import type { Band, DeckId, Mixer, Plan, TransitionKind } from '../../lib/protocol';
import { cmd, useDeck, useMixer, useMonitor, useRoom } from '../../lib/store';
import { deckPosition, mainGain, resolveCrossfade } from '../../lib/deckmath';
import { clock } from '../../lib/clock';
import { Fader } from './Fader';
import { Knob } from './Knob';
import './MixerColumn.css';

const pctFmt = (v: number) => `${Math.round(v * 100)}`;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Short names for the four transition kinds, shared with the queue planner.
 */
export const KIND_LABEL: Record<TransitionKind, string> = {
  cut: 'CUT',
  crossfade: 'FADE',
  fadeThrough: 'THRU',
  bassSwap: 'BASS',
};

export const DEFAULT_KIND: TransitionKind = 'crossfade';
export const DEFAULT_MS = 4000;

/** A plan's zero values mean "inherit the mixer default" — resolve them here. */
export function effectiveKind(plan: Plan | undefined, m: Mixer | null): TransitionKind {
  if (plan && plan.kind) return plan.kind;
  return m?.transitionKind ?? DEFAULT_KIND;
}

export function effectiveMs(plan: Plan | undefined, m: Mixer | null): number {
  if (plan && plan.durationMs > 0) return plan.durationMs;
  return m?.transitionMs ?? DEFAULT_MS;
}

/** `8.0s`, or nothing at all for a cut where duration is meaningless. */
export function fmtDur(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const KILL_APPROX =
  'Approximated. YouTube exposes no audio graph, so an EQ kill is applied as level attenuation — there is no real filtering.';

function Head({ label, chip, chipTitle }: { label: string; chip?: string; chipTitle?: string }) {
  return (
    <div className="mx-head">
      <span className="mx-head-label">{label}</span>
      {chip && (
        <span className="mx-chip" title={chipTitle}>
          {chip}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ monitor */

function MonitorSection() {
  const [mon, setMon] = useMonitor();
  return (
    <div className="mx-sec mx-monitor">
      <Head
        label="Monitor"
        chip="LOCAL"
        chipTitle="Headphone routing lives in this browser only — it is never sent to the audience."
      />
      <div className="mx-knobs">
        <Knob
          label="Cue Mix"
          value={mon.cueMix}
          min={0}
          max={1}
          onChange={(v) => setMon({ cueMix: clamp01(v) })}
          format={(v) => (v <= 0.005 ? 'MIX' : v >= 0.995 ? 'CUE' : pctFmt(v))}
          size={34}
        />
        <Knob
          label="Phones"
          value={mon.cueVol}
          min={0}
          max={1}
          onChange={(v) => setMon({ cueVol: clamp01(v) })}
          format={pctFmt}
          size={34}
        />
        <Knob
          label="Booth"
          value={mon.masterVol}
          min={0}
          max={1}
          onChange={(v) => setMon({ masterVol: clamp01(v) })}
          format={pctFmt}
          size={34}
        />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- eq kills */

const BANDS: { band: Band; label: string }[] = [
  { band: 'high', label: 'Hi' },
  { band: 'mid', label: 'Mid' },
  { band: 'low', label: 'Low' },
];

function killOn(band: Band, d: { killLow: boolean; killMid: boolean; killHigh: boolean } | null) {
  if (!d) return false;
  return band === 'low' ? d.killLow : band === 'mid' ? d.killMid : d.killHigh;
}

function EqGrid() {
  const a = useDeck('a');
  const b = useDeck('b');
  const decks: [DeckId, typeof a][] = [
    ['a', a],
    ['b', b],
  ];
  return (
    <div className="mx-sec mx-eq">
      <Head label="EQ Kill" chip="≈" chipTitle={KILL_APPROX} />
      <div className="mx-eq-grid">
        <span />
        <span className="mx-eq-ch deck-a">A</span>
        <span className="mx-eq-ch deck-b">B</span>
        {BANDS.map(({ band, label }) => (
          <div className="mx-eq-line" key={band}>
            <span className="mx-eq-band">{label}</span>
            {decks.map(([id, d]) => {
              const on = killOn(band, d);
              return (
                <button
                  key={id}
                  type="button"
                  className={`mx-kill deck-${id}${on ? ' is-on' : ''}`}
                  disabled={!d}
                  aria-pressed={on}
                  title={`Kill ${label.toUpperCase()} on deck ${id.toUpperCase()} — ${KILL_APPROX}`}
                  onClick={() => cmd({ action: 'deck.eqKill', deck: id, band, on: !on })}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- channel + metering */

/**
 * There is no PCM to meter — YouTube gives us no audio graph — so the bar is
 * driven by the deck's computed main gain plus a light musical animation
 * (fast attack, slow decay, playhead-seeded variation). Labelled LEVEL, not
 * "peak", because it is a computed level and not a measurement.
 */
function ChannelStrip({ id }: { id: DeckId }) {
  const deck = useDeck(id);
  const mixer = useMixer();
  const maskRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  const live = useRef({ deck, mixer });
  useEffect(() => {
    live.current = { deck, mixer };
  });

  useEffect(() => {
    let raf = 0;
    let lvl = 0;
    let peak = 0;
    let peakAt = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { deck: d, mixer: m } = live.current;
      const now = clock.now();
      let target = 0;
      if (d && m && d.video && d.playing) {
        const g = mainGain(d, id, m, now);
        const pos = deckPosition(d, now);
        const wob = 0.74 + 0.26 * (0.5 + 0.5 * Math.sin(pos * 9.7) * Math.cos(pos * 2.3 + 1.1));
        target = Math.min(1, g * wob * 1.06);
      }
      lvl += (target - lvl) * (target > lvl ? 0.5 : 0.07);
      if (lvl > peak) {
        peak = lvl;
        peakAt = now;
      } else if (now - peakAt > 800) {
        peak = Math.max(lvl, peak - 0.006);
      }
      if (maskRef.current) maskRef.current.style.height = `${(1 - lvl) * 100}%`;
      if (peakRef.current) {
        peakRef.current.style.bottom = `${peak * 100}%`;
        peakRef.current.style.opacity = peak > 0.02 ? '1' : '0';
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [id]);

  return (
    <div className={`mx-chan deck-${id}`}>
      <div className="mx-meter" title="Computed channel level (no PCM is available from YouTube)">
        <div ref={maskRef} className="mx-meter-mask" />
        <div ref={peakRef} className="mx-meter-peak" />
      </div>
      <Fader
        label={id.toUpperCase()}
        orientation="vertical"
        value={deck?.gain ?? 1}
        min={0}
        max={1}
        detent={1}
        disabled={!deck}
        format={pctFmt}
        onChange={(v) => cmd({ action: 'deck.gain', deck: id, gain: clamp01(v) })}
      />
    </div>
  );
}

function ChannelSection() {
  return (
    <div className="mx-sec mx-chans">
      <Head label="Level" chip="CALC" chipTitle="Level is computed from the mix, not measured from audio." />
      <div className="mx-chan-row">
        <ChannelStrip id="a" />
        <ChannelStrip id="b" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- crossfader */

const xfFmt = (v: number) =>
  Math.abs(v) < 0.01 ? 'CENTRE' : v < 0 ? `A ${Math.round(-v * 100)}` : `B ${Math.round(v * 100)}`;

function Crossfader() {
  const mixer = useMixer();
  const auto = mixer?.auto;
  const active = auto?.active ?? false;
  const [autoVal, setAutoVal] = useState<number | null>(null);

  // The server never streams fader positions: while an automation runs we
  // interpolate it locally so the cap animates itself.
  useEffect(() => {
    if (!mixer || !active) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setAutoVal(resolveCrossfade(mixer, clock.now()));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mixer, active]);

  const value = (active ? autoVal : null) ?? mixer?.crossfade ?? 0;
  const accent = value < -0.02 ? 'var(--a)' : value > 0.02 ? 'var(--b)' : 'var(--ink-2)';

  return (
    <div className="mx-sec mx-xf">
      <div className="mx-head">
        <span className="mx-head-label">Crossfade</span>
        <span className="mx-xf-val num">{xfFmt(value)}</span>
        {active && (
          <span className="mx-chip is-auto" title="Automation running — touch the fader to take over">
            AUTO
          </span>
        )}
      </div>
      <div className="mx-xf-row">
        <span className={`mx-xf-end deck-a${value < 0.98 ? ' is-live' : ''}`}>A</span>
        <div className="mx-xf-fader">
          <Fader
            label="Crossfade"
            orientation="horizontal"
            value={value}
            min={-1}
            max={1}
            detent={0}
            accent={accent}
            format={xfFmt}
            disabled={!mixer}
            onChange={(v) => cmd({ action: 'mixer.crossfade', value: v })}
          />
        </div>
        <span className={`mx-xf-end deck-b${value > -0.98 ? ' is-live' : ''}`}>B</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- transitions */

const KINDS: { kind: TransitionKind; label: string; title: string }[] = [
  { kind: 'cut', label: 'Cut', title: 'Cut — slam the crossfader across instantly' },
  { kind: 'crossfade', label: 'Fade', title: 'Fade — equal-power crossfade' },
  { kind: 'fadeThrough', label: 'Thru', title: 'Fade through — dip to the middle, then out the other side' },
  { kind: 'bassSwap', label: 'Bass', title: 'Bass swap — trade low ends across the blend' },
];

function TransitionBlock() {
  const mixer = useMixer();
  const autoDj = useRoom()?.autoDj.enabled ?? false;
  const kind = mixer?.transitionKind ?? 'crossfade';
  const secs = Math.min(30, Math.max(0.5, (mixer?.transitionMs ?? 4000) / 1000));
  const auto = mixer?.auto;
  const running = auto?.active ?? false;
  const toward: DeckId | null = running ? ((auto?.to ?? 0) >= 0 ? 'b' : 'a') : null;

  const sweepA = useRef<HTMLSpanElement | null>(null);
  const sweepB = useRef<HTMLSpanElement | null>(null);
  const live = useRef({ auto, toward });
  useEffect(() => {
    live.current = { auto, toward };
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { auto: a, toward: t } = live.current;
      let p = 0;
      if (a && a.active && a.durationMs > 0) {
        p = Math.min(1, Math.max(0, (clock.now() - a.startedAt) / a.durationMs));
      }
      const wa = t === 'a' ? p * 100 : 0;
      const wb = t === 'b' ? p * 100 : 0;
      if (sweepA.current) sweepA.current.style.width = `${wa}%`;
      if (sweepB.current) sweepB.current.style.width = `${wb}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const setDuration = (v: number) =>
    cmd({ action: 'mixer.transition', kind, durationMs: Math.round(Math.min(30, Math.max(0.5, v)) * 1000) });

  return (
    <div className="mx-sec mx-trans">
      <Head
        label="Transition"
        chip="DEFAULT"
        chipTitle="Queue items without a plan of their own inherit this kind and duration."
      />
      {autoDj && (
        <p className="mx-autohint" title="Auto-advance is enabled — the server fires these transitions for you. Firing manually still works and takes effect immediately.">
          Auto-advance is driving
        </p>
      )}
      <div className="mx-kinds" role="group" aria-label="Transition type">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className={`mx-kind${kind === k.kind ? ' is-on' : ''}`}
            aria-pressed={kind === k.kind}
            title={k.title}
            disabled={!mixer}
            onClick={() => cmd({ action: 'mixer.transition', kind: k.kind, durationMs: Math.round(secs * 1000) })}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="mx-dur">
        <Fader
          label="Duration"
          orientation="horizontal"
          value={secs}
          min={0.5}
          max={30}
          onChange={setDuration}
          accent="var(--ink-2)"
          disabled={!mixer || kind === 'cut'}
          format={(v) => `${v.toFixed(1)}s`}
        />
      </div>
      <div className="mx-fire-row">
        <button
          type="button"
          className={`mx-fire deck-a${toward === 'a' ? ' is-running' : ''}`}
          disabled={!mixer}
          title="Fire the transition towards deck A (1)"
          onClick={() => cmd({ action: 'mixer.fire', to: 'a' })}
        >
          <span ref={sweepA} className="mx-fire-sweep" />
          <span className="mx-fire-text">◀ Fire A</span>
        </button>
        <button
          type="button"
          className={`mx-fire deck-b${toward === 'b' ? ' is-running' : ''}`}
          disabled={!mixer}
          title="Fire the transition towards deck B (2)"
          onClick={() => cmd({ action: 'mixer.fire', to: 'b' })}
        >
          <span ref={sweepB} className="mx-fire-sweep" />
          <span className="mx-fire-text">Fire B ▶</span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- master */

function MasterRow() {
  const mixer = useMixer();
  return (
    <div className="mx-sec mx-master">
      <Fader
        label="Master Out"
        orientation="horizontal"
        value={mixer?.master ?? 1}
        min={0}
        max={1}
        detent={1}
        accent="var(--live)"
        format={pctFmt}
        disabled={!mixer}
        onChange={(v) => cmd({ action: 'mixer.master', value: clamp01(v) })}
      />
    </div>
  );
}

/* --------------------------------------------------------------------- root */

export function MixerColumn() {
  return (
    <section className="mixer" aria-label="Mixer">
      <MonitorSection />
      <EqGrid />
      <ChannelSection />
      <Crossfader />
      <TransitionBlock />
      <MasterRow />
    </section>
  );
}
