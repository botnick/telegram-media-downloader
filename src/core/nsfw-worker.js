/**
 * NSFW classifier worker thread.
 *
 * onnxruntime-node runs `session.run()` synchronously on the calling
 * thread, so classifying on the main thread froze the event loop for the
 * whole batch — seconds per batch on small CPUs. That starved HTTP/WS, and
 * in Docker the `/api/auth_check` healthcheck (4s timeout) failed until
 * autoheal restarted the container mid-scan. Everything heavy — image
 * decode/resize (sharp) and inference — happens here instead; nsfw.js
 * only posts file paths / sprite geometry and gets scores back.
 *
 * Messages in:
 *   { type: 'init', modelId, dtype, cacheDir, token, threads, batchSize }
 *   { type: 'classify', id, items: [{ kind: 'file', path }
 *                                  | { kind: 'tiles', spritePath, cols, rows,
 *                                      tileW, tileH, indices }] }
 * Messages out:
 *   { type: 'progress', p } / { type: 'log', level, msg }   (during init)
 *   { type: 'ready', model, dtype, width, height }
 *   { type: 'init-error', message, code }
 *   { type: 'result', id, results: [{ score, label } | null], error? }
 */

import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

const NSFW_LABEL = /(nsfw|porn|hentai|sexy|explicit|adult)/;
const DTYPE_FALLBACK = ['q8', 'fp16', 'fp32', 'q4'];

let classifier = null;
let RawImage = null;
let inputW = 224;
let inputH = 224;
let batchSize = 4;

const log = (level, msg) => parentPort.postMessage({ type: 'log', level, msg });

async function init(msg) {
    let mod;
    try {
        mod = await import('@huggingface/transformers');
    } catch (e) {
        const err = new Error(
            `Failed to load @huggingface/transformers: ${e?.message || e}. ` +
                'Install with `npm install @huggingface/transformers`.',
        );
        err.code = 'NSFW_LIB_MISSING';
        throw err;
    }
    const { pipeline, env } = mod;
    RawImage = mod.RawImage;
    try {
        env.cacheDir = msg.cacheDir;
    } catch {}
    if (msg.token) {
        try {
            env.token = msg.token;
        } catch {}
        try {
            if (!env.customHeaders) env.customHeaders = {};
            env.customHeaders.Authorization = `Bearer ${msg.token}`;
        } catch {}
    }
    batchSize = Math.max(1, msg.batchSize || batchSize);

    // Try the requested dtype first, then fall through the chain on
    // "file not found" style errors so the operator doesn't have to know
    // which precision a given model publishes.
    const order = [msg.dtype, ...DTYPE_FALLBACK.filter((d) => d !== msg.dtype)];
    let lastErr = null;
    for (const dtype of order) {
        try {
            classifier = await pipeline('image-classification', msg.modelId, {
                dtype,
                session_options: { intraOpNumThreads: msg.threads, interOpNumThreads: 1 },
                progress_callback: (p) => parentPort.postMessage({ type: 'progress', p }),
            });
            if (dtype !== msg.dtype) {
                log(
                    'warn',
                    `${msg.dtype} variant unavailable for ${msg.modelId} — fell back to ${dtype}`,
                );
            }
            // Resize to the model's own input size here (off the model's
            // processor path) so a 12 MP photo is never decoded at full
            // resolution into JS memory.
            const size = classifier.processor?.image_processor?.size || {};
            inputW = size.width || size.shortest_edge || 224;
            inputH = size.height || size.shortest_edge || 224;
            return { model: msg.modelId, dtype, width: inputW, height: inputH };
        } catch (e) {
            lastErr = e;
            const m = String(e?.message || e);
            if (!/locate file|ENOENT|HTTP error|404|not found/i.test(m)) throw e;
            log('warn', `dtype=${dtype} unavailable: ${m}`);
        }
    }
    throw lastErr || new Error(`No usable ONNX variant found for ${msg.modelId}`);
}

function toRawImage({ data, info }) {
    return new RawImage(
        new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
        info.width,
        info.height,
        info.channels,
    );
}

// Bilinear matches the PIL resample the HF image processors were trained
// with; sharp's shrink-on-load keeps big JPEG decodes cheap.
function resizeToInput(img) {
    return img
        .resize(inputW, inputH, { fit: 'fill', kernel: 'linear' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(toRawImage);
}

function scoreOf(output) {
    let score = 0;
    for (const r of Array.isArray(output) ? output : []) {
        const s = Number(r?.score) || 0;
        if (NSFW_LABEL.test(String(r?.label || '').toLowerCase()) && s > score) score = s;
    }
    return score;
}

async function scoreImages(images) {
    const scores = [];
    for (let i = 0; i < images.length; i += batchSize) {
        const chunk = images.slice(i, i + batchSize);
        const out = await classifier(chunk.length === 1 ? chunk[0] : chunk);
        // A single image returns one label list; a batch returns a list per image.
        const perImage = chunk.length === 1 ? [out] : out;
        for (const o of perImage) scores.push(scoreOf(o));
    }
    return scores;
}

async function loadTiles(item) {
    const { data, info } = await sharp(item.spritePath, { failOn: 'none' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const tileH = item.tileH > 0 ? item.tileH : Math.floor(info.height / (item.rows || 1));
    if (!(tileH > 0)) return [];
    const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
    const tiles = [];
    for (const i of item.indices) {
        const left = (i % item.cols) * item.tileW;
        const top = Math.floor(i / item.cols) * tileH;
        if (left + item.tileW > info.width || top + tileH > info.height) continue;
        try {
            tiles.push(
                await resizeToInput(
                    sharp(data, raw).extract({ left, top, width: item.tileW, height: tileH }),
                ),
            );
        } catch {
            /* skip unreadable tile */
        }
    }
    return tiles;
}

const verdict = (score) => ({ score, label: score >= 0.5 ? 'nsfw' : 'normal' });

async function classify(items) {
    const results = new Array(items.length).fill(null);
    // Photos: decode in parallel on sharp's threads, infer as one batch.
    const photos = await Promise.all(
        items.map((item) =>
            item.kind === 'file'
                ? resizeToInput(sharp(item.path, { failOn: 'none' }).rotate()).catch(() => null)
                : null,
        ),
    );
    const order = [];
    const decoded = [];
    photos.forEach((img, i) => {
        if (img) {
            order.push(i);
            decoded.push(img);
        }
    });
    if (decoded.length) {
        const scores = await scoreImages(decoded);
        order.forEach((itemIndex, k) => {
            results[itemIndex] = verdict(scores[k]);
        });
    }
    // Videos: sample sprite tiles; top-3 average needs consensus across
    // tiles so one brief frame doesn't flag the whole video.
    for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'tiles') continue;
        let tiles;
        try {
            tiles = await loadTiles(items[i]);
        } catch {
            continue;
        }
        if (!tiles.length) {
            results[i] = verdict(0);
            continue;
        }
        const scores = (await scoreImages(tiles)).sort((a, b) => b - a);
        const k = Math.min(3, scores.length);
        results[i] = verdict(scores.slice(0, k).reduce((s, v) => s + v, 0) / k);
    }
    return results;
}

// One message at a time — inference already saturates the thread pool.
let chain = Promise.resolve();
parentPort.on('message', (msg) => {
    chain = chain.then(async () => {
        if (msg.type === 'init') {
            try {
                parentPort.postMessage({ type: 'ready', ...(await init(msg)) });
            } catch (e) {
                parentPort.postMessage({
                    type: 'init-error',
                    message: e?.message || String(e),
                    code: e?.code || null,
                });
            }
        } else if (msg.type === 'classify') {
            try {
                parentPort.postMessage({
                    type: 'result',
                    id: msg.id,
                    results: await classify(msg.items),
                });
            } catch (e) {
                parentPort.postMessage({
                    type: 'result',
                    id: msg.id,
                    results: msg.items.map(() => null),
                    error: e?.message || String(e),
                });
            }
        }
    });
});
