// The web server's legacy single-session client (data/session.enc) must not
// connect once data/sessions/ holds an account: migrateLegacy() copies that
// session there, and one auth key on two MTProto connections can get it
// revoked (AUTH_KEY_DUPLICATED).

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasAccountSessions } from '../src/core/accounts.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdl-legacy-guard-'));

afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hasAccountSessions', () => {
    it('is false when the sessions dir is missing', () => {
        expect(hasAccountSessions(path.join(tmp, 'nope'))).toBe(false);
    });

    it('ignores files that are not sessions', () => {
        const dir = path.join(tmp, 'other');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
        fs.writeFileSync(path.join(dir, 'acc.enc.bak'), 'x');
        expect(hasAccountSessions(dir)).toBe(false);
    });

    it('is true once an account session exists', () => {
        const dir = path.join(tmp, 'sessions');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'acc_1.enc'), '{}');
        expect(hasAccountSessions(dir)).toBe(true);
    });
});
