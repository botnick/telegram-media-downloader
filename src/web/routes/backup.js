import express from 'express';
import * as backup from '../../core/backup/index.js';

export function createBackupRouter({ log }) {
    const router = express.Router();

    // ====== Backup destinations ================================================
    //
    // Multi-provider mirror + snapshot system. Admin-only via the chokepoint
    // (none of these paths live on the guest allowlist). The backup manager
    // owns workers, snapshot crons, encryption keys; this layer is just the
    // HTTP shim. Every state-changing endpoint also writes a structured log
    // entry so the realtime Logs page surfaces operations without polling.

    router.get('/backup/providers', async (_req, res) => {
        try {
            res.json({ success: true, providers: backup.listProviders() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/backup/destinations', async (_req, res) => {
        try {
            res.json({ success: true, destinations: backup.listDestinations() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/backup/destinations', async (req, res) => {
        try {
            const id = backup.addDestination(req.body || {});
            log({ source: 'backup', level: 'info', msg: `destination created (#${id})` });
            const dest = backup.listDestinations().find((d) => d.id === id);
            res.json({ success: true, id, destination: dest });
        } catch (e) {
            log({
                source: 'backup',
                level: 'warn',
                msg: `destination create rejected: ${e.message}`,
            });
            res.status(400).json({ error: e.message });
        }
    });

    router.put('/backup/destinations/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const updated = backup.updateDestination(id, req.body || {});
            log({ source: 'backup', level: 'info', msg: `destination updated (#${id})` });
            res.json({ success: true, destination: updated });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.delete('/backup/destinations/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const ok = backup.removeDestination(id);
            log({ source: 'backup', level: 'info', msg: `destination removed (#${id})` });
            res.json({ success: ok });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/backup/destinations/:id/test', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const r = await backup.testConnection(id);
            log({
                source: 'backup',
                level: r.ok ? 'info' : 'warn',
                msg: `test connection on #${id}: ${r.detail || (r.ok ? 'ok' : 'failed')}`,
            });
            res.json({ success: true, ...r });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // `/run` returns 200 immediately. The backup manager starts work in the
    // background; the dashboard subscribes to WS events for progress.
    // Without the early-return, a snapshot upload of a multi-GB tar.gz would
    // hold the connection past Cloudflare's 100 s edge timeout.
    router.post('/backup/destinations/:id/run', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            backup.runBackup(id).catch((e) => {
                log({
                    source: 'backup',
                    level: 'error',
                    msg: `run failed for #${id}: ${e.message}`,
                });
            });
            res.json({ success: true, started: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.post('/backup/destinations/:id/pause', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            backup.pause(id);
            log({ source: 'backup', level: 'info', msg: `paused #${id}` });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/backup/destinations/:id/resume', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            backup.resume(id);
            log({ source: 'backup', level: 'info', msg: `resumed #${id}` });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/backup/destinations/:id/encryption', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const { enabled, passphrase } = req.body || {};
            const out = backup.setEncryption(id, { enabled: !!enabled, passphrase });
            res.json({ success: true, destination: out });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.post('/backup/destinations/:id/unlock', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            backup.unlockEncryption(id, req.body?.passphrase || '');
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    router.get('/backup/destinations/:id/status', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            res.json({ success: true, ...backup.getDestinationStatus(id) });
        } catch (e) {
            res.status(404).json({ error: e.message });
        }
    });

    router.get('/backup/destinations/:id/jobs', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const status = req.query.status ? String(req.query.status) : null;
            const limit = Math.min(500, Number(req.query.limit) || 50);
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const jobs = backup.listJobs({ destinationId: id, status, limit, offset });
            res.json({ success: true, jobs });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.get('/backup/jobs/recent', async (req, res) => {
        try {
            const limit = Math.min(200, Number(req.query.limit) || 20);
            res.json({ success: true, jobs: backup.listRecent(limit) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/backup/jobs/:id/retry', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
        try {
            const ok = backup.retryJob(id);
            if (ok) log({ source: 'backup', level: 'info', msg: `manual retry on job #${id}` });
            res.json({ success: ok });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
