import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

export function getDataDir() {
    return process.env.TGDL_DATA_DIR
        ? path.resolve(process.env.TGDL_DATA_DIR)
        : path.join(REPO_ROOT, 'data');
}

export function getDownloadsDir() {
    if (process.env.TGDL_DOWNLOADS_DIR) return path.resolve(process.env.TGDL_DOWNLOADS_DIR);
    return path.join(getDataDir(), 'downloads');
}

export function getRepoRoot() {
    return REPO_ROOT;
}

// Resolve config.download.path to an absolute directory.
// Treats the factory default './data/downloads' the same as unset — both
// fall through to getDownloadsDir() so TGDL_DOWNLOADS_DIR is honoured.
// A custom path set explicitly by the operator is returned as-is.
const _DEFAULT_DL_PATH = './data/downloads';
export function resolveConfigDownloadPath(configPath) {
    if (!configPath || configPath === _DEFAULT_DL_PATH) return getDownloadsDir();
    return configPath;
}
