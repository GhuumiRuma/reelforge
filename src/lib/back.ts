/**
 * Browser-history-backed stack for modal back-button behavior.
 *
 * Entries are registered while a sheet or dialog is open so Android's hardware back action (and
 * iOS's history gesture) closes the topmost surface. Programmatic `history.back()` calls are
 * tracked separately because their `popstate` event arrives asynchronously.
 */
import { useEffect, useRef } from 'react';

/**
 * Hardware/gesture "back" support: every open sheet or dialog pushes a history entry so the
 * Android back button (or iOS edge swipe in the installed app) closes it instead of leaving.
 */
interface Entry {
  id: number;
  close: () => void;
  /** whether its history entry exists yet (pushes wait for pending programmatic backs) */
  pushed: boolean;
}

const stack: Entry[] = [];
let seq = 0;
let ignore = 0;
let ignoreTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Pushes history entries for handlers that were queued while an ignored programmatic back was
 * still in flight. Ordering is preserved so the most recently opened surface remains on top.
 */
function flushPushes() {
  for (const e of stack) {
    if (e.pushed) continue;
    e.pushed = true;
    history.pushState({ rfBack: e.id }, '');
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (ignore > 0) {
      ignore--;
      if (ignore === 0) {
        if (ignoreTimer) clearTimeout(ignoreTimer);
        ignoreTimer = null;
        flushPushes();
      }
      return;
    }
    stack.pop()?.close();
  });
}

/**
 * Registers a handler as the next browser-back target.
 *
 * The returned release function removes the handler and rewinds its matching history entry when
 * the surface closes for another reason. Releases made during an in-flight rewind are coalesced;
 * the fallback timer prevents an unobserved `popstate` from permanently blocking later pushes.
 * This function requires a browser `history` implementation.
 *
 * @param close Callback invoked if a user pop targets this entry.
 * @returns An idempotent cleanup function suitable for component unmounts.
 */
export function pushBack(close: () => void): () => void {
  const id = ++seq;
  // history.back() is asynchronous; pushing before it lands would make it pop the new entry.
  const e: Entry = { id, close, pushed: ignore === 0 };
  stack.push(e);
  if (e.pushed) history.pushState({ rfBack: id }, '');
  return () => {
    const i = stack.findIndex((x) => x.id === id);
    if (i < 0) return;
    stack.splice(i, 1);
    if (!e.pushed) return;
    ignore++;
    history.back();
    // Safety net in case the popstate never arrives (should not happen).
    if (ignoreTimer) clearTimeout(ignoreTimer);
    ignoreTimer = setTimeout(() => {
      ignore = 0;
      ignoreTimer = null;
      flushPushes();
    }, 1500);
  };
}

/**
 * Hooks a mounted component into the browser-back stack while `active` is true.
 *
 * If `onBack` returns `false` (for example because an export is still running), the same handler
 * is re-armed behind a fresh history entry. The callback is read through a ref so a changed render
 * value is used without unregistering the history entry. Inactive changes and unmounts release the
 * entry only when the component did not already consume it.
 */
export function useBack(active: boolean, onBack: () => void | boolean) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active) return;
    let popped = false;
    let release = () => {};
    const arm = () => {
      popped = false;
      release = pushBack(() => {
        popped = true;
        if (ref.current() === false) arm();
      });
    };
    arm();
    return () => {
      if (!popped) release();
    };
  }, [active]);
}

/** Returns the number of currently registered sheet/dialog back targets. */
export function backDepth(): number {
  return stack.length;
}

/**
 * Waits until queued programmatic history rewinds have produced their `popstate` events.
 *
 * The timeout makes the wait best-effort for browsers that do not dispatch the event; in that case
 * the caller may continue while `flushPushes` is expected to recover later entries.
 */
export function settled(timeoutMs = 600): Promise<void> {
  const until = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => (ignore === 0 || performance.now() > until ? resolve() : setTimeout(check, 16));
    check();
  });
}
