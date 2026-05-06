#!/usr/bin/env node
// Walk an operator through the Dropbox OAuth flow on the command line
// and print a refresh token for the backup-destination wizard.
//
// Usage:
//   node scripts/setup-dropbox.js
//
// You'll be asked for the App key + App secret (created in the Dropbox
// developer console — see docs/BACKUP.md), opened to an authorise URL,
// and prompted to paste the resulting code back. The script exchanges
// the code for a long-lived refresh token (PKCE-less server flow).
//
// Requires the `dropbox` package: `npm install dropbox`.

import readline from 'readline';
import https from 'https';
import { URL } from 'url';

function ask(rl, q) {
    return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

function postForm(url, params) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const u = new URL(url);
        const req = https.request(
            {
                method: 'POST',
                hostname: u.hostname,
                path: u.pathname + u.search,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let parsed;
                    try {
                        parsed = JSON.parse(text);
                    } catch {
                        parsed = { raw: text };
                    }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        const e = new Error(
                            `HTTP ${res.statusCode}: ${parsed.error_description || parsed.raw || text}`,
                        );
                        e.statusCode = res.statusCode;
                        e.body = parsed;
                        reject(e);
                    }
                });
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function main() {
    // We don't strictly need the `dropbox` SDK for the OAuth flow — a
    // single POST to api.dropboxapi.com/oauth2/token does the trick. We
    // still gate the script on the package's presence so the operator
    // is reminded to install it before the first real upload.
    try {
        await import('dropbox');
    } catch {
        console.warn(
            'Note: the `dropbox` package is not installed. Install it before running real backups: npm install dropbox\n',
        );
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nDropbox OAuth refresh-token helper');
    console.log('Need an app key + secret? See docs/BACKUP.md → Dropbox setup.\n');

    const appKey = await ask(rl, 'App key: ');
    const appSecret = await ask(rl, 'App secret: ');

    if (!appKey || !appSecret) {
        console.error('Both appKey and appSecret are required.');
        rl.close();
        process.exit(1);
    }

    // `token_access_type=offline` is the Dropbox flag that returns a
    // long-lived refresh_token alongside the short-lived access token.
    const authUrl =
        'https://www.dropbox.com/oauth2/authorize' +
        '?client_id=' +
        encodeURIComponent(appKey) +
        '&response_type=code' +
        '&token_access_type=offline';

    console.log('\n1) Open this URL in your browser:');
    console.log('   ' + authUrl);
    console.log('\n2) Sign in, click "Allow", and copy the access code shown.');

    const code = await ask(rl, '\nPaste the authorisation code: ');
    rl.close();

    if (!code) {
        console.error('No code provided.');
        process.exit(1);
    }

    let tokenResp;
    try {
        tokenResp = await postForm('https://api.dropboxapi.com/oauth2/token', {
            code,
            grant_type: 'authorization_code',
            client_id: appKey,
            client_secret: appSecret,
        });
    } catch (e) {
        console.error('Token exchange failed:', e.message);
        process.exit(1);
    }

    if (!tokenResp.refresh_token) {
        console.error(
            'Dropbox did not return a refresh_token. Make sure you set token_access_type=offline in the authorise URL — this script does that for you, so the most likely cause is the app was created without "offline" / "long-lived" enabled. Recreate the app or re-check Permissions.',
        );
        process.exit(1);
    }

    console.log('\nSuccess. Paste these into the dashboard wizard:');
    console.log('  appKey:       ' + appKey);
    console.log('  appSecret:    ' + appSecret);
    console.log('  refreshToken: ' + tokenResp.refresh_token);
    console.log('\nKeep the refresh token secret — it grants ongoing access to your Dropbox.');
}

main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
});
