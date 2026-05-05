// Public surface of the backup subsystem. The server imports from this
// module exclusively — internal modules (manager.js, queue.js, etc.)
// stay private.

export {
    init,
    on,
    listProviders,
    listDestinations,
    addDestination,
    updateDestination,
    removeDestination,
    getDestinationStatus,
    runBackup,
    pause,
    resume,
    testConnection,
    setEncryption,
    unlockEncryption,
    retryJob,
} from './manager.js';

export {
    listJobs,
    listRecent,
    getJob,
} from './queue.js';
