// PM2 process file for bare-metal Node deploys (Linux servers without
// Docker, Synology NAS, etc.). Pair with `pm2 start ecosystem.config.cjs`
// — the systemd unit in docs/DEPLOY.md is the alternative if you'd rather
// not run a process manager.
//
// CommonJS rather than ESM: PM2 still loads ecosystem files via require().

module.exports = {
    apps: [
        {
            name: 'telegram-media-downloader',
            script: 'src/index.js',
            cwd: __dirname,
            exec_mode: 'fork',
            instances: 1,
            // Hard-cap restarts so a crash-loop (bad config, missing DB)
            // surfaces as a stopped process instead of pinning the CPU.
            max_restarts: 10,
            restart_delay: 2000,
            min_uptime: '10s',
            // Each worker has its own SQLite handle + Telegram session, so
            // the process gets killed and re-spawned rather than reloaded.
            kill_timeout: 8000,
            // Keep logs alongside the rest of the on-disk state so backups
            // and rotators only need one path.
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
