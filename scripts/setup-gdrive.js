#!/usr/bin/env node
// Walk an operator through the Google Drive OAuth flow on the command
// line and print a refresh token suitable for pasting into the
// backup-destination wizard.
//
// Usage:
//   node scripts/setup-gdrive.js
//
// You'll be prompted for the OAuth client ID + secret (created in the
// Google Cloud Console — see docs/BACKUP.md), then sent to a URL to
// authorise the app, then asked to paste the resulting code back. The
// script exchanges the code for a refresh token and prints it.
//
// No data is sent anywhere except Google's token endpoint. The
// `googleapis` SDK is required: `npm install googleapis`.

import readline from 'readline';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'; // legacy "out-of-band" copy-paste flow

function ask(rl, q) {
    return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

async function main() {
    let google;
    try {
        ({ google } = await import('googleapis'));
    } catch {
        console.error('Missing dependency. Run: npm install googleapis');
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nGoogle Drive OAuth refresh-token helper');
    console.log('Need a client ID + secret? See docs/BACKUP.md → Google Drive setup.\n');

    const clientId = await ask(rl, 'OAuth client ID: ');
    const clientSecret = await ask(rl, 'OAuth client secret: ');

    if (!clientId || !clientSecret) {
        console.error('Both clientId and clientSecret are required.');
        rl.close();
        process.exit(1);
    }

    const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
    const url = oauth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [SCOPE],
    });

    console.log('\n1) Open this URL in your browser:');
    console.log('   ' + url);
    console.log(
        '\n2) Sign in, click "Allow", and copy the authorisation code shown on the next page.',
    );

    const code = await ask(rl, '\nPaste the authorisation code: ');
    rl.close();

    if (!code) {
        console.error('No code provided.');
        process.exit(1);
    }

    let tokens;
    try {
        const r = await oauth.getToken(code);
        tokens = r.tokens;
    } catch (e) {
        console.error('Token exchange failed:', e?.message || e);
        process.exit(1);
    }

    if (!tokens.refresh_token) {
        console.error(
            'Google did not return a refresh_token. This usually means you have already authorised this app — go to https://myaccount.google.com/permissions, revoke the app, then re-run this script.',
        );
        process.exit(1);
    }

    console.log('\nSuccess. Paste these into the dashboard wizard:');
    console.log('  clientId:     ' + clientId);
    console.log('  clientSecret: ' + clientSecret);
    console.log('  refreshToken: ' + tokens.refresh_token);
    console.log('\nKeep the refresh token secret — it grants ongoing access to your Drive.');
}

main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
});
