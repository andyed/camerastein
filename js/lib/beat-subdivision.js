/**
 * BeatSubdivision — the shared subdivision/octave matcher.
 *
 * "Is tempo A a {half / same / double} of tempo B" recurs all over the codebase:
 * SyntaxAnalyzer.calculateBeatSync (user tap vs music), the camera detectors'
 * beat-sync (head-bob / body vs music — head-bob-detector.js, body-motion-
 * detector.js), and TempoOctavePrior (human vs detector octave). Each had its
 * own copy of the same [0.5, 1, 2] loop. This is the single source for it.
 *
 * Deviation is reported relative to the CANDIDATE by default (so it reads as "how
 * far is the candidate from k× the reference"), matching SyntaxAnalyzer's existing
 * convention so calculateBeatSync's behaviour is preserved exactly. The camera
 * detectors instead normalised by the matched (k×reference) value — pass
 * {relativeTo:'matched'} to reproduce that convention exactly.
 */
(function () {
    'use strict';

    const DEFAULT_SUBDIVISIONS = [0.5, 1, 2];

    /**
     * Which subdivision k of referenceBPM best matches candidateBPM?
     *
     * @param {number} candidateBPM - tempo being tested (e.g. user's tap BPM)
     * @param {number} referenceBPM - the grid (e.g. music BPM, or detector rawBpm)
     * @param {Object} [opts]
     * @param {number[]} [opts.subdivisions=[0.5,1,2]]
     * @param {number} [opts.minBpm] - reject matched tempos below this
     * @param {number} [opts.maxBpm] - reject matched tempos above this
     * @param {'candidate'|'matched'} [opts.relativeTo='candidate'] - denominator for
     *          the deviation ratio. 'candidate' (default) reads as "how far is the
     *          candidate from k× the reference" (SyntaxAnalyzer / TempoOctavePrior
     *          convention). 'matched' normalises by k×reference instead — i.e.
     *          deviation = |k·reference − candidate| / (k·reference) — which is the
     *          convention the camera detectors' beat-sync historically used; pass it
     *          to reproduce their scores exactly.
     * @returns {?{k:number, matchedBPM:number, deviation:number}} null if inputs
     *          are invalid or every subdivision is filtered out of range.
     */
    function bestMatch(candidateBPM, referenceBPM, opts = {}) {
        if (!(candidateBPM > 0) || !(referenceBPM > 0)) return null;
        const subs = opts.subdivisions || DEFAULT_SUBDIVISIONS;
        const min = typeof opts.minBpm === 'number' ? opts.minBpm : -Infinity;
        const max = typeof opts.maxBpm === 'number' ? opts.maxBpm : Infinity;
        const relMatched = opts.relativeTo === 'matched';
        let best = null;
        for (const k of subs) {
            const matchedBPM = k * referenceBPM;
            if (matchedBPM < min || matchedBPM > max) continue;
            // matchedBPM is > 0 (k>0, referenceBPM>0); candidateBPM is guarded > 0 above.
            const denom = relMatched ? matchedBPM : candidateBPM;
            const deviation = Math.abs(matchedBPM - candidateBPM) / denom;
            if (!best || deviation < best.deviation) best = { k, matchedBPM, deviation };
        }
        return best;
    }

    /**
     * 0..1 sync score within a tolerance (SyntaxAnalyzer.calculateBeatSync
     * semantics): 1 at a perfect match, decaying linearly to 0 at the tolerance
     * edge, and 0 when no subdivision lands inside tolerance.
     *
     * @param {number} candidateBPM
     * @param {number} referenceBPM
     * @param {number} tolerance - max relative deviation that still scores > 0
     * @param {Object} [opts] - forwarded to bestMatch
     * @returns {number} 0..1
     */
    function syncScore(candidateBPM, referenceBPM, tolerance, opts = {}) {
        const m = bestMatch(candidateBPM, referenceBPM, opts);
        if (!m || !(tolerance > 0) || m.deviation >= tolerance) return 0;
        return 1 - (m.deviation / tolerance);
    }

    window.BeatSubdivision = { bestMatch, syncScore, DEFAULT_SUBDIVISIONS };
})();
