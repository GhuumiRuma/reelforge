import { Palette } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AppearanceSheet } from './AppearanceSheet';

/** Opens the Appearance sheet: mode, style, accent color and corners. */
export function ThemeButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="icon-btn" aria-label="Appearance" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Palette size={22} />
      </button>
      {/* Outside the page, so the page's own heading styles don't reach the sheet's title. */}
      {open && createPortal(<AppearanceSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
