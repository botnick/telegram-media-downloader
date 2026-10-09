// PM2 process file kept for 2.x bare-metal installs (`pm2 start ecosystem.config.cjs`).
// It runs the native launcher, which fetches the matching tgdl-server
// release on first start. Docker users should use docker-compose.yml.
module.exports = {
    apps: [
        {
            name: 'telegram-media-downloader',
            script: 'launcher.cjs',
            cwd: __dirname,
            exec_mode: 'fork',
            instances: 1,
            max_restarts: 10,
            restart_delay: 2000,
            min_uptime: '10s',
            kill_timeout: 60000,
        },
    ],
};
