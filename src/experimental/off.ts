/**
 * `@experimental` in every build except ReelForge Experimental, including the public website and APK: nothing at
 * all. vite.config.ts points `@experimental` here and stops the build if any other file in this folder would be
 * part of it.
 */
import type { Experimental } from './types';

export const experimental: Experimental = { HomeButton: null };
