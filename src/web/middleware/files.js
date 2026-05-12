import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import crypto from 'crypto';
import { getDb } from '../../core/db.js';
import { parseClusterRefPath } from '../../core/cluster/dedup.js';
import { getPeer } from '../../core/cluster/peers.js';
import { streamFromPeer, requestSignedShareUrl } from '../../core/cluster/proxy.js';
import { safeResolveDownload } from '../lib/resolve-download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../data');

// HEIC inline cache — a single transcoded JPEG per source file. Keyed by
// (path, mtime) so an edited / replaced .heic re-renders. Cache directory
// is the same one thumbs.js owns, namespaced under heic-cache/ so the
// thumb purge button doesn't sweep these mid-view.
const _HEIC_CACHE_DIR = path.join(DATA_DIR, 'thumbs', 'heic-cache');
async function _heicInlineCache(srcAbs) {
    await fs.mkdir(_HEIC_CACHE_DIR, { recursive: true });
    const st = await fs.stat(srcAbs);
    const key = crypto.createHash('sha1').update(`${srcAbs}\0${st.mtimeMs}`).digest('hex');
    const dst = path.join(_HEIC_CACHE_DIR, `${key}.jpg`);
    if (existsSync(dst)) return dst;
    // Rotate honors EXIF orientation; quality 85 / progressive trades a
    // little CPU for visibly nicer rendering vs the default 80.
    const sharp = (await import('sharp')).default;
    await sharp(srcAbs, { failOn: 'none' })
        .rotate()
        .jpeg({ quality: 85, progressive: true })
        .toFile(dst);
    return dst;
}

/**
 * Returns Express middleware that serves files from data/downloads.
 * Uses safeResolveDownload to reject path traversal, NUL bytes, and symlink
 * escapes. Adds Content-Disposition so a rogue HTML file can't be rendered
 * inline (the browser still inlines images and videos via ?inline=1).
 */
export function createFileServingMiddleware({ broadcast }) {
    return async (req, res, next) => {
        try {
            let reqPath;
            try {
                reqPath = decodeURIComponent(req.path).replace(/^\//, '');
            } catch {
                return res.status(400).send('Bad request');
            }
            if (!reqPath) return next();
            if (reqPath.includes('\0')) return res.status(400).send('Bad request');

            // Cluster-ref path: a row whose file_path is `_clusterref/<peerId>/<remoteId>`.
            // Either the dedup layer (Phase 6) inserted it during download, or the
            // operator opened a peer-owned file from the merged gallery. Fork to the
            // streaming bridge before the local-disk resolver complains.
            const ref = parseClusterRefPath(reqPath);
            if (ref) {
                const ownerRow = getDb()
                    .prepare(
                        'SELECT file_path FROM peer_downloads WHERE peer_id = ? AND remote_id = ?',
                    )
                    .get(ref.peerId, Number(ref.remoteId));
                if (!ownerRow) {
                    return res.status(404).send('Cluster file not found in catalog cache');
                }
                const peer = getPeer(ref.peerId);
                if (!peer) return res.status(410).send('Peer revoked');
                if (peer.streamMode === 'direct') {
                    try {
                        const url = await requestSignedShareUrl(ref.peerId, ownerRow.file_path);
                        return res.redirect(302, url);
                    } catch (e) {
                        return res
                            .status(502)
                            .json({ error: 'storage_offline', message: e?.message || String(e) });
                    }
                }
                return streamFromPeer(req, res, ref.peerId, ownerRow.file_path);
            }

            // Federated gallery direct-peer path: SPA constructs
            //   `/files/${peerSidePath}?inline=1&peer=${peerId}`
            // for tiles whose source row lives in `peer_downloads`. There's no
            // `_clusterref/` ghost row to dispatch on — the SPA tells us which
            // peer to proxy to via the query param. Same direct vs proxy fork
            // as the _clusterref branch above. Defence: only honour ?peer when
            // the id matches a paired peer (revoked/unknown ids 410 / 502).
            // Guest sessions are NOT allowed to fetch peer files — federation
            // is admin-gated; without this guard a guest could exfiltrate any
            // peer's catalog by guessing peer ids + paths.
            if (req.query.peer) {
                if (req.role === 'guest') return res.status(403).send('Forbidden');
                const peerIdParam = String(req.query.peer);
                const peer = getPeer(peerIdParam);
                if (!peer) return res.status(410).send('Peer revoked');
                const peerSidePath = reqPath;
                if (peer.streamMode === 'direct') {
                    try {
                        const url = await requestSignedShareUrl(peerIdParam, peerSidePath);
                        return res.redirect(302, url);
                    } catch (e) {
                        return res
                            .status(502)
                            .json({ error: 'storage_offline', message: e?.message || String(e) });
                    }
                }
                return streamFromPeer(req, res, peerIdParam, peerSidePath);
            }

            const r = await safeResolveDownload(reqPath);
            if (!r.ok) {
                // Distinguish "genuinely missing" from "blocked for safety" so
                // users see "File not found" instead of a misleading "Forbidden"
                // when a file was rotated/deleted but the DB row lingered.
                const status = r.reason === 'missing' ? 404 : 403;
                // Auto-prune the DB row for genuinely-missing files so the
                // gallery stops listing them on next refresh. STRICT match on
                // file_path only — matching by file_name was unsafe because
                // two groups can hold files with the same timestamp-based
                // basename, and a 404 on one would mass-delete the other's
                // rows. Done in the background so the HTTP response isn't
                // blocked by the DB write.
                if (r.reason === 'missing') {
                    queueMicrotask(() => {
                        try {
                            const fwd = reqPath.replace(/\\/g, '/');
                            const bwd = fwd.replace(/\//g, '\\');
                            const db = getDb();
                            const result = db
                                .prepare(
                                    `DELETE FROM downloads WHERE file_path = ? OR file_path = ?`,
                                )
                                .run(fwd, bwd);
                            if (result.changes > 0) {
                                broadcast({ type: 'file_deleted', path: fwd, autoPruned: true });
                            }
                        } catch {
                            /* never let a stray request crash the server */
                        }
                    });
                }
                return res
                    .status(status)
                    .send(r.reason === 'missing' ? 'File not found' : 'Forbidden');
            }

            const inline = req.query.inline === '1';
            const baseName = path.basename(r.real);
            // RFC 5987 — `filename*` for UTF-8, plus an ASCII fallback for legacy
            // clients. Some browsers / proxies still parse the basic `filename=`
            // first, so omitting it leaves the file with a generic name.
            const dispKind = inline ? 'inline' : 'attachment';
            const asciiName = baseName.replace(/[^\x20-\x7e]/g, '_');
            res.setHeader(
                'Content-Disposition',
                `${dispKind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
            );

            // HEIC / HEIF inline view — browsers don't render the format
            // natively (Safari excepted, and even there only on iOS / macOS).
            // For inline requests we transcode on the fly to JPEG via sharp's
            // built-in libheif (compiled into the prebuilt sharp binary), and
            // cache the result so the second open is a static stream. Disk
            // download (`?inline=1` absent) keeps the original .heic bytes.
            const heicExt = path.extname(r.real).toLowerCase();
            if (inline && (heicExt === '.heic' || heicExt === '.heif')) {
                try {
                    const cachePath = await _heicInlineCache(r.real);
                    res.setHeader('Content-Type', 'image/jpeg');
                    res.setHeader('Cache-Control', 'private, max-age=86400');
                    return res.sendFile(cachePath);
                } catch (e) {
                    console.warn('[heic] inline transcode failed:', baseName, e?.message || e);
                    // Fall through to raw .heic — Safari users still get the file.
                }
            }
            res.sendFile(r.real);
        } catch (e) {
            next();
        }
    };
}
