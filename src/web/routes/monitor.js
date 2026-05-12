import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';
import { tgAuthErrorBody } from '../lib/tg-error.js';

export function createMonitorRouter({ getAccountManager, buildSnapshot }) {
    const router = express.Router();

    router.get('/monitor/status', async (req, res) => {
        res.json(await buildSnapshot());
    });

    router.post('/monitor/start', async (req, res) => {
        try {
            const am = await getAccountManager();
            if (am.count === 0) {
                return res.status(409).json({
                    error: 'No Telegram accounts loaded. Add one in Settings → Accounts first.',
                });
            }
            await runtime.start({ config: loadConfig(), accountManager: am });
            res.json({ success: true, status: runtime.status() });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status === 400 ? 500 : status).json(
                body.error ? body : { error: e.message },
            );
        }
    });

    router.post('/monitor/stop', async (req, res) => {
        try {
            await runtime.stop();
            res.json({ success: true, status: runtime.status() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/monitor/restart', async (req, res) => {
        try {
            const am = await getAccountManager();
            if (am.count === 0) {
                return res.status(409).json({
                    error: 'No Telegram accounts loaded. Add one in Settings → Accounts first.',
                });
            }
            await runtime.restart({ config: loadConfig(), accountManager: am });
            res.json({ success: true, status: runtime.status() });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status === 400 ? 500 : status).json(
                body.error ? body : { error: e.message },
            );
        }
    });

    return router;
}
