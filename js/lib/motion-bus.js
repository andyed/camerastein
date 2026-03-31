/**
 * MotionBus — Unified event bus for camera-based motion detection signals.
 *
 * Follows the same subscribe/emit/state pattern as AudioReactivityBus.
 * Three channels:
 *   - rhythmSync  → HeadBobDetector (face mesh, head bob, orientation)
 *   - bodyMotion  → BodyMotionDetector (pose, sway, bounce, energy)
 *   - handPose    → HandPoseDetector (hand landmarks, gestures)
 *
 * State is null when a channel's detector is inactive, matching the
 * contract where consumers do `if (MotionBus.state.rhythm) { ... }`.
 *
 * @see js/audio-reactivity-bus.js (same pattern)
 */

class MotionBus {
    constructor() {
        this.handlers = new Map();

        this.state = {
            rhythm: null,       // HeadBobDetector data (null = inactive)
            body: null,         // BodyMotionDetector data (null = inactive)
            hand: null,         // HandPoseDetector data (null = inactive)
        };

        // Channel name → state key
        this._channels = {
            rhythmSync: 'rhythm',
            bodyMotion: 'body',
            handPose:   'hand',
        };
    }

    /**
     * Subscribe to a named event. Returns an unsubscribe function.
     * @param {string} eventName - e.g. 'rhythmSync', 'bodyMotion', 'handPose'
     * @param {Function} handler - Called with payload on each emit
     * @returns {Function} unsubscribe
     */
    subscribe(eventName, handler) {
        if (!this.handlers.has(eventName)) this.handlers.set(eventName, new Set());
        this.handlers.get(eventName).add(handler);
        return () => this.handlers.get(eventName)?.delete(handler);
    }

    /**
     * Emit an event, auto-update state, and fire subscribers.
     * @param {string} eventName - Channel name
     * @param {Object|null} payload - Detection state object, or null when inactive
     */
    emit(eventName, payload) {
        // Auto-update internal state
        const stateKey = this._channels[eventName];
        if (stateKey) {
            this.state[stateKey] = payload;
        }

        // Fire subscribers
        const set = this.handlers.get(eventName);
        if (set) for (const h of set) try { h(payload); } catch (_) { }
    }

    /**
     * Non-mutating state accessor (mirrors AudioReactivityBus.getState)
     */
    getState() {
        return this.state;
    }
}

window.MotionBus = new MotionBus();
