/**
 * gramJS session with a bounded entity cache.
 *
 * gramJS's MemorySession (the base of StringSession) calls
 * `processEntities()` on every API result and every update, and adds a
 * brand-new `[id, hash, username, phone, name]` array for each user/chat
 * to `_entities`, a Set. New arrays never compare equal, so the Set never
 * dedupes and never evicts: every poll, backfill page and getDialogs call
 * grows it (~187 B per row — tens of MB per day per account), and every
 * entity lookup is a linear scan that returns the OLDEST row for an id.
 *
 * This subclass keeps one row per peer id — the newest — so the cache is
 * bounded by the number of distinct peers the account has seen, and
 * lookups see fresh usernames / access hashes.
 */

import { StringSession } from 'telegram/sessions/index.js';

export class DedupStringSession extends StringSession {
    constructor(session) {
        super(session);
        this._rowById = new Map();
    }

    processEntities(tlo) {
        for (const row of this._entitiesToRows(tlo)) {
            const prev = this._rowById.get(row[0]);
            if (prev) this._entities.delete(prev);
            this._rowById.set(row[0], row);
            this._entities.add(row);
        }
    }
}
