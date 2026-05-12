import express from 'express';
import { listUserStories, listAllStories, storyToJob } from '../../core/stories.js';
import { loadConfig } from '../../config/manager.js';
import { runtime } from '../../core/runtime.js';
import { tgAuthErrorBody } from '../lib/tg-error.js';

export function createStoriesRouter({ getAccountManager }) {
    const router = express.Router();

    router.post('/stories/user', async (req, res) => {
        try {
            const { username } = req.body || {};
            if (!username) return res.status(400).json({ error: 'username required' });
            const am = await getAccountManager();
            if (am.count === 0)
                return res.status(409).json({ error: 'No Telegram accounts loaded' });
            const r = await listUserStories(am.getDefaultClient(), username);
            res.json({ success: true, ...r });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status === 400 ? 502 : status).json(
                body.error ? body : { error: e.message },
            );
        }
    });

    router.post('/stories/all', async (req, res) => {
        try {
            const am = await getAccountManager();
            if (am.count === 0)
                return res.status(409).json({ error: 'No Telegram accounts loaded' });
            const r = await listAllStories(am.getDefaultClient());
            res.json({ success: true, ...r });
        } catch (e) {
            const { status, body } = tgAuthErrorBody(e);
            res.status(status === 400 ? 502 : status).json(
                body.error ? body : { error: e.message },
            );
        }
    });

    router.post('/stories/download', async (req, res) => {
        try {
            const { username, storyIds } = req.body || {};
            if (!username || !Array.isArray(storyIds) || storyIds.length === 0) {
                return res.status(400).json({ error: 'username and storyIds required' });
            }
            const am = await getAccountManager();
            if (am.count === 0)
                return res.status(409).json({ error: 'No Telegram accounts loaded' });
            const client = am.getDefaultClient();
            const entity = await client.getEntity(username);
            const r = await client.invoke(
                new (await import('telegram')).Api.stories.GetPeerStories({ peer: entity }),
            );
            const stories = r?.stories?.stories || [];
            const wanted = new Set(storyIds.map(Number));
            const matched = stories.filter((s) => wanted.has(Number(s.id)));

            const { DownloadManager } = await import('../../core/downloader.js');
            const { RateLimiter } = await import('../../core/security.js');
            const config = loadConfig();
            const standalone = !runtime._downloader;
            const downloader =
                runtime._downloader ||
                new DownloadManager(client, config, new RateLimiter(config.rateLimits));
            if (standalone) {
                await downloader.init();
                downloader.start();
            }

            const storiesAccountId = am.getIdForClient(client);
            const storiesMeta = storiesAccountId ? am.metadata?.get?.(storiesAccountId) : null;
            const storiesAccountName =
                storiesMeta?.name ||
                storiesMeta?.username ||
                storiesMeta?.phone ||
                (storiesAccountId ? `#${storiesAccountId}` : null);
            let queued = 0;
            for (const story of matched) {
                const job = storyToJob({
                    peer: entity,
                    story,
                    peerLabel: entity.username || entity.firstName || username,
                });
                job.client = client;
                job.accountId = storiesAccountId || null;
                job.accountName = storiesAccountName || null;
                if (await downloader.enqueue(job, 1)) queued++;
            }
            if (standalone) {
                (async () => {
                    while (downloader.pendingCount > 0 || downloader.active.size > 0) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                    downloader.stop().catch(() => {});
                })().catch((e) =>
                    console.warn('[stories] standalone drain failed:', e?.message || e),
                );
            }
            res.json({ success: true, queued, requested: storyIds.length });
        } catch (e) {
            console.error('POST /api/stories/download:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}
