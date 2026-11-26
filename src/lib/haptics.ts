/** Best-effort tactile feedback for Android and recent iOS web apps. */
import { isIOS } from './util';

let iosSwitch: HTMLLabelElement | null = null;
let last = 0;

/**
 * Creates and clicks a hidden native switch to trigger iOS's haptic behavior.
 *
 * This private compatibility path relies on iOS 18's native checkbox switch feedback and is kept
 * offscreen, non-focusable, and outside assistive technology's control tree.
 */
function iosTick() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

/** Light haptic tick: Android via the Vibration API, iOS 18+ via the native switch control trick. */
export function haptic(strength: 'light' | 'medium' = 'light') {
  const now = performance.now();
  if (now - last < 40) return;
  last = now;
  try {
    if (isIOS) iosTick();
    else navigator.vibrate?.(strength === 'light' ? 8 : 18);
  } catch {
    /* haptics are best-effort */
  }
}
