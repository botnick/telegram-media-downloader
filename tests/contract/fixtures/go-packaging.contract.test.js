import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

describe('pure-Go production packaging', () => {
    it('does not ship a Node server, proxy or launcher', () => {
        const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
        const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
        const runner = fs.readFileSync(path.join(root, 'runner.sh'), 'utf8');
        const packageJSON = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(docker).not.toMatch(/FROM\s+node:/i);
        expect(docker).not.toMatch(/CMD\s*\[\s*["']node/i);
        expect(docker).not.toMatch(/COPY\s+src\s/i);
        expect(compose).not.toMatch(/NODE_OPTIONS|NODE_ENV|command:.*node/i);
        expect(runner).not.toMatch(/\bnode\b/i);
        expect(packageJSON.scripts.start).toMatch(/go run/);
        expect(packageJSON.scripts.prod).not.toMatch(/node/);
    });
});
