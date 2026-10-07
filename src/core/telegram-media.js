/**
 * Stable identity for media as Telegram describes it in a message.
 *
 * This deliberately uses the server-side media id instead of a filename.
 * A filename can change between reposts, while a document/photo id remains
 * stable when the same Telegram media is forwarded or queued more than once.
 */

function positiveSize(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function scalarId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    return id || null;
}

function largestPhotoSize(photo) {
    const sizes = Array.isArray(photo?.sizes) ? photo.sizes : [];
    let largest = null;
    for (const item of sizes) {
        const size = positiveSize(item?.size);
        if (size != null && (largest == null || size > largest)) largest = size;
    }
    return largest;
}

/**
 * Return the Telegram media identity carried by a message, or null when the
 * message has no document/photo. The key is suitable for an in-process
 * single-flight map; kind/id/size are also persisted separately in SQLite.
 */
export function getTelegramMediaIdentity(message) {
    const media = message?.media;
    const document =
        message?.document ||
        message?.video ||
        message?.audio ||
        message?.voice ||
        message?.sticker ||
        media?.document ||
        media?.webpage?.document;
    if (document) {
        const id = scalarId(document.id);
        if (id) {
            const size = positiveSize(document.size ?? message?.document?.size);
            return {
                kind: 'document',
                id,
                size,
                key: `document:${id}`,
            };
        }
    }

    const photo = message?.photo || media?.photo || media?.webpage?.photo;
    if (photo) {
        const id = scalarId(photo.id);
        if (id) {
            const size = largestPhotoSize(photo);
            return {
                kind: 'photo',
                id,
                size,
                key: `photo:${id}`,
            };
        }
    }

    return null;
}
