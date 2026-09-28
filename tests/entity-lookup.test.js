// Negative caching for Telegram entity lookups (src/web/lib/entity-lookup.js):
// only a definite "no such chat" from every connected account may be
// remembered; FLOOD_WAIT / timeouts / connection errors must stay retryable.

import { describe, it, expect } from 'vitest';
import { isEntityNotFoundError, lookupEntityAcrossClients } from '../src/web/lib/entity-lookup.js';

const rpcError = (errorMessage) => Object.assign(new Error(errorMessage), { errorMessage });
const client = (impl, connected = true) => ({ connected, getEntity: impl });
const throwing = (err) => async () => {
    throw err;
};

describe('isEntityNotFoundError', () => {
    it('recognises gramJS lookup failures and invalid-peer RPC errors', () => {
        expect(
            isEntityNotFoundError(
                new Error('Could not find the input entity for {"channelId":"1"}'),
            ),
        ).toBe(true);
        expect(
            isEntityNotFoundError(new Error('Cannot find any entity corresponding to "-1001"')),
        ).toBe(true);
        expect(isEntityNotFoundError(rpcError('CHANNEL_PRIVATE'))).toBe(true);
        expect(isEntityNotFoundError(rpcError('PEER_ID_INVALID'))).toBe(true);
    });

    it('treats flood waits, timeouts and connection errors as transient', () => {
        expect(isEntityNotFoundError(rpcError('FLOOD_WAIT_30'))).toBe(false);
        expect(isEntityNotFoundError(new Error('TIMEOUT'))).toBe(false);
        expect(isEntityNotFoundError(new Error('Not connected'))).toBe(false);
        expect(isEntityNotFoundError(new Error('read ECONNRESET'))).toBe(false);
    });
});

describe('lookupEntityAcrossClients', () => {
    it('returns the first client that resolves the id', async () => {
        const entity = { id: 1, title: 'Chat' };
        const a = client(throwing(rpcError('CHANNEL_PRIVATE')));
        const b = client(async () => entity);
        const r = await lookupEntityAcrossClients('-1001', [a, b]);
        expect(r.entity).toBe(entity);
        expect(r.client).toBe(b);
    });

    it('is definite when every connected client says not found', async () => {
        const nf = throwing(new Error('Could not find the input entity for {}'));
        const r = await lookupEntityAcrossClients('-1001', [client(nf), client(async () => null)]);
        expect(r).toMatchObject({ entity: null, definite: true });
    });

    it('is NOT definite when any connected client hit a transient error', async () => {
        const r = await lookupEntityAcrossClients('-1001', [
            client(throwing(new Error('Could not find the input entity for {}'))),
            client(throwing(rpcError('FLOOD_WAIT_120'))),
        ]);
        expect(r).toMatchObject({ entity: null, definite: false });
    });

    it('is NOT definite when no client is connected (accounts still connecting)', async () => {
        const r = await lookupEntityAcrossClients('-1001', [
            client(throwing(new Error('Not connected')), false),
        ]);
        expect(r).toMatchObject({ entity: null, definite: false });
    });

    it('ignores errors from disconnected clients when a connected one answered', async () => {
        const r = await lookupEntityAcrossClients('-1001', [
            client(throwing(new Error('Not connected')), false),
            client(throwing(rpcError('CHANNEL_INVALID'))),
        ]);
        expect(r).toMatchObject({ entity: null, definite: true });
    });

    it('tries the numeric (BigInt) form only for numeric ids', async () => {
        const seen = [];
        const c = client(async (arg) => {
            seen.push(typeof arg);
            return null;
        });
        await lookupEntityAcrossClients('-1001', [c]);
        await lookupEntityAcrossClients('someuser', [c]);
        expect(seen).toEqual(['string', 'bigint', 'string']);
    });
});
