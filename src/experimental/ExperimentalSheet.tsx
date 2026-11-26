import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { BUILD_ID } from '../lib/build';
import { Sheet } from '../ui/common';
import { FEATURES } from './features';
import './experimental.css';

/** The experimental build's mark in the home screen header. It opens the list of what this build is trying. */
export function ExperimentalButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="icon-btn exp-btn" aria-label="Experimental features" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <FlaskConical size={22} />
      </button>
      {/* Outside the page, so the page's own heading styles don't reach the sheet's title. */}
      {open && createPortal(<ExperimentalSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ExperimentalSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Experimental features" onClose={onClose} tall closeIcon="x">
      <p className="note">
        This is ReelForge Experimental, where new features are tried before everyone gets them. It keeps its own projects
        and clips, apart from ReelForge. To bring your work over, make a backup in ReelForge and restore it here.
      </p>
      {FEATURES.length > 0 ? (
        <ul className="exp-features">
          {FEATURES.map((f) => (
            <li key={f.id}>
              <b>{f.name}</b>
              <p className="note">{f.description}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">Nothing to try yet. New features show up here first.</p>
      )}
      <p className="note tnum">Build {BUILD_ID}</p>
    </Sheet>
  );
}
