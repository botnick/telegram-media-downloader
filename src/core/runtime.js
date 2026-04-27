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
import { metrics } from './metrics.js';

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
        metrics.set('tgdl_monitor_state', s === 'running' ? 1 : 0);
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

        this._downloader.on('start', (job) => {
            this.emit('event', { type: 'download_start', payload: this._serializeJob(job) });
            // Stash the start time on the job so we can record duration on
            // completion. job objects come straight from enqueue() so we can
            // mutate them safely.
            if (job) job.__startedAt = Date.now();
        });
        this._downloader.on('complete', (job) => {
            this.emit('event', { type: 'download_complete', payload: this._serializeJob(job) });
            metrics.inc('tgdl_downloads_total', 1, { type: job?.mediaType || 'other' });
            if (job?.__startedAt) {
                const sec = (Date.now() - job.__startedAt) / 1000;
                metrics.observe('tgdl_download_duration_seconds', sec, { type: job.mediaType || 'other' });
            }
        });
        this._downloader.on('download_complete', async (info) => {
            try { await this._forwarder.process(info); } catch (e) {
                this.emit('event', { type: 'forward_error', payload: { error: e.message } });
            }
        });
        this._downloader.on('error', ({ job, error }) => {
            this.emit('event', {
                type: 'download_error',
                payload: { job: this._serializeJob(job), error: String(error) },
            });
            metrics.inc('tgdl_downloads_failed_total', 1, { type: job?.mediaType || 'other' });
        });
        this._downloader.on('scale', fwd('scale'));
        this._downloader.on('queue', (length) => {
            this.emit('event', { type: 'queue_length', payload: { length } });
            metrics.set('tgdl_queue_size', length);
        });
        this._downloader.on('progress', (p) => this.emit('event', { type: 'download_progress', payload: p }));

        this._monitor.on('configReloaded', (newConfig) => {
            if (this._forwarder) this._forwarder.config = newConfig;
        });
        this._monitor.on('download', fwd('monitor_download'));
        this._monitor.on('urls', fwd('monitor_urls'));
        this._monitor.on('error', fwd('monitor_error'));
        this._monitor.on('started', fwd('monitor_started'));
        // Rescue Mode: monitor.handleDeleteEvent() emits 'rescued' for each
        // local row that was kept because Telegram deleted the source. The
        // 'event' bus relays it through the WS broadcaster as { type:
        // 'rescued', groupId, messageId } so the SPA can flip the badge.
        this._monitor.on('rescued', (p) => this.emit('event', { type: 'rescued', payload: p }));
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
        const out = {
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
        // Cheap to refresh the gauges every status() call — this is what
        // /api/monitor/status drives the SPA from, and it's also the natural
        // moment to refresh the Prometheus snapshot.
        metrics.set('tgdl_queue_size', out.queue);
        metrics.set('tgdl_active_downloads', out.active);
        metrics.set('tgdl_workers', out.workers);
        metrics.set('tgdl_accounts_loaded', out.accounts);
        return out;
    }
}

export const runtime = new Runtime();
