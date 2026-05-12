import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fsSync, { existsSync } from 'fs';
import { runtime } from '../../core/runtime.js';
import { tgAuthErrorBody } from '../lib/tg-error.js';
import { readConfigSafe } from '../lib/config-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../data');

async function _buildMonitorStatusSnapshot(getAccountManager) {
    const status = runtime.status();
    if (status.accounts === 0) {
        try {
            const am = await getAccountManager();
            status.accounts = am.count;
        } catch {
            try {
                const dir = path.join(DATA_DIR, 'sessions');
                if (existsSync(dir)) {
                    status.accounts = fsSync
                        .readdirSync(dir)
                        .filter((f) => f.endsWith('.enc')).length;
                }
            } catch {
                /* ignore */
            }
        }
    }
    const config = await readConfigSafe();
    status.hint =
        !config.telegram?.apiId || !config.telegram?.apiHash
            ? 'configure-api'
            : status.accounts === 0
              ? 'add-account'
              : (config.groups || []).filter((g) => g.enabled).length === 0
                ? 'enable-group'
                : null;
    return status;
}

export function createMonitorRouter({ getAccountManager }) {
    const router = express.Router();

    router.get('/monitor/status', async (req, res) => {
        res.json(await _buildMonitorStatusSnapshot(getAccountManager));
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
