// PM2 process file for bare-metal Node deploys (Linux servers without
// Docker, Synology NAS, Windows boxes that can't run containers, etc.).
// Pair with `pm2 start ecosystem.config.cjs` — the systemd unit in
// docs/DEPLOY.md is the alternative if you'd rather not run a process
// manager.
//
// Docker users should use docker-compose.yml instead — the autoheal
// sidecar in there covers the same crash-and-hang restart cases this
// config does, plus memory limits and log rotation.
//
// CommonJS rather than ESM: PM2 still loads ecosystem files via require().

module.exports = {
    apps: [
        {
            name: 'telegram-media-downloader',
            // The dashboard + WebSocket bus is the long-running process most
            // operators want under PM2. The CLI menu (`src/index.js`) needs
            // interactive stdin and is useless when daemonised.
            script: 'src/web/server.js',
            cwd: __dirname,
            exec_mode: 'fork',
            instances: 1,
            // Hard-cap restarts so a crash-loop (bad config, missing DB)
            // surfaces as a stopped process instead of pinning the CPU.
            max_restarts: 10,
            restart_delay: 2000,
            min_uptime: '10s',
            // RSS ceiling — PM2 restarts the worker when it exceeds this.
            // 1.5 GB matches the Docker `deploy.resources.limits.memory`
            // default of 2 GB with 25% headroom for the OS / other procs.
            // Override with `pm2 start ... --max-memory-restart=3G` for
            // larger libraries (lots of in-memory embeddings cache).
            max_memory_restart: '1500M',
            // Each worker has its own SQLite handle + Telegram session, so
            // the process gets killed and re-spawned rather than reloaded.
            kill_timeout: 8000,
            // Wait for the server.js boot path to finish before PM2 starts
            // counting health. The dashboard's own /api/auth_check is the
            // readiness signal; PM2's process-level liveness is enough.
            listen_timeout: 30_000,
            // Keep logs alongside the rest of the on-disk state so backups
            // and rotators only need one path. PM2 itself doesn't rotate;
            // pair with `pm2 install pm2-logrotate` if you need rotation.
            out_file: 'data/logs/pm2-out.log',
            error_file: 'data/logs/pm2-err.log',
            merge_logs: true,
            time: true,
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
            },
            env_staging: {
                NODE_ENV: 'staging',
                PORT: 3010,
            },
        },
    ],
};
