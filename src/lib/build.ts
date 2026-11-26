/**
 * Commit identifier embedded by the build, or `"dev"` for local runs.
 *
 * Backup metadata and update reminders consume it; checking the build-time global here keeps
 * unbuilt tests and browser development independent of runtime configuration.
 */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' && __BUILD_ID__ ? __BUILD_ID__ : 'dev';
