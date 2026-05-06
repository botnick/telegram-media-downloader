// Container healthcheck. /api/auth_check is unauthenticated and always
// returns 200 with the auth state, so it doubles as a liveness probe. Exits
// 0 on a good response within 4 seconds, 1 otherwise — Docker's HEALTHCHECK
// uses the exit code.

import http from 'http';

const port = process.env.PORT || 3000;
const req = http.request(
    { host: '127.0.0.1', port, path: '/api/auth_check', method: 'GET', timeout: 4000 },
    (res) => {
        res.resume();
        process.exit(res.statusCode === 200 ? 0 : 1);
    },
);
req.on('error', () => process.exit(1));
req.on('timeout', () => {
    req.destroy();
    process.exit(1);
});
req.end();
