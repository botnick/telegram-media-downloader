import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import { loadConfig } from '../../config/manager.js';
import { tgAuthErrorBody } from '../lib/tg-error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../data');

export function createAccountsRouter({ getAccountManager }) {
    const router = express.Router();

    // List saved accounts with metadata.
    router.get('/accounts', async (req, res) => {
        try {
            const sessionsDir = path.join(DATA_DIR, 'sessions');
            if (!fsSync.existsSync(sessionsDir)) {
                return res.json([]);
            }
            const files = fsSync
                .readdirSync(sessionsDir)
                .filter((f) => f.endsWith('.enc'))
                .sort((a, b) => {
                    const statA = fsSync.statSync(path.join(sessionsDir, a));
                    const statB = fsSync.statSync(path.join(sessionsDir, b));
                    return statA.mtimeMs - statB.mtimeMs;
                });

            const config = loadConfig();
            const configAccounts = config.accounts || [];

            const accounts = files.map((f, index) => {
                const id = path.basename(f, '.enc');
                const meta = configAccounts.find((a) => a.id === id) || {};
                return {
                    id,
                    name: meta.name || id,
                    username: meta.username || '',
                    phone: meta.phone || '',
                    isDefault: index === 0,
                };
            });
            res.json(accounts);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Telegram account add: phone → OTP → 2FA wizard.
    // Each begin call returns a sessionId; subsequent submits use that id.
    // The state machine lives in AccountManager._authFlows.

    router.post('/accounts/auth/begin', async (req, res) => {
        try {
            const { label } = req.body || {};
            const am = await getAccountManager();
            const result = await am.beginPhoneAuth(label);
            res.json(result);
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    router.post('/accounts/auth/phone', async (req, res) => {
        try {
            const { sessionId, phone } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submitPhone(sessionId, phone));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/accounts/auth/code', async (req, res) => {
        try {
            const { sessionId, code } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submitCode(sessionId, code));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/accounts/auth/2fa', async (req, res) => {
        try {
            const { sessionId, password } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.submit2fa(sessionId, password));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.post('/accounts/auth/cancel', async (req, res) => {
        try {
            const { sessionId } = req.body || {};
            const am = await getAccountManager();
            res.json(await am.cancelAuth(sessionId));
        } catch (e) {
            res.status(400).json({ error: e?.message || 'Bad request' });
        }
    });

    router.get('/accounts/auth/:sessionId', async (req, res) => {
        try {
            const am = await getAccountManager();
            const status = am.getAuthStatus(req.params.sessionId);
            if (!status) return res.status(404).json({ error: 'Auth session not found' });
            res.json(status);
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    // Remove a saved Telegram account.
    router.delete('/accounts/:id', async (req, res) => {
        try {
            const am = await getAccountManager();
            const id = req.params.id;
            if (!am.metadata.has(id)) return res.status(404).json({ error: 'Account not found' });
            await am.removeAccount(id);
            res.json({ success: true });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status).json(body);
        }
    });

    return router;
}
