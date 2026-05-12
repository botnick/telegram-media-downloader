import express from 'express';
import net from 'net';
import { parseTelegramUrl, parseUrlList, UrlParseError } from '../../core/url-resolver.js';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';

// Refuse to probe addresses that are obviously private or local — without
// this, an authenticated user could use the dashboard as a port scanner for
// the host's internal network. RFC 1918 + loopback + link-local + IPv6
// ULA / loopback / link-local + multicast are all blocked.
const SSRF_BLOCKLIST = [
    /^127\./, // 127.0.0.0/8
    /^10\./, // 10.0.0.0/8
    /^192\.168\./, // 192.168.0.0/16
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^169\.254\./, // 169.254.0.0/16 link-local
    /^0\./, // 0.0.0.0/8
    /^22[4-9]\./,
    /^23\d\./, // multicast
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
    /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(host) {
    if (!host) return true;
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal'))
        return true;
    return SSRF_BLOCKLIST.some((re) => re.test(host));
}

function detectMediaType(message) {
    const m = message?.media || message;
    if (m?.sticker || message?.sticker) return 'stickers';
    if (m?.photo || m?.className === 'MessageMediaPhoto') return 'photos';
    const doc = m?.document || (m?.className === 'MessageMediaDocument' ? m : null);
    if (doc) {
        const mime = doc.mimeType || '';
        if (mime.startsWith('video/')) return 'videos';
        if (mime.startsWith('audio/')) return mime.includes('ogg') ? 'voice' : 'audio';
        if (
            mime.includes('gif') ||
            (doc.attributes || []).some((a) => a.className === 'DocumentAttributeAnimated')
        )
            return 'gifs';
        if (mime.includes('image/webp') || mime.includes('application/x-tgsticker'))
            return 'stickers';
        return 'documents';
    }
    return null;
}

export function createLinkDownloadRouter({ getAccountManager }) {
    const router = express.Router();

    // ====== Proxy test =========================================================
    //
    // Briefly opens a TCP connection to host:port to confirm the proxy is
    // reachable. We don't speak SOCKS/MTProto here — that's the job of gramJS at
    // the next monitor start — but a TCP open is enough to catch typos and DNS
    // misconfiguration without needing a full Telegram round-trip.
    router.post('/proxy/test', async (req, res) => {
        const { host, port } = req.body || {};
        if (!host || !port) return res.status(400).json({ error: 'host and port required' });
        if (typeof host !== 'string' || host.length > 253) {
            return res.status(400).json({ error: 'invalid host' });
        }
        const normalizedHost = host.trim().toLowerCase();
        if (!normalizedHost || normalizedHost.length > 253) {
            return res.status(400).json({ error: 'invalid host' });
        }
        if (isPrivateHost(normalizedHost)) {
            return res.status(400).json({
                error: 'Private / loopback / link-local addresses are not allowed for proxy probes.',
            });
        }
        const cfg = loadConfig();
        const allowedProxyTestHosts = Array.isArray(cfg?.security?.allowedProxyTestHosts)
            ? cfg.security.allowedProxyTestHosts
                  .filter((h) => typeof h === 'string' && h.trim())
                  .map((h) => h.trim().toLowerCase())
            : [];
        // Enforce server-controlled destinations to prevent SSRF.
        // Proxy probing is only allowed for explicitly configured hosts.
        if (allowedProxyTestHosts.length === 0) {
            return res.status(400).json({
                error: 'allowedProxyTestHosts must be configured to use proxy test',
            });
        }
        if (!allowedProxyTestHosts.includes(normalizedHost)) {
            return res.status(400).json({
                error: 'host is not in allowedProxyTestHosts',
            });
        }
        const p = parseInt(port, 10);
        if (!Number.isFinite(p) || p < 1 || p > 65535) {
            return res.status(400).json({ error: 'port must be 1-65535' });
        }
        const start = Date.now();
        const sock = new net.Socket();
        let done = false;
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            try {
                sock.destroy();
            } catch {}
            if (ok) return res.json({ ok: true, ms: Date.now() - start });
            return res.json({ ok: false, error });
        };
        sock.setTimeout(5000);
        sock.once('connect', () => finish(true));
        sock.once('error', (e) => finish(false, e.message));
        sock.once('timeout', () => finish(false, 'timeout'));
        sock.connect(p, normalizedHost);
    });

    // ====== Download-by-Link ===================================================
    //
    // Paste any t.me message link (or a tg:// URL) and pull just that media
    // into the queue. Supports private channels (/c/<id>/...), forum topics
    // (extra path segment), and bulk newline-separated input.
    router.post('/download/url', async (req, res) => {
        try {
            const { url, urls } = req.body || {};
            const list = Array.isArray(urls) ? urls : url ? parseUrlList(url) : [];
            if (!list.length) return res.status(400).json({ error: 'Provide url or urls' });

            const am = await getAccountManager();
            if (am.count === 0)
                return res.status(409).json({ error: 'No Telegram accounts loaded' });

            const { DownloadManager } = await import('../../core/downloader.js');
            const { RateLimiter } = await import('../../core/security.js');

            const config = loadConfig();
            const standalone = !runtime._downloader;
            const downloader =
                runtime._downloader ||
                new DownloadManager(
                    am.getDefaultClient(),
                    config,
                    new RateLimiter(config.rateLimits),
                );
            if (standalone) {
                await downloader.init();
                downloader.start();
            }

            const results = [];
            for (const raw of list) {
                try {
                    const parsed = parseTelegramUrl(raw);
                    let resolved = null;
                    let workingClient = null;
                    for (const [, c] of am.clients) {
                        try {
                            const entity = await c.getEntity(parsed.chatRef);
                            const messages = await c.getMessages(entity, {
                                ids: [parsed.messageId],
                            });
                            if (messages?.[0]) {
                                resolved = { entity, message: messages[0] };
                                workingClient = c;
                                break;
                            }
                        } catch {
                            /* try next */
                        }
                    }
                    if (!resolved) {
                        results.push({
                            url: raw,
                            ok: false,
                            error: 'No account could read the message',
                        });
                        continue;
                    }

                    const mediaType = detectMediaType(resolved.message);
                    if (!mediaType) {
                        results.push({
                            url: raw,
                            ok: false,
                            error: 'Message has no downloadable media',
                        });
                        continue;
                    }

                    const groupId = String(resolved.entity.id);
                    const groupName =
                        resolved.entity.title ||
                        resolved.entity.username ||
                        resolved.entity.firstName ||
                        groupId;
                    // Pin the resolver's client to this job. We used to mutate
                    // `downloader.client` here, but that race-condition'd any
                    // concurrent download — every in-flight job suddenly tried
                    // to fetch bytes through the URL-resolver's session. Per-
                    // job `client` lets each download stick to the session that
                    // can actually read the message.
                    const accountId = am.getIdForClient(workingClient);
                    const meta = accountId ? am.metadata?.get?.(accountId) : null;
                    const accountName =
                        meta?.name ||
                        meta?.username ||
                        meta?.phone ||
                        (accountId ? `#${accountId}` : null);
                    const ok = await downloader.enqueue(
                        {
                            message: resolved.message,
                            groupId,
                            groupName,
                            mediaType,
                            client: workingClient,
                            accountId: accountId || null,
                            accountName: accountName || null,
                        },
                        1,
                    ); // realtime priority
                    results.push({
                        url: raw,
                        ok,
                        group: groupName,
                        messageId: parsed.messageId,
                        mediaType,
                    });
                } catch (e) {
                    results.push({
                        url: raw,
                        ok: false,
                        error: e instanceof UrlParseError ? e.message : e?.message || 'Failed',
                    });
                }
            }

            if (standalone) {
                // Tear down once jobs drain — fire-and-forget.
                (async () => {
                    while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                    downloader.stop().catch(() => {});
                })().catch((e) =>
                    console.warn('[download/url] standalone drain failed:', e?.message || e),
                );
            }

            res.json({ success: true, results });
        } catch (e) {
            console.error('POST /api/download/url:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
