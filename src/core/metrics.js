/**
 * Lightweight metrics collector. Emits OpenMetrics / Prometheus text-format
 * via render() — no external dependency. Just enough to wire a Grafana
 * dashboard or a Prometheus scrape job at /metrics without bringing in the
 * 50 KB prom-client library.
 *
 * Usage:
 *   import { metrics } from './core/metrics.js';
 *   metrics.inc('tgdl_downloads_total', 1, { type: 'photo' });
 *   metrics.set('tgdl_queue_size', 42);
 *   metrics.observe('tgdl_download_duration_seconds', 12.3, { type: 'video' });
 *
 * Cardinality is up to the caller — pin label values to a small finite set
 * (type=photo|video|document, account=… is fine; per-message-id is not).
 */

const counters = new Map();   // name → Map<labelKey, number>
const gauges   = new Map();   // name → Map<labelKey, number>
const histos   = new Map();   // name → Map<labelKey, {sum, count, buckets}>
const help = new Map();       // name → string
const types = new Map();      // name → 'counter' | 'gauge' | 'histogram'

const DEFAULT_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800];

function labelKey(labels) {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map(k => `${k}=${labels[k]}`).join(',');
}

function escapeLabel(v) {
    return String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(key) {
    if (!key) return '';
    const pairs = key.split(',').map(p => {
        const i = p.indexOf('=');
        return `${p.slice(0, i)}="${escapeLabel(p.slice(i + 1))}"`;
    });
    return `{${pairs.join(',')}}`;
}

export const metrics = {
    setHelp(name, h) { help.set(name, h); },
    declare(name, type, h) {
        types.set(name, type);
        if (h) help.set(name, h);
    },

    inc(name, delta = 1, labels) {
        if (!types.has(name)) types.set(name, 'counter');
        let m = counters.get(name);
        if (!m) { m = new Map(); counters.set(name, m); }
        const k = labelKey(labels);
        m.set(k, (m.get(k) || 0) + delta);
    },

    set(name, value, labels) {
        if (!types.has(name)) types.set(name, 'gauge');
        let m = gauges.get(name);
        if (!m) { m = new Map(); gauges.set(name, m); }
        m.set(labelKey(labels), Number(value));
    },

    observe(name, value, labels, buckets = DEFAULT_BUCKETS) {
        if (!types.has(name)) types.set(name, 'histogram');
        let m = histos.get(name);
        if (!m) { m = new Map(); histos.set(name, m); }
        const k = labelKey(labels);
        let h = m.get(k);
        if (!h) {
            h = { sum: 0, count: 0, buckets: new Map(buckets.map(b => [b, 0])) };
            m.set(k, h);
        }
        const v = Number(value);
        h.sum += v; h.count += 1;
        for (const b of buckets) if (v <= b) h.buckets.set(b, h.buckets.get(b) + 1);
    },

    /** Render the current snapshot as Prometheus text-format. */
    render() {
        const lines = [];
        const names = new Set([...counters.keys(), ...gauges.keys(), ...histos.keys()]);
        for (const name of [...names].sort()) {
            const t = types.get(name) || 'gauge';
            if (help.has(name)) lines.push(`# HELP ${name} ${help.get(name)}`);
            lines.push(`# TYPE ${name} ${t}`);
            if (counters.has(name)) {
                for (const [k, v] of counters.get(name)) lines.push(`${name}${renderLabels(k)} ${v}`);
            }
            if (gauges.has(name)) {
                for (const [k, v] of gauges.get(name)) lines.push(`${name}${renderLabels(k)} ${v}`);
            }
            if (histos.has(name)) {
                for (const [k, h] of histos.get(name)) {
                    const labelObj = k
                        ? Object.fromEntries(k.split(',').map(p => p.split('=')))
                        : {};
                    for (const [bound, count] of h.buckets) {
                        const labels = { ...labelObj, le: String(bound) };
                        lines.push(`${name}_bucket${renderLabels(labelKey(labels))} ${count}`);
                    }
                    const inf = { ...labelObj, le: '+Inf' };
                    lines.push(`${name}_bucket${renderLabels(labelKey(inf))} ${h.count}`);
                    lines.push(`${name}_sum${renderLabels(k)} ${h.sum}`);
                    lines.push(`${name}_count${renderLabels(k)} ${h.count}`);
                }
            }
        }
        // Default node process gauges, useful for capacity planning.
        const m = process.memoryUsage();
        lines.push('# TYPE process_resident_memory_bytes gauge');
        lines.push(`process_resident_memory_bytes ${m.rss}`);
        lines.push('# TYPE process_heap_bytes gauge');
        lines.push(`process_heap_bytes ${m.heapUsed}`);
        lines.push('# TYPE process_uptime_seconds counter');
        lines.push(`process_uptime_seconds ${Math.round(process.uptime())}`);
        return lines.join('\n') + '\n';
    },

    reset() { counters.clear(); gauges.clear(); histos.clear(); },
};

// Up-front type/help declarations so /metrics surfaces complete metadata
// even before any event has fired.
metrics.declare('tgdl_downloads_total', 'counter', 'Total successful downloads.');
metrics.declare('tgdl_downloads_failed_total', 'counter', 'Total failed downloads.');
metrics.declare('tgdl_history_jobs_total', 'counter', 'Total history-backfill jobs started.');
metrics.declare('tgdl_url_downloads_total', 'counter', 'Total Download-by-Link enqueues.');
metrics.declare('tgdl_stories_downloads_total', 'counter', 'Total Stories enqueued for download.');
metrics.declare('tgdl_login_total', 'counter', 'Dashboard login attempts.');
metrics.declare('tgdl_queue_size', 'gauge', 'Current downloader queue depth (high + normal lanes).');
metrics.declare('tgdl_active_downloads', 'gauge', 'Downloads currently in flight.');
metrics.declare('tgdl_workers', 'gauge', 'Active downloader worker count.');
metrics.declare('tgdl_accounts_loaded', 'gauge', 'Telegram accounts currently loaded.');
metrics.declare('tgdl_monitor_state', 'gauge', '1 if the realtime monitor is running, else 0.');
metrics.declare('tgdl_download_duration_seconds', 'histogram', 'Per-file download duration.');
