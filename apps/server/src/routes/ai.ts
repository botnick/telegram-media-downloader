/**
 * AI endpoints — face clustering, perceptual dedup, semantic search,
 * tag scan. Each one delegates straight into @tgdl/core/ai.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */

// @ts-expect-error — js source
import * as ai from "@tgdl/core/ai/index.js";
import { Hono } from "hono";

const okOr500 = async <T>(
    c: Awaited<ReturnType<typeof Hono.prototype.get>>,
    fn: () => T | Promise<T>
) => {
    try {
        const r = await fn();
        return r;
    } catch (err) {
        throw err;
    }
};

void okOr500; // keep helper if needed later

export const aiRoutes = new Hono()
    .get("/ai/status", async (c) => {
        try {
            const r = ai.getStatus ? await ai.getStatus() : { enabled: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/index/scan", async (c) => {
        try {
            const r = ai.startIndexScan ? await ai.startIndexScan() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/index/scan/status", async (c) => {
        try {
            const r = ai.getIndexScanStatus ? await ai.getIndexScanStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/index/cancel", async (c) => {
        try {
            if (ai.cancelIndexScan) await ai.cancelIndexScan();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/models/status", async (c) => {
        try {
            const r = ai.getModelsStatus ? await ai.getModelsStatus() : {};
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/ai/models/cache", async (c) => {
        try {
            if (ai.purgeModelsCache) await ai.purgeModelsCache();
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/hf/test", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { token?: string };
        try {
            const r = ai.testHfToken ? await ai.testHfToken(body.token ?? "") : { ok: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/people", async (c) => {
        try {
            const r = ai.listPeople ? await ai.listPeople() : { people: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/people/:id/photos", async (c) => {
        const id = c.req.param("id");
        try {
            const r = ai.getPersonPhotos ? await ai.getPersonPhotos(id) : { photos: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .delete("/ai/people/:id", async (c) => {
        const id = c.req.param("id");
        try {
            if (ai.deletePerson) await ai.deletePerson(id);
            return c.json({ ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/people/scan", async (c) => {
        try {
            const r = ai.startPeopleScan ? await ai.startPeopleScan() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/people/scan/status", async (c) => {
        try {
            const r = ai.getPeopleScanStatus ? await ai.getPeopleScanStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/tags", async (c) => {
        try {
            const r = ai.listTags ? await ai.listTags() : { tags: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/tags/:tag/photos", async (c) => {
        const tag = c.req.param("tag");
        try {
            const r = ai.getTagPhotos ? await ai.getTagPhotos(tag) : { photos: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/tags/scan", async (c) => {
        try {
            const r = ai.startTagsScan ? await ai.startTagsScan() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/tags/scan/status", async (c) => {
        try {
            const r = ai.getTagsScanStatus ? await ai.getTagsScanStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/perceptual-dedup/groups", async (c) => {
        try {
            const r = ai.getPDedupGroups ? await ai.getPDedupGroups() : { groups: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/perceptual-dedup/scan", async (c) => {
        try {
            const r = ai.startPDedupScan ? await ai.startPDedupScan() : null;
            return c.json(r ?? { ok: true });
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .get("/ai/perceptual-dedup/scan/status", async (c) => {
        try {
            const r = ai.getPDedupScanStatus ? await ai.getPDedupScanStatus() : { running: false };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/search", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { query?: string; limit?: number };
        try {
            const r = ai.search ? await ai.search(body) : { results: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    })
    .post("/ai/search/similar", async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as { id?: number; limit?: number };
        try {
            const r = ai.searchSimilar ? await ai.searchSimilar(body) : { results: [] };
            return c.json(r);
        } catch (err) {
            return c.json({ error: (err as Error).message }, 500);
        }
    });
