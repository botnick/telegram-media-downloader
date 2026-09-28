/**
 * Resolve a Telegram id across every loaded gramJS client, telling a
 * definite "no account can see this chat" apart from a transient failure.
 *
 * Only a definite miss may be remembered (server.js caches it for a few
 * minutes so avatar renders and name sweeps stop re-asking Telegram). A
 * FLOOD_WAIT, a timeout, a dropped connection or any other error that
 * says nothing about the chat itself must stay retryable, or a short
 * outage would hide real chats for the whole cache window.
 */

// Errors that mean "this account can't resolve that id": gramJS' own
// lookup failures plus the MTProto errors for invalid / inaccessible peers.
const NOT_FOUND_RE =
    /could not find the input entity|cannot find any entity|no user has|CHANNEL_INVALID|CHANNEL_PRIVATE|CHAT_ID_INVALID|PEER_ID_INVALID|USER_ID_INVALID|USERNAME_INVALID|USERNAME_NOT_OCCUPIED/i;

/** True for an error that means the id doesn't resolve on this account. */
export function isEntityNotFoundError(err) {
    const text = `${err?.errorMessage || ''} ${err?.message || err || ''}`;
    return NOT_FOUND_RE.test(text);
}

/**
 * @param {string} idStr
 * @param {Array<{ connected?: boolean, getEntity: Function }>} clients
 * @returns {Promise<{ entity: object|null, client: object|null, definite: boolean }>}
 *   `definite` on a miss: at least one connected client was asked and
 *   every connected client answered "not found" (safe to negative-cache).
 */
export async function lookupEntityAcrossClients(idStr, clients) {
    const attempts = [idStr];
    if (/^-?\d+$/.test(idStr)) attempts.push(BigInt(idStr));
    let asked = 0;
    let transient = false;
    for (const c of clients) {
        if (!c) continue;
        for (const arg of attempts) {
            try {
                const e = await c.getEntity(arg);
                if (e) return { entity: e, client: c, definite: true };
            } catch (err) {
                // A disconnected client's errors say nothing about the chat.
                if (c.connected && !isEntityNotFoundError(err)) transient = true;
            }
        }
        if (c.connected) asked += 1;
    }
    return { entity: null, client: null, definite: asked > 0 && !transient };
}
