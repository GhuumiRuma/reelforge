import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { backDepth } from './lib/back';
import { useRoute } from './lib/route';
import { useEditor } from './state/store';
import { Progress } from './ui/common';
import { DialogHost } from './ui/dialog';
import { Editor } from './ui/Editor';
import { Home } from './ui/Home';
import { Studio } from './ui/Studio';

/**
 * Selects the active top-level screen and mounts feedback UI shared by every route.
 *
 * Routing is hash/history based rather than a client-side router. Escape mirrors
 * the native back action only while a sheet or dialog has registered a back-stack
 * entry, so ordinary key presses never navigate away from the app.
 */
export function App() {
  const route = useRoute();
  useEffect(() => {
    // Escape behaves like the phone's back button: it closes the topmost sheet or dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && backDepth() > 0) {
        e.preventDefault();
        history.back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      {route.name === 'editor' ? <Editor key={route.id} id={route.id} /> : route.name === 'studio' ? <Studio /> : <Home />}
      <TaskPill />
      <Toasts />
      <DialogHost />
    </>
  );
}

/**
 * Renders the editor store's bounded toast queue as a polite live region.
 *
 * Each toast is a button so it can be dismissed with either pointer or keyboard;
 * store-owned timers also remove it after its severity-specific lifetime.
 */
function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === 'error' && <TriangleAlert size={18} aria-hidden />}
          {t.kind === 'success' && <CircleCheck size={18} aria-hidden />}
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Shows long-running work, such as local transcription or export, above the UI.
 *
 * A `null` progress value represents an indeterminate task, while numeric values
 * are normalized by the shared progress component.
 */
function TaskPill() {
  const task = useEditor((s) => s.task);
  if (!task) return null;
  return (
    <div className="task" role="status" aria-live="polite">
      <span>{task.label}</span>
      <Progress value={task.progress} />
    </div>
  );
}
