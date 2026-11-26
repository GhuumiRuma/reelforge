import type { ComponentType } from 'react';

/** A feature ReelForge Experimental is trying, as its Experimental features sheet lists it. */
export interface ExperimentalFeature {
  id: string;
  name: string;
  /** One or two sentences: what it does and how to try it. */
  description: string;
}

/**
 * Everything the rest of the app sees of the Experimental features section, through `@experimental`. The
 * experimental build gets ./index.ts and every other build gets ./off.ts, so both must give the same shape.
 */
export interface Experimental {
  /** The home screen header's button for the Experimental features sheet; null outside the experimental build. */
  HomeButton: ComponentType | null;
}
