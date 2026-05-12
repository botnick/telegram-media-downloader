import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
    isAuthConfigured,
    isGuestEnabled,
    loginVerify,
    hashPassword,
    verifyPassword,
    issueSession,
    validateSession,
    revokeSession,
    revokeAllSessions,
    revokeAllGuestSessions,
} from '../../core/web-auth.js';
import { metrics } from '../../core/metrics.js';
import { readConfigSafe } from '../lib/config-cache.js';
import { writeConfigAtomic } from '../lib/config-writer.js';
import { isLocalRequest } from '../middleware/auth.js';

const SESSION_COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
};

function sessionTtlMsFromConfig(config) {
    const days = Number(config?.advanced?.web?.sessionTtlDays);
    if (Number.isFinite(days) && days >= 1 && days <= 365) {
        return Math.floor(days * 24 * 60 * 60 * 1000);
    }
    return 7 * 24 * 60 * 60 * 1000;
}

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

// Single-use password reset tokens. Map<token, expiresAt>.
const _resetTokens = new Map();
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

function _gcResetTokens() {
    const now = Date.now();
    for (const [tok, exp] of _resetTokens) if (exp <= now) _resetTokens.delete(tok);
}

export function createAuthRouter({ broadcast }) {
    const router = express.Router();

    router.post('/login', loginLimiter, async (req, res) => {
        try {
            const { password } = req.body || {};
            if (typeof password !== 'string' || password.length === 0) {
                return res.status(400).json({ error: 'Password required' });
            }

            const config = await readConfigSafe();
            if (!isAuthConfigured(config.web)) {
                return res.status(503).json({
                    error: 'Web dashboard not initialised. Run `npm run auth`.',
                    setupRequired: true,
                });
            }

            const result = loginVerify(password, config.web);
            metrics.inc('tgdl_login_total', 1, {
                result: result.ok ? 'ok' : 'fail',
                role: result.ok ? result.role : 'none',
            });
            if (!result.ok) return res.status(401).json({ error: 'Invalid password' });

            // Auto-upgrade legacy plaintext to scrypt hash on first successful login.
            if (result.upgrade) {
                try {
                    config.web.passwordHash = hashPassword(password);
                    delete config.web.password;
                    await writeConfigAtomic(config);
                } catch (e) {
                    console.error('Password rehash failed (non-fatal):', e.message);
                }
            }

            const { token, maxAgeMs } = issueSession({
                ttlMs: sessionTtlMsFromConfig(config),
                role: result.role,
            });
            res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
            res.json({ success: true, role: result.role });
        } catch (e) {
            console.error('Login error:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/logout', (req, res) => {
        const token = req.cookies['tg_dl_session'];
        if (token) revokeSession(token);
        res.clearCookie('tg_dl_session', SESSION_COOKIE_OPTS);
        res.json({ success: true });
    });

    // First-run password setup. Allowed only when no password is configured AND
    // the request originates from the local machine.
    router.post('/auth/setup', setupLimiter, async (req, res) => {
        try {
            const { password } = req.body || {};
            if (typeof password !== 'string' || password.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters' });
            }
            const config = await readConfigSafe();
            if (isAuthConfigured(config.web)) {
                return res.status(409).json({
                    error: 'Already configured — use POST /api/auth/change-password',
                });
            }
            if (!isLocalRequest(req)) {
                return res.status(403).json({
                    error: 'Initial setup must be done from the local machine. Run `npm run auth` instead.',
                });
            }

            if (!config.web) config.web = {};
            config.web.enabled = true;
            config.web.passwordHash = hashPassword(password);
            delete config.web.password;
            await writeConfigAtomic(config);

            const { token, maxAgeMs } = issueSession({
                ttlMs: sessionTtlMsFromConfig(config),
                role: 'admin',
            });
            res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
            res.json({ success: true });
        } catch (e) {
            console.error('Setup error:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Change password from inside the dashboard. Requires the *current* password
    // to be supplied along with the new one — even an active session can't be used
    // alone, so a stolen cookie can't take over the account.
    //
    // Registered before the global checkAuth middleware, so enforces its own auth.
    router.post('/auth/change-password', loginLimiter, async (req, res) => {
        try {
            const session = validateSession(req.cookies['tg_dl_session']);
            if (!session) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            // Guests cannot change the admin password (and have no separate
            // password of their own to change — admin manages the guest hash
            // from the Dashboard Security panel).
            if (session.role !== 'admin') {
                return res.status(403).json({ error: 'Admin only', adminRequired: true });
            }
            const { currentPassword, newPassword } = req.body || {};
            if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
                return res.status(400).json({ error: 'currentPassword and newPassword required' });
            }
            if (newPassword.length < 8) {
                return res
                    .status(400)
                    .json({ error: 'New password must be at least 8 characters' });
            }
            const config = await readConfigSafe();
            if (!isAuthConfigured(config.web)) {
                return res
                    .status(409)
                    .json({ error: 'No password configured yet — use /api/auth/setup' });
            }
            // Match against the admin hash specifically (loginVerify also accepts
            // a guest password, which would let a stolen guest cookie pivot to
            // admin if we used the broad verifier here).
            const adminMatches = config.web.passwordHash
                ? verifyPassword(currentPassword, config.web.passwordHash)
                : typeof config.web.password === 'string' &&
                  currentPassword === config.web.password;
            if (!adminMatches)
                return res.status(401).json({ error: 'Current password is incorrect' });

            // Reject collisions with the guest password — otherwise admin and
            // guest become indistinguishable at the login form.
            if (
                config.web.guestPasswordHash &&
                verifyPassword(newPassword, config.web.guestPasswordHash)
            ) {
                return res.status(400).json({
                    error: 'New password must differ from the guest password',
                    code: 'SAME_AS_GUEST',
                });
            }

            config.web.passwordHash = hashPassword(newPassword);
            delete config.web.password;
            await writeConfigAtomic(config);

            // Issue a fresh session — SPA replaces old cookie.
            const { token, maxAgeMs } = issueSession({
                ttlMs: sessionTtlMsFromConfig(config),
                role: 'admin',
            });
            res.cookie('tg_dl_session', token, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
            res.json({ success: true });
        } catch (e) {
            console.error('change-password:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Guest password (admin-managed). Body:
    //   { password }    → hash + store, set guestEnabled=true
    //   { enabled }     → flip guestEnabled flag (revokes all guest sessions on disable)
    //   { clear: true } → wipe hash + disable + revoke
    //
    // Registered before global checkAuth middleware, so enforces its own auth.
    router.post('/auth/guest-password', async (req, res) => {
        try {
            const session = validateSession(req.cookies['tg_dl_session']);
            if (!session) return res.status(401).json({ error: 'Unauthorized' });
            if (session.role !== 'admin') {
                return res.status(403).json({ error: 'Admin only', adminRequired: true });
            }
            const { password, enabled, clear } = req.body || {};
            const config = await readConfigSafe();
            if (!config.web) config.web = {};

            if (clear === true) {
                delete config.web.guestPasswordHash;
                config.web.guestEnabled = false;
                await writeConfigAtomic(config);
                revokeAllGuestSessions();
                broadcast({ type: 'config_updated' });
                return res.json({ success: true, configured: false, enabled: false });
            }

            if (typeof password === 'string' && password.length > 0) {
                if (password.length < 8) {
                    return res
                        .status(400)
                        .json({ error: 'Guest password must be at least 8 characters' });
                }
                // Reject equality with the admin password — otherwise the guest
                // role can never actually be reached from the login form.
                const adminHash = config.web.passwordHash;
                const adminMatches = adminHash
                    ? verifyPassword(password, adminHash)
                    : typeof config.web.password === 'string' && password === config.web.password;
                if (adminMatches) {
                    return res.status(400).json({
                        error: 'Guest password must differ from the admin password',
                        code: 'SAME_AS_ADMIN',
                    });
                }
                config.web.guestPasswordHash = hashPassword(password);
                config.web.guestEnabled = true;
                await writeConfigAtomic(config);
                // Any guest signed in with the previous password should be
                // bounced — same posture as admin password change.
                revokeAllGuestSessions();
                broadcast({ type: 'config_updated' });
                return res.json({ success: true, configured: true, enabled: true });
            }

            if (typeof enabled === 'boolean') {
                if (!config.web.guestPasswordHash && enabled) {
                    return res
                        .status(400)
                        .json({ error: 'Set a guest password before enabling guest access' });
                }
                config.web.guestEnabled = enabled;
                await writeConfigAtomic(config);
                if (!enabled) revokeAllGuestSessions();
                broadcast({ type: 'config_updated' });
                return res.json({
                    success: true,
                    configured: !!config.web.guestPasswordHash,
                    enabled,
                });
            }

            return res.status(400).json({ error: 'Provide one of: password, enabled, clear' });
        } catch (e) {
            console.error('guest-password:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // Password reset (token-gated, stdout-delivered):
    //   1. POST /api/auth/reset/request — prints a one-time 10-min token to stdout.
    //   2. POST /api/auth/reset/confirm { token, newPassword } — verifies,
    //      rehashes, revokes all sessions, issues fresh cookie.
    router.post('/auth/reset/request', loginLimiter, async (req, res) => {
        try {
            _gcResetTokens();
            const config = await readConfigSafe();
            if (!isAuthConfigured(config.web)) {
                return res
                    .status(409)
                    .json({ error: 'No password configured yet — use /api/auth/setup' });
            }
            const token = crypto.randomBytes(16).toString('hex');
            _resetTokens.set(token, Date.now() + RESET_TOKEN_TTL_MS);
            // Eye-catching banner so it's easy to spot in `docker compose logs`.
            console.log('\n' + '='.repeat(60));
            console.log('🔐  DASHBOARD PASSWORD RESET TOKEN');
            console.log('    Token: ' + token);
            console.log('    Valid for 10 minutes. Single-use.');
            console.log('    Paste it into the dashboard reset form to continue.');
            console.log('='.repeat(60) + '\n');
            res.json({ success: true, ttlSeconds: Math.floor(RESET_TOKEN_TTL_MS / 1000) });
        } catch (e) {
            console.error('reset/request:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/auth/reset/confirm', loginLimiter, async (req, res) => {
        try {
            _gcResetTokens();
            const { token, newPassword } = req.body || {};
            if (typeof token !== 'string' || typeof newPassword !== 'string') {
                return res.status(400).json({ error: 'token and newPassword required' });
            }
            if (newPassword.length < 8) {
                return res
                    .status(400)
                    .json({ error: 'New password must be at least 8 characters' });
            }
            const exp = _resetTokens.get(token);
            if (!exp || exp <= Date.now()) {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }
            // Single-use — burn the token before anything else so a retry
            // can't replay it even if the rest of the flow throws.
            _resetTokens.delete(token);

            const config = await readConfigSafe();
            if (!config.web) config.web = {};
            config.web.passwordHash = hashPassword(newPassword);
            config.web.enabled = true;
            delete config.web.password;
            await writeConfigAtomic(config);

            // Revoke every existing session — if someone reset the password,
            // assume the previous owner is locked out and shouldn't be trusted.
            revokeAllSessions();
            const { token: sessionTok, maxAgeMs } = issueSession({
                ttlMs: sessionTtlMsFromConfig(config),
                role: 'admin',
            });
            res.cookie('tg_dl_session', sessionTok, { ...SESSION_COOKIE_OPTS, maxAge: maxAgeMs });
            res.json({ success: true });
        } catch (e) {
            console.error('reset/confirm:', e);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.get('/auth_check', async (req, res) => {
        const config = await readConfigSafe();
        const configured = isAuthConfigured(config.web);
        const enabled = config.web?.enabled !== false;
        const session =
            configured && enabled ? validateSession(req.cookies['tg_dl_session']) : false;
        res.json({
            configured,
            enabled,
            authenticated: !!session,
            // Role surfaced so the SPA can mark `<body data-role>` and hide
            // admin-only UI for guest sessions in a single source-of-truth pass.
            role: session ? session.role : null,
            setupRequired: !configured || !enabled,
            guestEnabled: isGuestEnabled(config.web),
        });
    });

    return router;
}
