// Static checks on scripts/docker-entrypoint.sh — there is no container in
// the test run, so assert the privileged steps sit where they must.

import { describe, it, expect } from 'vitest';
import fs from 'fs';

const script = fs
    .readFileSync(new URL('../scripts/docker-entrypoint.sh', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

describe('docker-entrypoint.sh', () => {
    it('makes the resolver files readable before dropping to node', () => {
        const chmod = script.indexOf(
            'chmod a+r /etc/hosts /etc/resolv.conf /etc/hostname 2>/dev/null || true',
        );
        const rootBranch = script.indexOf('if [ "$(id -u)" = "0" ]; then');
        const gosu = script.indexOf('exec gosu node "$@"');
        expect(rootBranch).toBeGreaterThan(-1);
        expect(chmod).toBeGreaterThan(rootBranch);
        expect(chmod).toBeLessThan(gosu);
        // Not behind FAST_BOOT — DNS must work on every boot.
        const fastBootEnd = script.indexOf('\n    fi\n', script.indexOf('FAST_BOOT:-0'));
        expect(chmod).toBeGreaterThan(fastBootEnd);
    });
});
