/**
 * Single source of truth for the on-disk data root.
 *
 * Resolution order:
 *   1. TGDL_DATA_DIR env var (operator override; the test suite uses
 *      this to point at an isolated tmpdir)
 *   2. <repo root>/data — walks up from this file's location until it
 *      finds a directory containing pnpm-workspace.yaml or .git/,
 *      then appends 'data'. Resilient to monorepo restructures
 *      because it doesn't assume a fixed depth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(): string {
    let cur = __dirname;
    for (let i = 0; i < 10; i++) {
        if (
            fs.existsSync(path.join(cur, "pnpm-workspace.yaml")) ||
            fs.existsSync(path.join(cur, ".git"))
        ) {
            return cur;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    // Fall back to cwd if walking up fails (e.g., bundled into a
    // single-file install).
    return process.cwd();
}

export const REPO_ROOT: string = findRepoRoot();

export const DATA_DIR: string = process.env["TGDL_DATA_DIR"]
    ? path.resolve(process.env["TGDL_DATA_DIR"])
    : path.join(REPO_ROOT, "data");
