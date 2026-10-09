// 2.x installs started the app with `npm start`, `node runner.js` or PM2.
// 3.x is the native tgdl-server: this hands off to the platform launcher,
// which downloads the matching verified release binary when needed.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const win = process.platform === 'win32';
const launcher = path.join(__dirname, win ? 'watchdog.ps1' : 'runner.sh');
const child = win
    ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...process.argv.slice(2)], { stdio: 'inherit' })
    : spawn('sh', [launcher, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
