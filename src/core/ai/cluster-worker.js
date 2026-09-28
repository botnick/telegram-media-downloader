/**
 * Worker-thread entry for Phase B face clustering. Spawned per run by
 * `clusterFacesOffThread()` (faces.js); receives the packed embeddings
 * (transferred, zero-copy), runs `clusterFlat()`, and posts the result
 * back packed into three typed arrays so the reply is transferred too:
 *
 *   members   Int32Array — member indices of every cluster, concatenated
 *   starts    Int32Array — cluster c owns members[starts[c] .. starts[c+1])
 *   centroids Float32Array — count × dim
 *
 * Progress messages (`{type:'progress', done, n}`) arrive about once a
 * second so the scan log can show that a long pass is still moving.
 */

import { parentPort } from 'node:worker_threads';

import { clusterFlat } from './dbscan.js';

parentPort.on('message', (msg) => {
    if (msg?.type !== 'cluster') return;
    try {
        const { data, n, dim, weights, eps, minPts } = msg;
        const { clusters, noise } = clusterFlat(data, n, dim, weights || null, {
            eps,
            minPts,
            onProgress: (done, total) =>
                parentPort.postMessage({ type: 'progress', done, n: total }),
        });
        const count = clusters.length;
        const starts = new Int32Array(count + 1);
        let total = 0;
        for (let c = 0; c < count; c++) {
            starts[c] = total;
            total += clusters[c].memberIdxs.length;
        }
        starts[count] = total;
        const members = new Int32Array(total);
        const centroids = new Float32Array(count * dim);
        for (let c = 0; c < count; c++) {
            members.set(clusters[c].memberIdxs, starts[c]);
            centroids.set(clusters[c].centroid, c * dim);
        }
        parentPort.postMessage(
            { type: 'result', count, starts, members, centroids, noiseCount: noise.length },
            [starts.buffer, members.buffer, centroids.buffer],
        );
    } catch (e) {
        parentPort.postMessage({ type: 'error', message: e?.message || String(e) });
    }
});
