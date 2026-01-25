/**
 * Connection Health Checker
 * Keeps the connection alive and reconnects if dropped
 */

import { colorize } from '../cli/colors.js';

export class ConnectionManager {
    constructor(client, options = {}) {
        this.client = client;
        this.interval = options.interval || 60000; // Check every 60s
        this.running = false;
        this.timer = null;
        this.failures = 0;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.check(); // Initial check
        this.timer = setInterval(() => this.check(), this.interval);
        console.log(colorize('💓 Connection health check started', 'dim'));
    }

    stop() {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
    }

    async check() {
        if (!this.running) return;

        try {
            // 1. Check if connected property is true
            if (!this.client.connected) {
                throw new Error('Client disconnected');
            }

            // 2. Verified active ping (optional, lightweight)
            // getMe is cached by gramjs usually, so it's cheap but confirms session is valid
            // We can also use client.checkAuthorization() -> returns true/false
            const authorized = await this.client.checkAuthorization();
            if (!authorized) {
                throw new Error('Session invalid');
            }

            // Reset failures if successful
            this.failures = 0;

        } catch (error) {
            this.failures++;
            console.log(colorize(`⚠️ Connection lost (Att ${this.failures}): ${error.message}`, 'yellow'));

            try {
                // Force reconnect
                await this.client.disconnect();
                await this.client.connect();
                console.log(colorize('✅ Reconnected successfully', 'green'));
                this.failures = 0;
            } catch (reconnectError) {
                console.log(colorize(`❌ Reconnect failed: ${reconnectError.message}`, 'red'));
                // Will try again next interval
            }
        }
    }
}
