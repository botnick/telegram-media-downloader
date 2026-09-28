import { describe, it, expect } from 'vitest';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { DedupStringSession } from '../src/core/telegram-session.js';

const user = (id, accessHash, username) =>
    new Api.User({ id: bigInt(id), accessHash: bigInt(accessHash), firstName: 'U', username });
const channel = (id, accessHash) =>
    new Api.Channel({
        id: bigInt(id),
        accessHash: bigInt(accessHash),
        title: 'C',
        photo: new Api.ChatPhotoEmpty(),
        date: 0,
    });

// Shape of a typical API result (e.g. messages.Messages / updates) that
// gramJS feeds to session.processEntities().
const result = (hashBump = 0) => ({
    users: [user(1, 100 + hashBump, 'alice'), user(2, 200, 'bob')],
    chats: [channel(10, 1000 + hashBump)],
});

describe('DedupStringSession', () => {
    it('stock StringSession grows on every repeated result (the leak)', () => {
        const s = new StringSession('');
        for (let i = 0; i < 50; i++) s.processEntities(result());
        expect(s._entities.size).toBe(150);
    });

    it('keeps one row per peer no matter how often it is seen', () => {
        const s = new DedupStringSession('');
        for (let i = 0; i < 50; i++) s.processEntities(result());
        expect(s._entities.size).toBe(3);
        expect(s._rowById.size).toBe(3);
    });

    it('resolves lookups to the newest row', () => {
        const s = new DedupStringSession('');
        s.processEntities(result(0));
        s.processEntities({ users: [user(1, 999, 'alice_new')], chats: [channel(10, 5555)] });

        const byUsername = s.getInputEntity('alice_new');
        expect(byUsername).toBeInstanceOf(Api.InputPeerUser);
        expect(byUsername.accessHash.toString()).toBe('999');
        // The old username no longer points at a stale row.
        expect(() => s.getInputEntity('alice')).toThrow();

        // Bare id lookup (how gramJS resolves numeric peer ids).
        const ch = s.getInputEntity(10);
        expect(ch.accessHash.toString()).toBe('5555');
    });

    it('still accepts plain entity arrays and ignores non-entities', () => {
        const s = new DedupStringSession('');
        s.processEntities([user(3, 300, 'carol'), user(3, 301, 'carol')]);
        s.processEntities({ something: 'else' });
        expect(s._entities.size).toBe(1);
        expect(s.getInputEntity('carol').accessHash.toString()).toBe('301');
    });
});
