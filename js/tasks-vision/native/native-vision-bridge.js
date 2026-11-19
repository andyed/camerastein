/**
 * NativeVision — Camerastein's stand-in for Psychodeli's iOS bridge.
 *
 * dispatching-adapter.js (kept byte-identical with Psychodeli+) imports
 * NativeVision to ask whether the iOS vision plugin is present. Camerastein is
 * web-only (TODO.md, 2026-10-02), so the plugin never is: this module answers
 * "not available" and the dispatcher's preference order collapses to
 * worker → inline. Psychodeli's real bridge lives in its own repository.
 */

export const NativeVision = Object.freeze({
    available: false,
    lastStatus: null,
    capabilities: null,
    start: async () => { throw new Error('NativeVision is not available in Camerastein'); },
    stop: () => {},
});
