import express from 'express';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAutoUpdate, autoUpdateStatus } from '../../core/updater.js';
import { recordUpdateAttempt, recordUpdateFailure, listUpdateHistory } from '../../core/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;
const UPDATE_CHECK_REPO = 'botnick/telegram-media-downloader';
let _updateCache = { fetchedAt: 0, data: null };

function _readCurrentVersion() {
    if (process.env.npm_package_version) return process.env.npm_package_version;
    try {
        return JSON.parse(
            fsSync.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'),
        ).version;
    } catch {
        return 'unknown';
    }
}

function _cmpSemver(a, b) {
    const norm = (s) =>
        String(s || '')
            .replace(/^v/i, '')
            .split('-')[0]
            .split('.')
            .map((n) => parseInt(n, 10) || 0);
    const A = norm(a),
        B = norm(b);
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
        const x = A[i] || 0,
            y = B[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

async function _fetchLatestRelease() {
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
        const r = await fetch(`https://api.github.com/repos/${UPDATE_CHECK_REPO}/releases/latest`, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'tgdl-update-check',
            },
            signal: ctrl.signal,
        });
        if (!r.ok) return null;
        const j = await r.json();
        return {
            tag: j.tag_name,
            name: j.name || j.tag_name,
            url: j.html_url,
            publishedAt: j.published_at,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

// Read the current version once for callers that need it (e.g. update audit).
export { _readCurrentVersion as readCurrentVersion };

export function createVersionRouter({ broadcast, autoUpdateTracker }) {
    const router = express.Router();

    router.get('/version', (req, res) => {
        res.json({
            version: _readCurrentVersion(),
            commit: (process.env.GIT_SHA || 'dev').slice(0, 7),
            builtAt: process.env.BUILT_AT || null,
        });
    });

    router.get('/version/check', async (req, res) => {
        const current = _readCurrentVersion();
        const now = Date.now();
        const force = req.query.force === '1';
        if (!force && _updateCache.data && now - _updateCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
            const { latest } = _updateCache.data;
            if (_cmpSemver(current, latest) < 0) {
                const updateAvailable = _cmpSemver(latest, current) > 0;
                return res.json({ current, ..._updateCache.data, updateAvailable, cached: true });
            }
        }
        const latest = await _fetchLatestRelease();
        if (!latest) {
            if (_updateCache.data) {
                const updateAvailable = _cmpSemver(_updateCache.data.latest, current) > 0;
                return res.json({
                    current,
                    ..._updateCache.data,
                    updateAvailable,
                    cached: true,
                    stale: true,
                });
            }
            return res.json({
                current,
                latest: null,
                updateAvailable: false,
                error: 'unreachable',
            });
        }
        const data = {
            latest: latest.tag,
            latestName: latest.name,
            releaseUrl: latest.url,
            publishedAt: latest.publishedAt,
        };
        _updateCache = { fetchedAt: now, data };
        res.json({
            current,
            ...data,
            updateAvailable: _cmpSemver(latest.tag, current) > 0,
            cached: false,
        });
    });

    router.get('/update/status', (req, res) => {
        res.json(autoUpdateStatus());
    });

    router.post('/update', async (req, res) => {
        const fromVersion = _readCurrentVersion();
        const r = autoUpdateTracker.tryStart(async () => {
            let result;
            try {
                result = await runAutoUpdate();
            } catch (e) {
                try {
                    recordUpdateFailure({
                        fromVersion,
                        errorCode: e?.code || 'UNKNOWN',
                        errorMsg: e?.message || String(e),
                    });
                } catch {}
                throw e;
            }
            try {
                recordUpdateAttempt({
                    fromVersion,
                    backupPath: result.backup?.path || null,
                    backupBytes: result.backup?.sizeBytes ?? null,
                });
            } catch {}
            try {
                broadcast({ type: 'update_started', backup: result.backup });
            } catch {}
            return { backup: result.backup };
        });
        if (!r.started) {
            return res
                .status(409)
                .json({ error: 'An update is already in progress', code: 'ALREADY_RUNNING' });
        }
        res.json({ success: true, started: true });
    });

    router.get('/auto-update/status', (req, res) => {
        res.json(autoUpdateTracker.getStatus());
    });

    router.get('/update/history', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 25));
            res.json({ history: listUpdateHistory({ limit }) });
        } catch (e) {
            res.status(500).json({ error: e?.message || 'Failed to read update history' });
        }
    });

    return router;
}
