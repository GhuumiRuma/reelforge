import { LoaderCircle, Pipette } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BackgroundRemoval } from '../types';
import { getBackgroundStatus, subscribeBackgroundStatus } from '../engine/background';
import { formatBytes } from '../lib/util';
import { gesture, Segmented, Slider, Swatches } from './common';

const KEY_COLORS = ['#00ff00', '#00b140', '#0047bb', '#0000ff'];
const pct = (value: number) => `${Math.round(value * 100)}%`;
const off = (format: (value: number) => string) => (value: number) => (value <= 0 ? 'Off' : format(value));

export function BackgroundRemovalControls({
  value,
  onChange,
  onPickColor,
  picking = false,
  disabled = false,
}: {
  value: BackgroundRemoval;
  onChange: (patch: Partial<BackgroundRemoval>, merge?: string) => void;
  onPickColor?: () => void;
  picking?: boolean;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState(getBackgroundStatus);
  useEffect(() => {
    const unsubscribe = subscribeBackgroundStatus(setStatus);
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <>
      <Segmented
        label="Remove background"
        value={value.mode}
        disabled={disabled}
        options={[
          { value: 'off', label: 'Keep' },
          { value: 'color', label: 'Color' },
          { value: 'subject', label: 'Auto' },
        ]}
        onChange={(mode) => onChange({ mode })}
      />

      {value.mode === 'color' && (
        <>
          <Swatches
            label="Color to remove"
            colors={KEY_COLORS}
            value={value.color}
            onChange={(color) => onChange({ mode: 'color', color }, 'background-color')}
          />
          {onPickColor && (
            <button className="secondary-btn block" aria-expanded={picking} disabled={disabled} onClick={onPickColor}>
              <Pipette size={18} aria-hidden />
              {picking ? 'Cancel' : 'Pick color from clip'}
            </button>
          )}
          <Slider
            label="Strength"
            value={value.similarity}
            min={0.05}
            max={1}
            step={0.01}
            format={pct}
            disabled={disabled}
            onChange={(similarity) => onChange({ mode: 'color', similarity })}
            {...gesture}
          />
          <Slider
            label="Edge softness"
            value={value.smoothness}
            min={0}
            max={0.4}
            step={0.01}
            format={off((amount) => pct(amount / 0.4))}
            disabled={disabled}
            onChange={(smoothness) => onChange({ mode: 'color', smoothness })}
            {...gesture}
          />
        </>
      )}

      {value.mode === 'subject' && (
        <>
          <p className="note">
            Automatic cutout works best with one clearly separated person in portrait view. The model runs on this device during preview and
            export; your media is never uploaded.
          </p>
          <Slider
            label="Edge softness"
            value={value.feather}
            min={0.01}
            max={0.49}
            step={0.01}
            format={pct}
            disabled={disabled}
            onChange={(feather) => onChange({ mode: 'subject', feather })}
            {...gesture}
          />
          {status.phase === 'download' && (
            <p className="note" role="status">
              <LoaderCircle className="spin" size={16} aria-hidden /> Downloading the one-time cutout model
              {status.total ? ` · ${formatBytes(status.loaded ?? 0)} of ${formatBytes(status.total)}` : '…'}
            </p>
          )}
          {status.phase === 'segment' && (
            <p className="note" role="status">
              <LoaderCircle className="spin" size={16} aria-hidden /> Analyzing this frame on your device…
            </p>
          )}
          {status.phase === 'error' && (
            <p className="error-text" role="alert">
              {status.message}
            </p>
          )}
        </>
      )}
    </>
  );
}
