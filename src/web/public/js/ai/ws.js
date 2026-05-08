// WebSocket subscriptions for the AI page.
//
// Returns a `dispose()` function that unsubscribes everything when the page
// unmounts — fixes the previous file's pattern of leaking listeners across
// page navigations.

import { ws } from '../ws.js';
import { patchScanProgress, patchScanRunning } from './state.js';

const CAP_TO_PREFIX = {
    embeddings: 'ai_index',
    faces: 'ai_people',
    tags: 'ai_tags',
    phash: 'ai_phash',
};

/**
 * @param {object} hooks
 * @param {() => void} hooks.onModelProgress  Called when ai_model_progress fires.
 * @param {() => void} hooks.onScanDone       Called once a scan completes.
 * @returns {() => void} dispose
 */
export function attach({ onModelProgress, onScanDone } = {}) {
    const offs = [];
    for (const [cap, prefix] of Object.entries(CAP_TO_PREFIX)) {
        offs.push(
            ws.on(`${prefix}_progress`, (msg) => {
                patchScanProgress(cap, msg.progress || msg);
                patchScanRunning(cap, true);
            }),
        );
        offs.push(
            ws.on(`${prefix}_done`, () => {
                patchScanProgress(cap, { stage: 'done' });
                patchScanRunning(cap, false);
                if (typeof onScanDone === 'function') {
                    try {
                        onScanDone(cap);
                    } catch {
                        /* never propagate from a WS handler */
                    }
                }
            }),
        );
    }
    offs.push(
        ws.on('ai_model_progress', () => {
            if (typeof onModelProgress === 'function') {
                try {
                    onModelProgress();
                } catch {
                    /* swallow */
                }
            }
        }),
    );
    return function dispose() {
        for (const off of offs) {
            try {
                off();
            } catch {
                /* swallow */
            }
        }
    };
}
