// Backup contract: providers, destinations CRUD, config/status/jobs reads,
// test-connection per provider, mirror catch-up run on the local provider
// (real files land in <DATA>/backup-target), pause/resume, encryption,
// job retry, snapshot mode — plus the backup_* WS events they broadcast.
//
// Seed: three DISABLED destinations (#1 local mirror → <DATA>/backup-target,
// #2 s3 → s3.invalid, #3 sftp → nas.invalid) and three backup_jobs (#1, #2
// done on #1, #3 failed on #2). The network sandbox makes every remote
// provider fail at once with ENOTFOUND.
//
// BACKUP_WORKERS_PER_DEST=1 (a documented env knob) so a worker uploads one
// job at a time: with the default 3 the order of backup_done events — and
// whether the second of two rows sharing one file (#14/#15, download-time
// dedup) is "uploaded" or "skipped" — depends on scheduling.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { until, useContract } from './harness.js';

const h = useContract(import.meta.url, { env: { BACKUP_WORKERS_PER_DEST: '1' } });

// WS messages worth keeping from a backup flow: every non-ambient event
// plus the structured log lines the backup subsystem writes.
function backupMessages(list) {
    return list.filter((m) => m.type !== 'log' || m.source === 'backup');
}

async function waitIdle(t, id) {
    return until(
        async () => {
            const r = await t.request('GET', `/api/backup/destinations/${id}/status`);
            const s = r.json;
            return s && s.queued === 0 && s.processing === 0 && !s.running ? s : null;
        },
        { what: `backup destination #${id} idle`, timeoutMs: 20_000 },
    );
}

function listTree(root) {
    const out = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs);
            else
                out.push(
                    `${path.relative(root, abs).split(path.sep).join('/')} ${fs.statSync(abs).size}`,
                );
        }
    };
    walk(root);
    return out.sort();
}

describe('backup read API', () => {
    it('providers', async () => {
        const t = h.t;
        await t.exchange('providers', 'GET', '/api/backup/providers');
        await t.exchange('providers as guest → 403', 'GET', '/api/backup/providers', {
            as: 'guest',
        });
        await t.exchange('destinations as anon → 401', 'GET', '/api/backup/destinations', {
            as: 'anon',
        });
    });

    it('destinations, per-destination config / status / jobs', async () => {
        const t = h.t;
        await t.exchange('destinations (seeded, newest first)', 'GET', '/api/backup/destinations');
        for (const id of [1, 2, 3]) {
            await t.exchange(
                `config #${id} (secrets omitted)`,
                'GET',
                `/api/backup/destinations/${id}/config`,
            );
            await t.exchange(`status #${id}`, 'GET', `/api/backup/destinations/${id}/status`);
        }
        await t.exchange('config unknown id → 404', 'GET', '/api/backup/destinations/999/config');
        await t.exchange('config id 0 → 400', 'GET', '/api/backup/destinations/0/config');
        await t.exchange(
            'status non-numeric id → 400',
            'GET',
            '/api/backup/destinations/abc/status',
        );
        await t.exchange('status unknown id → 404', 'GET', '/api/backup/destinations/999/status');
        await t.exchange('jobs #1', 'GET', '/api/backup/destinations/1/jobs');
        await t.exchange(
            'jobs #1 limit=1 offset=1',
            'GET',
            '/api/backup/destinations/1/jobs?limit=1&offset=1',
        );
        await t.exchange(
            'jobs #2 status=failed',
            'GET',
            '/api/backup/destinations/2/jobs?status=failed',
        );
        await t.exchange(
            'jobs #2 status=done',
            'GET',
            '/api/backup/destinations/2/jobs?status=done',
        );
        await t.exchange(
            'jobs unknown destination → empty',
            'GET',
            '/api/backup/destinations/999/jobs',
        );
        await t.exchange('jobs bad id → 400', 'GET', '/api/backup/destinations/-1/jobs');
        await t.exchange('recent jobs', 'GET', '/api/backup/jobs/recent');
        await t.exchange('recent jobs limit=1', 'GET', '/api/backup/jobs/recent?limit=1');
    });
});

describe('backup validation and connection tests', () => {
    it('create validation', async () => {
        const t = h.t;
        await t.exchange('create empty body → 400', 'POST', '/api/backup/destinations', {
            body: {},
        });
        await t.exchange('create unknown provider → 400', 'POST', '/api/backup/destinations', {
            body: { name: 'x', provider: 'nope' },
        });
        await t.exchange('create snapshot without cron → 400', 'POST', '/api/backup/destinations', {
            body: { name: 'snap', provider: 'local', mode: 'snapshot', config: { rootPath: '/x' } },
        });
        await t.exchange('create as guest → 403', 'POST', '/api/backup/destinations', {
            as: 'guest',
            body: { name: 'g', provider: 'local' },
        });
    });

    it('a destination with a relative rootPath is stored, then fails its test', async () => {
        const t = h.t;
        await t.exchange(
            'create disabled local with relative root (#4)',
            'POST',
            '/api/backup/destinations',
            {
                body: {
                    name: 'Relative root',
                    provider: 'local',
                    enabled: false,
                    config: { rootPath: 'relative/path' },
                },
            },
        );
        await t.exchange(
            'test #4 relative root → ok:false',
            'POST',
            '/api/backup/destinations/4/test',
        );
    });

    it('test connection per provider', async () => {
        const t = h.t;
        await t.exchange('test #1 local → ok', 'POST', '/api/backup/destinations/1/test');
        // `detail` of a failed remote probe is the client library's error
        // text (AWS SDK / ssh2 wording around the resolver error) — any
        // other implementation words it differently. ok:false + a
        // non-empty detail is the contract.
        const libText = {
            detail: 'third-party client library error text (AWS SDK / ssh2) for an unresolvable host',
        };
        const s3 = await t.exchange(
            'test #2 s3 unreachable',
            'POST',
            '/api/backup/destinations/2/test',
            {
                mask: libText,
            },
        );
        const sftp = await t.exchange(
            'test #3 sftp unreachable',
            'POST',
            '/api/backup/destinations/3/test',
            {
                mask: libText,
            },
        );
        expect(s3.json.detail.length).toBeGreaterThan(0);
        expect(sftp.json.detail.length).toBeGreaterThan(0);
        await t.exchange('test unknown id → 500', 'POST', '/api/backup/destinations/999/test');
        await t.exchange('test bad id → 400', 'POST', '/api/backup/destinations/x/test');
        // The local probe file is removed again.
        expect(fs.existsSync(path.join(t.dataDir, 'backup-target', '.tgdl-test-probe'))).toBe(
            false,
        );
    });

    it('update validation', async () => {
        const t = h.t;
        await t.exchange('update bad id → 400', 'PUT', '/api/backup/destinations/abc', {
            body: { name: 'x' },
        });
        await t.exchange('update unknown id → 400', 'PUT', '/api/backup/destinations/999', {
            body: { name: 'x' },
        });
        await t.exchange('update invalid mode → 400', 'PUT', '/api/backup/destinations/4', {
            body: { mode: 'bogus' },
        });
        await t.exchange('pause unknown id → 500', 'POST', '/api/backup/destinations/999/pause');
        await t.exchange('resume unknown id → 500', 'POST', '/api/backup/destinations/999/resume');
        await t.exchange(
            'encryption without passphrase → 400',
            'POST',
            '/api/backup/destinations/4/encryption',
            {
                body: { enabled: true },
            },
        );
        await t.exchange(
            'unlock when not encrypted → 400',
            'POST',
            '/api/backup/destinations/4/unlock',
            {
                body: { passphrase: 'pw' },
            },
        );
        await t.exchange(
            'encryption unknown id → 400',
            'POST',
            '/api/backup/destinations/999/encryption',
            {
                body: { enabled: false },
            },
        );
    });
});

describe('mirror run on the local provider', () => {
    it('enable → run → every file mirrored, with WS progress', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('enable #1', 'PUT', '/api/backup/destinations/1', {
            body: { enabled: true },
        });
        await ws.waitFor((m) => m.type === 'backup_queue_drained' && m.destinationId === 1);
        await t.exchange('run #1 (mirror catch-up)', 'POST', '/api/backup/destinations/1/run');
        await ws.waitFor((m) => m.type === 'log' && /mirror catch-up enqueued/.test(m.msg));
        await waitIdle(t, 1);
        await ws.waitFor(
            (m) =>
                m.type === 'backup_queue_drained' &&
                ws.messages.filter((x) => x.type === 'backup_queue_drained').length >= 2,
        );
        t.recordWs('ws: enable + mirror run #1', backupMessages(ws.drain()), { keep: ['log'] });
        await t.exchange('status #1 after run', 'GET', '/api/backup/destinations/1/status');
        await t.exchange('jobs #1 after run', 'GET', '/api/backup/destinations/1/jobs?limit=100');
        await t.exchange('destinations after run', 'GET', '/api/backup/destinations');
        t.store.record('files mirrored into <DATA>/backup-target', {
            derived: listTree(path.join(t.dataDir, 'backup-target')),
        });
        ws.close();
    });

    it('re-run enqueues nothing new', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('run #1 again', 'POST', '/api/backup/destinations/1/run');
        await ws.waitFor((m) => m.type === 'log' && /mirror catch-up enqueued/.test(m.msg));
        await ws.waitFor((m) => m.type === 'backup_queue_drained');
        t.recordWs('ws: second run #1', backupMessages(ws.drain()), { keep: ['log'] });
        ws.close();
    });

    it('run on a disabled destination answers 200 and logs the refusal', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('run disabled #2', 'POST', '/api/backup/destinations/2/run');
        await ws.waitFor((m) => m.type === 'log' && /run failed for #2/.test(m.msg));
        await t.exchange('run unknown id → 200', 'POST', '/api/backup/destinations/998/run');
        await ws.waitFor((m) => m.type === 'log' && /run failed for #998/.test(m.msg));
        t.recordWs('ws: run disabled / unknown', backupMessages(ws.drain()), { keep: ['log'] });
        ws.close();
    });
});

describe('pause, resume, encryption, retry, delete', () => {
    it('pause / resume broadcast the destination', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('pause #1', 'POST', '/api/backup/destinations/1/pause');
        await t.exchange('status #1 paused', 'GET', '/api/backup/destinations/1/status');
        await t.exchange('resume #1', 'POST', '/api/backup/destinations/1/resume');
        await t.exchange('status #1 resumed', 'GET', '/api/backup/destinations/1/status');
        await until(
            () => ws.messages.filter((x) => x.type === 'backup_destination_updated').length >= 2,
            {
                what: 'two destination updates',
            },
        );
        await until(() => ws.messages.some((x) => x.type === 'backup_queue_drained'), {
            what: 'drain after resume',
        });
        t.recordWs('ws: pause + resume #1', backupMessages(ws.drain()), { keep: ['log'] });
        ws.close();
    });

    it('encryption on / unlock / off', async () => {
        const t = h.t;
        await t.exchange('encryption on #4', 'POST', '/api/backup/destinations/4/encryption', {
            body: { enabled: true, passphrase: 'contract-passphrase' },
        });
        await t.exchange('unlock #4', 'POST', '/api/backup/destinations/4/unlock', {
            body: { passphrase: 'contract-passphrase' },
        });
        await t.exchange(
            'unlock #4 empty passphrase (accepted)',
            'POST',
            '/api/backup/destinations/4/unlock',
            {
                body: {},
            },
        );
        await t.exchange('status #4 encrypted', 'GET', '/api/backup/destinations/4/status');
        await t.exchange('encryption off #4', 'POST', '/api/backup/destinations/4/encryption', {
            body: { enabled: false },
        });
    });

    it('retry a failed job', async () => {
        const t = h.t;
        await t.exchange('retry job #3', 'POST', '/api/backup/jobs/3/retry');
        await t.exchange('jobs #2 after retry', 'GET', '/api/backup/destinations/2/jobs');
        await t.exchange('retry unknown job', 'POST', '/api/backup/jobs/999/retry');
        await t.exchange('retry bad id → 400', 'POST', '/api/backup/jobs/abc/retry');
    });

    it('update config merges and keeps secrets', async () => {
        const t = h.t;
        await t.exchange(
            'update #2 name + non-secret config',
            'PUT',
            '/api/backup/destinations/2',
            {
                body: {
                    name: 'Offsite S3 (renamed)',
                    retainCount: 400,
                    config: { bucket: 'other-bucket', secretAccessKey: '' },
                },
            },
        );
        await t.exchange('config #2 after update', 'GET', '/api/backup/destinations/2/config');
    });

    it('delete', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange('delete #4', 'DELETE', '/api/backup/destinations/4');
        await t.exchange('delete unknown id', 'DELETE', '/api/backup/destinations/999');
        await t.exchange('delete bad id → 400', 'DELETE', '/api/backup/destinations/abc');
        await until(
            () => ws.messages.filter((x) => x.type === 'backup_destination_removed').length >= 2,
            {
                what: 'two removal broadcasts',
            },
        );
        t.recordWs('ws: delete destinations', backupMessages(ws.drain()), { keep: ['log'] });
        ws.close();
        await t.exchange('destinations after delete', 'GET', '/api/backup/destinations');
    });
});

describe('create enabled destinations', () => {
    it('mirror destination: created, worker boots, drains', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        const root = path.join(t.dataDir, 'backup-new');
        await t.exchange('create enabled local mirror (#5)', 'POST', '/api/backup/destinations', {
            body: {
                name: 'New mirror',
                provider: 'local',
                config: { rootPath: root },
                retainCount: 3,
            },
        });
        await ws.waitFor((m) => m.type === 'backup_queue_drained' && m.destinationId === 5);
        t.recordWs('ws: create enabled mirror', backupMessages(ws.drain()), { keep: ['log'] });
        ws.close();
        await t.exchange('config #5', 'GET', '/api/backup/destinations/5/config');
    });

    it('a job whose source file vanished fails without retry (backup_error)', async () => {
        const t = h.t;
        fs.rmSync(path.join(t.dataDir, 'downloads', 'Gamma Docs', 'documents', 'notes.txt.gz'));
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        await t.exchange(
            'run #5 with one source file missing',
            'POST',
            '/api/backup/destinations/5/run',
        );
        await ws.waitFor((m) => m.type === 'backup_error' && m.destinationId === 5);
        await waitIdle(t, 5);
        await ws.waitFor(
            (m) =>
                m.type === 'backup_queue_drained' &&
                m.destinationId === 5 &&
                ws.messages.filter((x) => x.type === 'backup_done' && x.destinationId === 5)
                    .length >= 19,
        );
        // Only the failure and the tally are recorded here; the per-file
        // upload sequence has the same shape as the #1 run above.
        const all = ws.drain();
        t.recordWs(
            'ws: run #5 — failed job',
            all.filter(
                (m) => m.type === 'backup_error' || (m.type === 'log' && /failed/.test(m.msg)),
            ),
            { keep: ['log'] },
        );
        t.store.record('run #5 tally (derived)', {
            derived: {
                done: all.filter((m) => m.type === 'backup_done').length,
                errors: all.filter((m) => m.type === 'backup_error').length,
            },
        });
        ws.close();
        await t.exchange(
            'jobs #5 status=failed',
            'GET',
            '/api/backup/destinations/5/jobs?status=failed',
        );
        await t.exchange('status #5 after run', 'GET', '/api/backup/destinations/5/status');
    });

    it('snapshot destination: run builds an archive and uploads it', async () => {
        const t = h.t;
        const ws = t.ws({ as: 'admin' });
        await ws.opened;
        ws.drain();
        const root = path.join(t.dataDir, 'backup-snap');
        await t.exchange('create snapshot destination (#6)', 'POST', '/api/backup/destinations', {
            body: {
                name: 'Nightly',
                provider: 'local',
                mode: 'snapshot',
                cron: '0 3 * * *',
                retainCount: 2,
                config: { rootPath: root },
            },
        });
        await t.exchange('run snapshot #6', 'POST', '/api/backup/destinations/6/run');
        await ws.waitFor((m) => m.type === 'backup_done' && m.destinationId === 6, 20_000);
        await ws.waitFor(
            (m) =>
                m.type === 'backup_destination_updated' &&
                m.destination?.id === 6 &&
                m.destination.totalFiles === 1,
        );
        await waitIdle(t, 6);
        const snapMask = {
            bytes: 'size of a tar.gz of the live DB (kv timestamps, session rows) — differs run to run',
            bytesUploaded: 'size of a tar.gz of the live DB — differs run to run',
            'destination.totalBytes': 'size of a tar.gz of the live DB — differs run to run',
        };
        // Log lines name the archive (snapshot-YYYYMMDD-HHMMSS, wall clock)
        // and its byte size (a gzip of the live DB): both rewritten to
        // placeholders here, the shape is still checked.
        const msgs = backupMessages(ws.drain()).map((m) =>
            m.type === 'log'
                ? {
                      ...m,
                      msg: String(m.msg)
                          .replace(
                              /snapshot-\d{8}-\d{6}\.tar\.gz/g,
                              'snapshot-<YYYYMMDD-HHMMSS>.tar.gz',
                          )
                          .replace(/\(\d+ B\)/g, '(<bytes> B)'),
                  }
                : m,
        );
        t.recordWs('ws: snapshot run #6', msgs, {
            keep: ['log'],
            mask: snapMask,
            note: 'snapshot archive name/size in log lines rewritten to placeholders (wall clock + gzip of live DB)',
        });
        ws.close();
        const jobs = await t.request('GET', '/api/backup/destinations/6/jobs');
        const job = jobs.json.jobs[0];
        t.store.record('snapshot job #6 (derived)', {
            derived: {
                count: jobs.json.jobs.length,
                status: job.status,
                attempts: job.attempts,
                remotePathShape: /^snapshots\/snapshot-\d{8}-\d{6}\.tar\.gz$/.test(job.remote_path),
                snapshotPathShape: /[\\/]backups[\\/]snapshot-\d{8}-\d{6}\.tar\.gz$/.test(
                    job.snapshot_path,
                ),
                stagingArchiveDeleted: !fs.existsSync(job.snapshot_path),
                uploadedBytesMatchFile:
                    fs.statSync(path.join(root, ...job.remote_path.split('/'))).size ===
                    job.bytes_uploaded,
                remoteFiles: fs.readdirSync(path.join(root, 'snapshots')).length,
            },
        });
        await t.exchange('status #6', 'GET', '/api/backup/destinations/6/status', {
            mask: { totalBytes: 'size of a tar.gz of the live DB — differs run to run' },
        });
    });
});
