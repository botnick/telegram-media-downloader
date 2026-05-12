import net from 'net';

const PORT_RANGE_MIN_DEFAULT = 41000;
const PORT_RANGE_MAX_DEFAULT = 49999;
const PORT_BIND_MAX_ATTEMPTS_DEFAULT = 10;

function _randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Bind + immediately close on a random localhost port to test availability.
 * Returns true if the port is free, false if something is already listening.
 */
export function isPortFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve(true));
        });
    });
}

/**
 * Pick a random available localhost port within `portRange`. Retries up to
 * `probeAttempts` times before throwing.
 *
 * @param {object} [opts]
 * @param {[number, number]} [opts.portRange]
 * @param {number} [opts.probeAttempts]
 */
export async function pickAvailablePort({
    portRange = [PORT_RANGE_MIN_DEFAULT, PORT_RANGE_MAX_DEFAULT],
    probeAttempts = PORT_BIND_MAX_ATTEMPTS_DEFAULT,
} = {}) {
    const lo = Math.max(1, Math.min(portRange[0], portRange[1]) | 0);
    const hi = Math.min(65535, Math.max(portRange[0], portRange[1]) | 0);
    const attempts = Math.max(1, probeAttempts | 0);
    for (let attempt = 0; attempt < attempts; attempt++) {
        const port = _randInt(lo, hi);
        if (await isPortFree(port)) return port;
    }
    throw new Error(
        `could not find a free localhost port in ${lo}-${hi} after ${attempts} attempts`,
    );
}
