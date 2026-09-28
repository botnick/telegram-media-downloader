// Preloaded into the server process by scripts/bench-front.js
// (`node --import ./scripts/bench/burn-hook.mjs src/web/server.js`) to
// simulate a busy Node event loop: on an IPC message {burn: {busyMs,
// everyMs}} it spins the CPU for busyMs out of every everyMs; {burn: null}
// stops. Never loaded by the app itself.

let timer = null;

process.on('message', (m) => {
    if (!m || !('burn' in m)) return;
    clearInterval(timer);
    timer = null;
    if (m.burn) {
        const { busyMs, everyMs } = m.burn;
        timer = setInterval(() => {
            const end = Date.now() + busyMs;
            while (Date.now() < end) {
                /* block the event loop */
            }
        }, everyMs);
    }
    process.send?.({ burnAck: Boolean(m.burn) });
});
