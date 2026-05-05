// Provider interface — JSDoc shape only; no runtime enforcement.
//
// Implementing a new provider:
//   1. `static get name()`         — short id, also used as `provider`
//                                     column in `backup_destinations`
//   2. `static get displayName()`  — human label for the UI picker
//   3. `static get configSchema()` — array of field descriptors so the
//                                     generic Add-destination wizard can
//                                     render a form without hard-coding
//                                     each provider
//   4. async init(cfg, ctx)        — validate the config, open clients,
//                                     throw a clear `install <pkg> ...`
//                                     error when the optional dep is
//                                     missing
//   5. async upload(localPath, remotePath, opts, ctx)
//   6. async delete(remotePath, ctx)
//   7. async stat(remotePath, ctx)
//   8. async *list(prefix, ctx)
//   9. async testConnection(ctx)
//  10. async close()               — release sockets / file handles
//
// Every method receives a `ctx` of shape `{ destinationId, log, signal }`
// where `log` is the server-side log({source,level,msg}) helper and
// `signal` is an AbortSignal that fires when the user clicks Pause /
// Cancel / Remove. Long-running ops MUST honour `signal.aborted` at
// least once per chunk.

/**
 * @typedef {Object} BackupContext
 * @property {number}          destinationId
 * @property {Function}        log    log({source,level,msg})
 * @property {AbortSignal}     signal
 */

/**
 * @typedef {Object} ConfigField
 * @property {string} name             machine-readable key
 * @property {string} label            human label
 * @property {'text'|'password'|'textarea'|'number'|'select'} type
 * @property {boolean} [required]
 * @property {string} [placeholder]
 * @property {string} [help]
 * @property {Array<{value:string,label:string}>} [options]  for type=select
 * @property {boolean} [secret]        treat as credential — never echo back
 */

/**
 * @typedef {Object} UploadResult
 * @property {string} remotePath
 * @property {number} bytes
 * @property {string} [etag]
 * @property {string} [remoteId]
 */

/**
 * @typedef {Object} StatResult
 * @property {number} size
 * @property {number} mtime    epoch ms
 * @property {string} [etag]
 */

export class BackupProvider {
    static get name() { throw new Error('subclass must override static name'); }
    static get displayName() { return this.name; }
    static get configSchema() { return []; }

    /**
     * Validate config and warm up any long-lived clients (HTTP keep-alive,
     * SFTP socket, etc.). Called once per Provider instance.
     *
     * @param {object} _cfg
     * @param {BackupContext} _ctx
     */
    async init(_cfg, _ctx) { throw new Error('not implemented'); }

    /**
     * Stream-upload `localPath` to `remotePath`.
     *
     * @param {string} _localPath
     * @param {string} _remotePath  POSIX-style; manager.js builds this
     * @param {{onProgress?:Function, encryptKey?:Buffer, throttleBps?:number}} _opts
     * @param {BackupContext} _ctx
     * @returns {Promise<UploadResult>}
     */
    async upload(_localPath, _remotePath, _opts, _ctx) { throw new Error('not implemented'); }

    /**
     * Idempotent delete. Succeeds even if the remote object is already
     * gone — the snapshot retention loop double-deletes on retry and
     * mustn't fail the second time.
     *
     * @param {string} _remotePath
     * @param {BackupContext} _ctx
     */
    async delete(_remotePath, _ctx) { throw new Error('not implemented'); }

    /**
     * Stat one remote object. Returns null when absent — distinguishes
     * "doesn't exist" from "auth/network error" (which throws).
     *
     * @param {string} _remotePath
     * @param {BackupContext} _ctx
     * @returns {Promise<StatResult|null>}
     */
    async stat(_remotePath, _ctx) { throw new Error('not implemented'); }

    /**
     * List a prefix as an async iterable of `{name, size, mtime}`. The
     * snapshot retention loop walks this to find old archives to prune.
     *
     * @param {string} _prefix
     * @param {BackupContext} _ctx
     * @returns {AsyncIterable<{name:string,size:number,mtime:number}>}
     */
    // eslint-disable-next-line require-yield
    async *list(_prefix, _ctx) { throw new Error('not implemented'); }

    /**
     * Cheap connection probe. Used by the dashboard's "Test connection"
     * button — should make at most ~1 round-trip. Returns
     * `{ok:true, detail:string}` on success.
     *
     * @param {BackupContext} _ctx
     * @returns {Promise<{ok:boolean, detail:string}>}
     */
    async testConnection(_ctx) { throw new Error('not implemented'); }

    /** Free resources. Idempotent. */
    async close() { /* default: nothing to do */ }
}

/**
 * Helper: throw a stable optional-dep error string so the UI can render
 * a "click here to install" hint without parsing free-form messages.
 */
export function optionalDepError(provider, pkg) {
    const e = new Error(
        `Provider "${provider}" needs the optional dependency "${pkg}". ` +
        `Install it with \`npm install ${pkg}\` and restart the server.`,
    );
    e.code = 'OPTIONAL_DEP_MISSING';
    e.optionalDep = pkg;
    return e;
}
