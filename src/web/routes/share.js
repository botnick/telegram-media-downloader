import express from 'express';
import { getDb } from '../../core/db.js';
import { loadConfig } from '../../config/manager.js';

export function createShareLinksRouter({ log }) {
    const router = express.Router();

    // Mint a new share link for a single download row. Body:
    //   { downloadId, ttlSeconds?, label? }
    // ttlSeconds is clamped to [60, 90 days]; default 7 days.
    router.post('/share/links', async (req, res) => {
        try {
            const { downloadId, ttlSeconds, label } = req.body || {};
            const did = parseInt(downloadId, 10);
            if (!Number.isInteger(did) || did <= 0) {
                return res.status(400).json({ error: 'downloadId required' });
            }
            // Confirm the download row exists — otherwise the link would
            // perpetually 404, and we'd be storing useless rows.
            const exists = getDb().prepare('SELECT id FROM downloads WHERE id = ?').get(did);
            if (!exists) return res.status(404).json({ error: 'Download not found' });

            // Pass through whatever the caller sent (including null/undefined).
            // clampTtlSeconds resolves "missing" → the *current* configured
            // default — pulling it back out via getShareLimits() here would
            // race with config_updated. The clamp handles 0 (never expires)
            // and negative / NaN inputs internally.
            const ttl = clampTtlSeconds(ttlSeconds);
            // ttl === 0 = "never expires" sentinel — store expires_at = 0
            // (the verifier skips the time gate; revocation still works).
            const expSec = ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl;
            // Defensive label hygiene — keep labels short and free of control
            // chars so they render safely in the admin UI without escaping.
            const cleanLabel =
                typeof label === 'string'
                    ? label
                          .replace(/[\r\n\t]/g, ' ')
                          .trim()
                          .slice(0, 80) || null
                    : null;

            const { id } = createShareLink({
                downloadId: did,
                expiresAt: expSec,
                label: cleanLabel,
            });

            // Re-load with the joined download metadata so the response is the
            // same shape as the list endpoint (UI doesn't have to re-fetch).
            const list = listShareLinks({ downloadId: did, limit: 1000 });
            const row = list.find((r) => r.id === id);
            res.json({ success: true, link: row ? _shareLinkPayload(req, row) : null });
        } catch (e) {
            console.error('share/links create:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // List share-links. `?downloadId=…` filters to one file (Share sheet);
    // no filter returns the most recent N links across the library
    // (Maintenance sheet). Paginated via `?limit=500&offset=N&q=substring`
    // so a library with 50 k+ active links doesn't blow the response body —
    // the SPA renders one page at a time and the search filter runs server-
    // side. See `CLAUDE.md → Big-data patterns` rule 1.
    router.get('/share/links', async (req, res) => {
        try {
            const downloadId = req.query.downloadId ? parseInt(req.query.downloadId, 10) : null;
            const includeRevoked = req.query.includeRevoked !== '0';
            const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 500));
            const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
            const search = typeof req.query.q === 'string' ? req.query.q : null;
            const rows = listShareLinks({ downloadId, includeRevoked, limit, offset, search });
            const total = countShareLinks({ downloadId, includeRevoked, search });
            res.json({
                success: true,
                links: rows.map((r) => _shareLinkPayload(req, r)),
                total,
                limit,
                offset,
                hasMore: offset + rows.length < total,
            });
        } catch (e) {
            console.error('share/links list:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Revoke a single share-link by id. Idempotent — revoking an already-
    // revoked link returns success: true with revoked: false.
    router.delete('/share/links/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id, 10);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'Invalid id' });
            }
            const did = revokeShareLink(id);
            res.json({ success: true, revoked: did });
        } catch (e) {
            console.error('share/links revoke:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
