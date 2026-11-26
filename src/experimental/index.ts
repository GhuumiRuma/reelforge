/**
 * `@experimental` in ReelForge Experimental (`--mode experimental`): the Experimental features section. Only that
 * build includes anything from this folder (see README.md here); every other build gets ./off.ts instead.
 */
import { ExperimentalButton } from './ExperimentalSheet';
import type { Experimental } from './types';

export const experimental: Experimental = { HomeButton: ExperimentalButton };
