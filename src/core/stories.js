/**
 * Stories — small wrapper over GramJS's Api.stories.* surface.
 *
 * Telegram Stories are a different MTProto subsystem from messages: they
 * have their own ids, expire after 24h (unless saved to the user's archive),
 * and live under stories.GetPeerStories / GetAllStories instead of
 * messages.GetMessages.
 *
 * Methods here return JSON-serialisable shapes the dashboard can render —
 * raw Story objects from gramJS contain BigInt and binary refs we don't
 * want crossing the HTTP boundary.
 */

import { Api } from 'telegram';

function pickMedia(story) {
    // Stories surface media exactly like messages — the union has either a
    // photo or a document attached to story.media.
    const m = story?.media;
    if (!m) return null;
    if (m.photo) return { type: 'photo', sizeBytes: 0 };
    if (m.document) {
        const doc = m.document;
        const mime = doc.mimeType || '';
        let type = 'document';
        if (mime.startsWith('video/')) type = 'video';
        else if (mime.startsWith('audio/')) type = 'audio';
        else if (mime.startsWith('image/')) type = 'photo';
        return { type, sizeBytes: Number(doc.size) || 0, mime };
    }
    return null;
}

function serialiseStory(story, peerUsername) {
    const media = pickMedia(story);
    return {
        id: story.id,
        peerUsername: peerUsername || null,
        date: story.date,
        expireDate: story.expireDate,
        pinned: !!story.pinned,
        public: !!story.public,
        caption: story.caption || '',
        media,
    };
}

/**
 * @param {TelegramClient} client
 * @param {string} usernameOrId  '@durov', 'durov', or numeric id
 */
export async function listUserStories(client, usernameOrId) {
    const ref = String(usernameOrId || '').trim();
    if (!ref) throw new Error('username required');
    const entity = await client.getEntity(ref);
    const result = await client.invoke(new Api.stories.GetPeerStories({ peer: entity }));
    const stories = (result?.stories?.stories || []).map(s => serialiseStory(s, ref.replace(/^@/, '')));
    return {
        peer: { id: String(entity.id), username: entity.username || null, firstName: entity.firstName || null },
        stories,
    };
}

/**
 * Lists active stories from contacts. Calls stories.GetAllStories and groups
 * by peer for the SPA. Pagination via state token (next).
 */
export async function listAllStories(client) {
    const result = await client.invoke(new Api.stories.GetAllStories({}));
    const peerStories = result?.peerStories || [];
    const grouped = peerStories.map(ps => {
        const peer = ps.peer;
        const peerId = String(peer?.userId || peer?.channelId || peer?.chatId || 'unknown');
        return {
            peerId,
            stories: (ps.stories || []).map(s => serialiseStory(s)),
        };
    });
    return { groups: grouped, count: result?.count || grouped.length };
}

/**
 * Returns a Job-shaped object the regular Downloader can ingest — same
 * convention as monitor / history. Uses message-like shape with the story
 * media attached so getInputLocation() works without modification.
 */
export function storyToJob({ peer, story, peerLabel }) {
    // Wrap the story in a synthetic message-like object so the existing
    // downloader's location logic finds the photo / document the same way it
    // would for a real message.
    const fakeMessage = {
        id: story.id,
        media: story.media,
        photo: story.media?.photo,
        document: story.media?.document,
        peerId: peer ? { userId: peer.id } : null,
        chatId: peer ? peer.id : 'stories',
        // Stories include a fileReference; gramJS's downloadMedia handles both
        // shapes transparently.
    };
    return {
        message: fakeMessage,
        groupId: peer ? String(peer.id) : 'stories',
        groupName: peerLabel || (peer && (peer.username || peer.firstName)) || 'Stories',
        mediaType: 'stories',
    };
}
