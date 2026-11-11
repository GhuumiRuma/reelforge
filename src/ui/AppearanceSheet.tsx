import { MonitorSmartphone, Moon, RotateCcw, Sun } from 'lucide-react';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { ACCENTS, CORNERS, STYLES, STYLE_IDS, accentName, accentSet, isDefaultLook } from '../state/appearance';
import type { StyleId } from '../state/appearance';
import { resetAppearance, setLook, setThemePref, useTheme } from '../state/theme';
import type { Theme, ThemePref } from '../state/theme';
import { Segmented, Sheet, Swatches } from './common';

const MODES: { value: ThemePref; label: ReactNode }[] = [
  {
    value: 'system',
    label: (
      <>
        <MonitorSmartphone size={16} aria-hidden /> System
      </>
    ),
  },
  {
    value: 'light',
    label: (
      <>
        <Sun size={16} aria-hidden /> Light
      </>
    ),
  },
  {
    value: 'dark',
    label: (
      <>
        <Moon size={16} aria-hidden /> Dark
      </>
    ),
  },
];

const ACCENT_COLORS = ACCENTS.map((a) => a.value);
const CORNER_OPTIONS = CORNERS.map((c) => ({ value: c.id, label: c.name }));

/** A style as it looks in this theme with this accent, for its tile. The tile's own palette, not the page's. */
function mockVars(id: StyleId, theme: Theme, accent: string): CSSProperties {
  const p = STYLES[id][theme];
  const a = accentSet(id, accent, theme);
  return {
    '--m-stage': p.stage,
    '--m-raised': p.raised,
    '--m-line': p.line,
    '--m-text': p.text,
    '--m-dim': p.dim,
    '--m-accent': a.accent,
    '--m-fill': a.fill,
  } as CSSProperties;
}

/** A small editor made of the page's own tokens, so it follows every choice below it as it is made. */
function Preview() {
  return (
    <div className="look-preview" aria-hidden>
      <div className="lp-bar">
        <span className="lp-title">
          My video
          <small>0:24 · 1080p</small>
        </span>
        <span className="lp-btn">Export</span>
      </div>
      <div className="lp-lane">
        <i className="lp-clip" />
        <i className="lp-clip on" />
        <i className="lp-clip" />
        <i className="lp-head" />
      </div>
    </div>
  );
}

function StyleTiles() {
  const theme = useTheme((s) => s.theme);
  const style = useTheme((s) => s.look.style);
  const accent = useTheme((s) => s.look.accent);
  const vars = useMemo(() => STYLE_IDS.map((id) => mockVars(id, theme, accent)), [theme, accent]);

  return (
    <div className="look-tiles" role="group" aria-label="Style">
      {STYLE_IDS.map((id, i) => (
        <button key={id} className="tile look-tile" aria-pressed={id === style} style={vars[i]} onClick={() => setLook({ style: id })}>
          <span className="look-mock" aria-hidden>
            <i className="lm-text" />
            <i className="lm-dim" />
            <span className="lm-row">
              <i className="lm-card" />
              <i className="lm-pill" />
            </span>
          </span>
          <span className="look-name">{STYLES[id].name}</span>
        </button>
      ))}
    </div>
  );
}

/** Mode, style, accent color and corners. Every change applies and is saved straight away. */
export function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const pref = useTheme((s) => s.pref);
  const theme = useTheme((s) => s.theme);
  const look = useTheme((s) => s.look);
  const style = STYLES[look.style];

  return (
    <Sheet title="Appearance" onClose={onClose} tall>
      <Preview />

      <div className="field">
        <div className="field-label">
          <span>Mode</span>
          {pref === 'system' && <b>Device is {theme}</b>}
        </div>
        <Segmented label="Mode" value={pref} options={MODES} onChange={setThemePref} />
      </div>

      <div className="field">
        <div className="field-label">
          <span>Style</span>
          <b>{style.name}</b>
        </div>
        <StyleTiles />
        <p className="note">{style.blurb}</p>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Accent color</span>
          <b>{accentName(look.accent)}</b>
        </div>
        <Swatches
          label="Accent color"
          value={look.accent}
          colors={ACCENT_COLORS}
          nameOf={accentName}
          onChange={(accent) => setLook({ accent })}
        />
        <p className="note">Colors are adjusted a little where needed so text stays easy to read.</p>
      </div>

      <div className="field">
        <span className="field-label">Corners</span>
        <Segmented label="Corners" value={look.corners} options={CORNER_OPTIONS} onChange={(corners) => setLook({ corners })} />
      </div>

      <button className="secondary-btn block" disabled={pref === 'system' && isDefaultLook(look)} onClick={resetAppearance}>
        <RotateCcw size={18} aria-hidden />
        Reset to default
      </button>
    </Sheet>
  );
}
