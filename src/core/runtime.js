/**
 * Runtime — singleton orchestrator that owns the realtime monitor +
 * downloader + auto-forwarder for the in-process web server.
 *
 * The CLI's `monitor` command does the same wiring locally; this module
 * exists so the dashboard can start/stop the engine without spawning a
 * second process and without the dual-DB-writer footgun.
 *
 * Lifecycle:
 *   stopped → starting → running → stopping → stopped
 *
 * Subscribe to the 'state', 'event' and 'error' EventEmitter channels
 * to reflect activity in the SPA.
 */

import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import { DownloadManager } from './downloader.js';
import { RealtimeMonitor } from './monitor.js';
import { RateLimiter } from './security.js';
import { AutoForwarder } from './forwarder.js';
import { migrateFolders } from './downloader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../data/config.json');

class Runtime extends EventEmitter {
    constructor() {
        super();
        this.state = 'stopped';
        this.error = null;
        this.startedAt = null;

        this._accountManager = null; // injected at start time
        this._monitor = null;
        this._downloader = null;
        this._forwarder = null;
        this._rateLimiter = null;
    }

    setState(s, error = null) {
        this.state = s;
        this.error = error;
        this.emit('state', { state: s, error });
    }

    /**
     * @param {object} opts
     * @param {object} opts.config        full app config (loadConfig() result)
     * @param {AccountManager} opts.accountManager
     */
    async start(opts) {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error(`Runtime already ${this.state}`);
        }
        const { config, accountManager } = opts;
        if (!accountManager || accountManager.count === 0) {
            throw new Error('No Telegram accounts loaded. Add an account first.');
        }
        this.setState('starting');

        try {
            this._accountManager = accountManager;
            const client = accountManager.getDefaultClient();
            if (client?.setLogLevel) client.setLogLevel('none');

            await migrateFolders(config.download?.path);

            this._rateLimiter = new RateLimiter(config.rateLimits);
            this._downloader = new DownloadManager(client, config, this._rateLimiter);
            this._forwarder = new AutoForwarder(client, config, accountManager);
            this._monitor = new RealtimeMonitor(
                client, this._downloader, config, CONFIG_PATH, accountManager,
            );

            // Bridge engine events → 'event' channel for WebSocket fan-out.
            this._wireEvents();

            await this._monitor.start();

            this.startedAt = Date.now();
            this.setState('running');
        } catch (e) {
            try { await this._cleanup(); } catch {}
            this.setState('error', e?.message || String(e));
            throw e;
        }
    }

    async stop() {
        if (this.state === 'stopped') return;
        this.setState('stopping');
        try {
            await this._cleanup();
        } finally {
            this.setState('stopped');
        }
    }

    async _cleanup() {
        try { if (this._monitor) await this._monitor.stop(); } catch {}
        try { if (this._downloader) await this._downloader.stop(); } catch {}
        this._monitor = null;
        this._downloader = null;
        this._forwarder = null;
        this._rateLimiter = null;
        this.startedAt = null;
    }

    _wireEvents() {
        const fwd = (type) => (payload) => this.emit('event', { type, payload });

        this._rateLimiter.on('wait', (seconds) => this.emit('event', { type: 'rate_wait', payload: { seconds } }));
        this._rateLimiter.on('flood', (seconds) => this.emit('event', { type: 'flood_wait', payload: { seconds } }));

        this._downloader.on('start', (job) => this.emit('event', {
            type: 'download_start',
            payload: this._serializeJob(job),
        }));
        this._downloader.on('complete', (job) => this.emit('event', {
            type: 'download_complete',
            payload: this._serializeJob(job),
        }));
        this._downloader.on('download_complete', async (info) => {
            try { await this._forwarder.process(info); } catch (e) {
                this.emit('event', { type: 'forward_error', payload: { error: e.message } });
            }
        });
        this._downloader.on('error', ({ job, error }) => this.emit('event', {
            type: 'download_error',
            payload: { job: this._serializeJob(job), error: String(error) },
        }));
        this._downloader.on('scale', fwd('scale'));
        this._downloader.on('queue', (length) => this.emit('event', { type: 'queue_length', payload: { length } }));
        this._downloader.on('progress', (p) => this.emit('event', { type: 'download_progress', payload: p }));

        this._monitor.on('configReloaded', (newConfig) => {
            if (this._forwarder) this._forwarder.config = newConfig;
        });
        this._monitor.on('download', fwd('monitor_download'));
        this._monitor.on('urls', fwd('monitor_urls'));
        this._monitor.on('error', fwd('monitor_error'));
        this._monitor.on('started', fwd('monitor_started'));
    }

    _serializeJob(job) {
        if (!job) return null;
        return {
            key: job.key,
            groupId: job.groupId,
            messageId: job.message?.id,
            mediaType: job.mediaType,
            filePath: job.filePath,
            fileSize: job.fileSize,
        };
    }

    status() {
        return {
            state: this.state,
            error: this.error,
            startedAt: this.startedAt,
            uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
            stats: this._monitor?.stats || null,
            queue: this._downloader?.pendingCount ?? 0,
            active: this._downloader?.active?.size ?? 0,
            workers: this._downloader?.workerCount ?? 0,
            accounts: this._accountManager?.count ?? 0,
        };
    }
}

export const runtime = new Runtime();
