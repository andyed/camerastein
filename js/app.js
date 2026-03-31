/**
 * Camerastein — Main App
 *
 * Wires skeleton renderer, timeline, controls, and benchmark panel
 * to the MotionBus detection system.
 */

import { SkeletonRenderer } from './skeleton-renderer.js';
import { TimelinePanel } from './timeline-panel.js';
import { ControlsUI } from './controls-ui.js';
import { BenchmarkHarness } from './benchmark-harness.js';

// Wait for DOM
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('skeleton-canvas');
    const video = document.getElementById('video-feed');

    // Resize skeleton canvas to match container
    function resizeCanvas() {
        const area = document.getElementById('main-area');
        canvas.width = area.clientWidth;
        canvas.height = area.clientHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Initialize components
    const skeleton = new SkeletonRenderer(canvas);
    const timeline = new TimelinePanel(document.getElementById('timeline-canvas'));
    const controls = new ControlsUI();
    const benchmark = new BenchmarkHarness(document.getElementById('benchmark-panel'));

    // Forward raw landmarks from detectors to skeleton renderer.
    // Detectors call _onResults internally; we wrap to also emit raw data.
    function hookRawResults(detector, channel) {
        const orig = detector._onResults;
        detector._onResults = function (results) {
            orig.call(this, results);
            window.MotionBus.emit('raw_' + channel, results);
        };
    }

    hookRawResults(window.HeadBobDetector, 'face');
    hookRawResults(window.BodyMotionDetector, 'body');
    hookRawResults(window.HandPoseDetector, 'hand');

    // Install benchmark latency hooks AFTER raw-result forwarding hooks
    // so they measure the full pipeline (detector work + forwarding).
    benchmark.hookDetectors();

    // Skeleton renderer subscribes to raw landmarks
    window.MotionBus.subscribe('raw_face', (r) => skeleton.updateFace(r));
    window.MotionBus.subscribe('raw_body', (r) => skeleton.updateBody(r));
    window.MotionBus.subscribe('raw_hand', (r) => skeleton.updateHand(r));

    // Clear skeleton when a mode is disabled (MotionBus emits null)
    window.MotionBus.subscribe('rhythmSync', (d) => { if (!d) skeleton.updateFace(null); });
    window.MotionBus.subscribe('bodyMotion', (d) => { if (!d) skeleton.updateBody(null); });
    window.MotionBus.subscribe('handPose',   (d) => { if (!d) skeleton.updateHand(null); });

    // Mirror SharedCameraManager's stream to the visible video element
    function tryMirrorStream() {
        if (!video.srcObject && window.SharedCameraManager?.stream) {
            video.srcObject = window.SharedCameraManager.stream;
        }
    }
    window.MotionBus.subscribe('rhythmSync', tryMirrorStream);
    window.MotionBus.subscribe('bodyMotion', tryMirrorStream);
    window.MotionBus.subscribe('handPose', tryMirrorStream);

    // Render loop
    function frame() {
        skeleton.draw();
        benchmark.tick();
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    console.log('%ccamerastein ready', 'color: #4ecdc4; font-weight: bold');
});
