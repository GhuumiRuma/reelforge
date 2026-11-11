import { MonitorSmartphone, Moon, Sun, SunMoon } from 'lucide-react';
import type { ReactNode } from 'react';
import { setThemePref, useTheme } from '../state/theme';
import type { ThemePref } from '../state/theme';
import { menuDialog } from './dialog';

const OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System default', icon: <MonitorSmartphone size={20} /> },
  { value: 'light', label: 'Light', icon: <Sun size={20} /> },
  { value: 'dark', label: 'Dark', icon: <Moon size={20} /> },
];

/** Opens the Appearance menu: follow the device, or stay light or dark. */
export function ThemeButton() {
  const pref = useTheme((s) => s.pref);

  const choose = async () => {
    const choice = await menuDialog({
      title: 'Appearance',
      items: OPTIONS.map((o) => ({ id: o.value, label: o.label, icon: o.icon, checked: o.value === pref })),
    });
    const next = OPTIONS.find((o) => o.value === choice);
    if (next) setThemePref(next.value);
  };

  return (
    <button className="icon-btn" aria-label="Appearance" onClick={() => void choose()}>
      <SunMoon size={22} />
    </button>
  );
}
