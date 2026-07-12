/**
 * Blendshape Channel — Extends MotionBus with face expression data.
 *
 * Tasks Vision's FaceLandmarker provides 52 ARKit-compatible blendshape
 * weights (browDown, eyeBlink, jawOpen, mouthSmile, etc.). This module
 * registers a new MotionBus channel so consumers can subscribe:
 *
 *   window.MotionBus.subscribe('faceBlendshapes', (data) => {
 *       data.shapes[0].categoryName  // e.g. "mouthSmileLeft"
 *       data.shapes[0].score         // 0.0 - 1.0
 *   });
 *
 *   window.MotionBus.state.blendshapes  // latest data or null
 *
 * Call initBlendshapeChannel() once after MotionBus exists.
 */

/**
 * Register the faceBlendshapes channel on MotionBus.
 * Safe to call multiple times — only registers once.
 */
export function initBlendshapeChannel() {
    const bus = window.MotionBus;
    if (!bus) return;

    // Already registered?
    if (bus._channels.faceBlendshapes) return;

    // Extend state and channel map at runtime (non-destructive)
    bus.state.blendshapes = null;
    bus._channels.faceBlendshapes = 'blendshapes';

    // Also register the raw face-landmarks channel (emitted by face-shim.js)
    bus.state.landmarks = null;
    bus._channels.faceLandmarks = 'landmarks';
}

/**
 * Key blendshape names grouped by region, for reference.
 * These are the ARKit-compatible names returned by FaceLandmarker.
 */
export const BLENDSHAPE_GROUPS = {
    brows: [
        'browDownLeft', 'browDownRight', 'browInnerUp',
        'browOuterUpLeft', 'browOuterUpRight'
    ],
    eyes: [
        'eyeBlinkLeft', 'eyeBlinkRight',
        'eyeLookDownLeft', 'eyeLookDownRight',
        'eyeLookInLeft', 'eyeLookInRight',
        'eyeLookOutLeft', 'eyeLookOutRight',
        'eyeLookUpLeft', 'eyeLookUpRight',
        'eyeSquintLeft', 'eyeSquintRight',
        'eyeWideLeft', 'eyeWideRight'
    ],
    jaw: ['jawForward', 'jawLeft', 'jawOpen', 'jawRight'],
    mouth: [
        'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
        'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
        'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
        'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
        'mouthRight', 'mouthRollLower', 'mouthRollUpper',
        'mouthShrugLower', 'mouthShrugUpper',
        'mouthSmileLeft', 'mouthSmileRight',
        'mouthStretchLeft', 'mouthStretchRight',
        'mouthUpperUpLeft', 'mouthUpperUpRight'
    ],
    cheeks: ['cheekPuff', 'cheekSquintLeft', 'cheekSquintRight'],
    nose: ['noseSneerLeft', 'noseSneerRight'],
};
