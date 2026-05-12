export function tgAuthErrorBody(e) {
    if (e?.code === 'NO_API_CREDS') {
        return {
            status: 503,
            body: {
                error: 'Telegram API credentials not configured. Add telegram.apiId and telegram.apiHash in Settings first.',
                code: 'NO_API_CREDS',
            },
        };
    }
    return { status: 400, body: { error: e?.message || 'Bad request' } };
}
