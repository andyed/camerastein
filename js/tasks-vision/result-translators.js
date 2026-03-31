/**
 * Result Translators — Pure functions that convert Tasks Vision API results
 * into the legacy MediaPipe result shapes that our detectors expect.
 *
 * These are the critical compatibility layer. Each detector's _onResults()
 * was written for the legacy API; these functions make Tasks Vision output
 * look identical.
 */

/**
 * FaceLandmarker → legacy FaceMesh result shape.
 *
 * Tasks Vision: result.faceLandmarks = Array<Array<{x,y,z}>> (478 per face)
 * Legacy:       results.multiFaceLandmarks = Array<Array<{x,y,z}>> (468 per face)
 *
 * 478 is a superset of 468 — extra landmarks 468-477 are iris points.
 * HeadBobDetector accesses up to index 473, so the extra points are useful.
 *
 * @param {Object} tasksResult - FaceLandmarker.detectForVideo() return value
 * @returns {Object} Legacy-shaped results for HeadBobDetector._onResults()
 */
export function translateFaceResults(tasksResult) {
    if (!tasksResult?.faceLandmarks?.length) {
        return { multiFaceLandmarks: [] };
    }
    return {
        multiFaceLandmarks: tasksResult.faceLandmarks
    };
}

/**
 * PoseLandmarker → legacy Pose result shape.
 *
 * Tasks Vision: result.landmarks = Array<Array<{x,y,z,visibility}>> (per-person, 33 each)
 * Legacy:       results.poseLandmarks = Array<{x,y,z,visibility}> (single person)
 *
 * visibility is CRITICAL — BodyMotionDetector gates arm/leg signals at 0.5 threshold.
 *
 * @param {Object} tasksResult - PoseLandmarker.detectForVideo() return value
 * @returns {Object} Legacy-shaped results for BodyMotionDetector._onResults()
 */
export function translatePoseResults(tasksResult) {
    if (!tasksResult?.landmarks?.length) {
        return { poseLandmarks: undefined };
    }
    return {
        poseLandmarks: tasksResult.landmarks[0]
    };
}

/**
 * HandLandmarker → legacy Hands result shape.
 *
 * Tasks Vision: result.landmarks = Array<Array<{x,y,z}>> (per-hand, 21 each)
 *               result.handedness = Array<Array<{score, categoryName}>> (nested)
 * Legacy:       results.multiHandLandmarks = Array<Array<{x,y,z}>>
 *               results.multiHandedness = Array<{score}> (flat)
 *
 * HandPoseDetector reads handedness[i].score — needs unwrapping from nested array.
 *
 * @param {Object} tasksResult - HandLandmarker.detectForVideo() return value
 * @returns {Object} Legacy-shaped results for HandPoseDetector._onResults()
 */
export function translateHandResults(tasksResult) {
    if (!tasksResult?.landmarks?.length) {
        return { multiHandLandmarks: [], multiHandedness: [] };
    }
    return {
        multiHandLandmarks: tasksResult.landmarks,
        multiHandedness: (tasksResult.handedness || []).map(h =>
            Array.isArray(h) && h.length > 0 ? h[0] : { score: 0.5 }
        )
    };
}
