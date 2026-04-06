import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface ModelInfo { id: string; name: string; }

const MODEL_NAME_MAP: Record<string, string> = {
    'Gemini 3.1 Pro (High)': 'gemini-3.1-pro-high',
    'Gemini 3.1 Pro (Low)': 'gemini-3.1-pro-low',
    'Gemini 3 Flash': 'gemini-3-flash',
    'Claude Sonnet 4.6 (Thinking)': 'claude-sonnet-4-6',
    'Claude Opus 4.6 (Thinking)': 'claude-opus-4-6',
    'GPT-OSS 120B (Medium)': 'gpt-oss-120b',
};

export const MODELS: ModelInfo[] = [
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro High' },
    { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro Low' },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'gpt-oss-120b', name: 'GPT-OSS 120B (Medium)' },
];

export interface ActiveAccountInfo {
    id: string;         // userStatus email — the quota/subscription owner
    label: string;
    authEmail: string;  // authStatus email — Google OAuth (may differ), changes instantly on switch
    statePath: string;
}

export interface RawModelQuota {
    modelId: string;
    modelName: string;
    remaining: number;
    total: number;
    pctRemaining: number;
    resetAt: number;
    fetchedAt: number;
}

export interface FetchResult {
    account: ActiveAccountInfo;
    models: RawModelQuota[];
    error?: string;
    syncPending?: boolean;
}

interface AuthStatusSnapshot {
    email?: string;
    userStatusProtoBinaryBase64?: string;
}

interface UserStatusCandidate {
    source: 'unifiedStateSync' | 'authStatus';
    email: string | null;
    buf: Buffer;
}

// ── Protobuf decoder ──────────────────────────────────────────────────────────

type ProtoVal = number | Buffer;
type ProtoFields = Record<number, ProtoVal[]>;

function readVarint(b: Buffer, i: number): { val: number; i: number } {
    let val = 0, shift = 0, byte = 0;
    do { byte = b[i++]; val |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return { val, i };
}

function decode(b: Buffer): ProtoFields {
    const fields: ProtoFields = {};
    let i = 0;
    while (i < b.length) {
        try {
            const tr = readVarint(b, i); i = tr.i;
            const fn = tr.val >> 3;
            const wt = tr.val & 7;
            if (wt === 0) {
                const rv = readVarint(b, i); i = rv.i;
                (fields[fn] = fields[fn] ?? []).push(rv.val);
            } else if (wt === 2) {
                const rv = readVarint(b, i); i = rv.i;
                if (i + rv.val > b.length) { break; }
                const slice = Buffer.from(b.slice(i, i + rv.val)); i += rv.val;
                (fields[fn] = fields[fn] ?? []).push(slice);
            } else if (wt === 5) { if (i + 4 > b.length) { break; } i += 4; }
            else if (wt === 1) { if (i + 8 > b.length) { break; } i += 8; }
            else { break; }
        } catch { break; }
    }
    return fields;
}

function getNum(f: ProtoFields, field: number): number | null {
    const v = f[field]?.[0];
    return typeof v === 'number' ? v : null;
}

function getBuf(f: ProtoFields, field: number): Buffer | null {
    const v = f[field]?.[0];
    return Buffer.isBuffer(v) ? v : null;
}

function getBufStr(f: ProtoFields, field: number): string | null {
    const b = getBuf(f, field);
    return b ? b.toString('utf8') : null;
}

// ── QuotaFetcher ──────────────────────────────────────────────────────────────

export class QuotaFetcher {

    // ── Switch-acceleration state ─────────────────────────────────────────────
    //
    // authEmail (from the live session or antigravityAuthStatus) updates the
    // instant the user switches accounts. The quota-owning userStatus blobs on
    // disk can lag behind that switch, so Orbit Hub needs to detect the auth
    // change immediately and keep retrying until one of the stored userStatus
    // snapshots matches the new account.
    //
    // orbitHubProvider resolves its switchPending state only when active.id
    // changes from the old value to a new one.  Without intervention, active.id
    // (= userEmail) never changes during a live session, so the "switching…"
    // overlay is shown forever.
    //
    // The acceleration logic makes active.id flip one poll after the authEmail
    // change is first detected:
    //
    //   Poll where authEmail FIRST changes:
    //     → return id = old userEmail   so orbitHubProvider records it as
    //                                   preTransitionUserId
    //
    //   All subsequent polls while authEmail ≠ userEmail:
    //     → return id = new authEmail   active.id ≠ preTransitionUserId
    //                                   → orbitHubProvider resolves the switch
    //
    private _lastSeenAuthEmail: string | null = null;
    private _pendingNewAuthEmail: string | null = null;

    /**
     * Detect the currently active account by reading antigravityAuthStatus
     * (updates immediately on login) and cross-referencing with userStatus.
     */
    async detectActiveAccount(): Promise<ActiveAccountInfo | null> {
        const statePath = QuotaFetcher.defaultStatePath();
        if (!fs.existsSync(statePath)) { return null; }

        try {
            const SQL = await this.loadSql();
            const mergedBuf = this.readAndMerge(statePath);
            const db = new SQL.Database(mergedBuf);
            let authEmail = 'unknown';
            let userEmail = 'unknown';

            try {
                const liveAuthEmail = await this.detectLiveAuthEmail();
                if (liveAuthEmail) {
                    authEmail = liveAuthEmail;
                }

                const authStatus = this.extractAuthStatus(db);

                // Step 1: Read authStatus email — updates INSTANTLY on switch.
                if (authEmail === 'unknown') {
                    const dbAuthEmail = this.extractEmailCandidate(authStatus?.email);
                    if (dbAuthEmail) { authEmail = dbAuthEmail; }
                }

                // Step 2: Read the freshest userStatus email we have on disk.
                const userStatusEmail = this.resolveUserStatusEmail(
                    this.extractUserStatusCandidates(db, authStatus),
                    authEmail,
                );
                if (userStatusEmail && userStatusEmail !== 'unknown') {
                    userEmail = userStatusEmail;
                }
            } finally {
                db.close();
            }

            // ── Switch-acceleration ───────────────────────────────────────────
            const authJustChanged = this._lastSeenAuthEmail !== null
                && authEmail !== 'unknown'
                && authEmail !== this._lastSeenAuthEmail;

            if (authJustChanged) {
                this._pendingNewAuthEmail = authEmail;
            }
            if (authEmail !== 'unknown') {
                this._lastSeenAuthEmail = authEmail;
            }

            let id: string | null;
            if (
                !authJustChanged                                 // not the first-change poll
                && this._pendingNewAuthEmail !== null
                && authEmail === this._pendingNewAuthEmail       // new authEmail is stable
                && userEmail !== 'unknown'
                && userEmail !== authEmail                       // userStatus still stale
            ) {
                // Return new authEmail so orbitHubProvider sees the id flip.
                id = authEmail;
            } else {
                // Normal path, or the exact poll where authEmail just changed.
                // Return old userEmail so preTransitionUserId gets the old value.
                id = userEmail !== 'unknown' ? userEmail
                    : authEmail !== 'unknown' ? authEmail
                        : null;
                // Clear once userStatus catches up
                if (this._pendingNewAuthEmail !== null
                    && (userEmail === authEmail || authEmail === 'unknown')) {
                    this._pendingNewAuthEmail = null;
                }
            }

            if (!id) { return null; }

            return {
                id,
                label: id,
                authEmail: authEmail !== 'unknown' ? authEmail : id,
                statePath,
            };
        } catch {
            return null;
        }
    }

    /**
     * Fetch quota for the active account. Returns empty models when the stored
     * userStatus snapshots still belong to another account, rather than showing
     * the wrong quota under the newly active email.
     */
    async fetchQuota(account: ActiveAccountInfo): Promise<FetchResult> {
        try {
            const SQL = await this.loadSql();
            const mergedBuf = this.readAndMerge(account.statePath);
            const db = new SQL.Database(mergedBuf);

            try {
                const userStatus = this.extractMatchingUserStatus(db, account.id);
                if (!userStatus) {
                    return {
                        account,
                        models: [],
                        error: 'userStatus syncing for new account',
                        syncPending: true,
                    };
                }

                const models = this.parseUserStatus(userStatus.buf);
                return { account, models };
            } finally {
                db.close();
            }
        } catch (err: unknown) {
            return {
                account,
                models: [],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Read the database + WAL from disk, merge them, and return a buffer that
     * sql.js can open reliably.
     *
     * WAL-mode downgrade — the key fix for stale data (Bugs 1 & 3):
     *
     * While Anti-Gravity is running, all writes land in the WAL file first.
     * The main .vscdb file is only updated when SQLite checkpoints (on
     * Anti-Gravity shutdown), which is why data always looks fresh after
     * a restart.
     *
     * We manually merge WAL pages into a copy of the main file.  However,
     * sql.js loads databases into an in-memory VFS that has no sidecar files.
     * When the database header says write_version=2 (WAL mode), the SQLite
     * engine inside sql.js tries to open the matching -wal file via that VFS.
     * Finding nothing, it silently falls back to treating the database as if
     * there is no WAL — meaning it reads only the unmerged pages from the main
     * file and throws away everything we merged.
     *
     * Fix: after merging, patch header bytes 18–19 from 2 (WAL) to 1 (legacy
     * journal).  sql.js then reads pages directly from the buffer we provide,
     * which already contains the merged WAL data.
     */
    private readAndMerge(statePath: string): Buffer {
        const dbBuf = fs.readFileSync(statePath);
        const raw = this.mergeWal(dbBuf, statePath + '-wal');
        // Always work on a fresh writable copy.
        const buf = Buffer.from(raw);
        // Downgrade WAL mode → legacy so sql.js reads our merged pages.
        if (buf.length >= 20) { buf[18] = 1; buf[19] = 1; }
        return buf;
    }

    private async loadSql(): Promise<import('sql.js').SqlJsStatic> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const initSqlJs = require('sql.js') as typeof import('sql.js');
        const sqlJsPath = require.resolve('sql.js');
        const wasmPath = path.join(path.dirname(sqlJsPath), 'sql-wasm.wasm');
        const wasmBinary = fs.readFileSync(wasmPath);
        return initSqlJs({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
    }

    private async detectLiveAuthEmail(): Promise<string | null> {
        const providers = ['antigravity_auth', 'antigravity', 'google'];

        for (const provider of providers) {
            const sessionEmail = await this.detectAuthEmailFromSessions(provider);
            if (sessionEmail) { return sessionEmail; }
        }

        for (const provider of providers) {
            const accountEmail = await this.detectAuthEmailFromAccounts(provider);
            if (accountEmail) { return accountEmail; }
        }

        return null;
    }

    private async detectAuthEmailFromAccounts(provider: string): Promise<string | null> {
        try {
            const accounts = await vscode.authentication.getAccounts(provider);
            const uniqueEmails = new Set<string>();
            for (const account of accounts) {
                const email = this.extractEmailCandidate(account.label) ?? this.extractEmailCandidate(account.id);
                if (email) { uniqueEmails.add(email); }
            }

            if (uniqueEmails.size === 1) {
                return Array.from(uniqueEmails)[0];
            }
        } catch {
            // Provider may not exist in this Anti-Gravity build.
        }

        return null;
    }

    private async detectAuthEmailFromSessions(provider: string): Promise<string | null> {
        const scopeVariants: ReadonlyArray<ReadonlyArray<string>> = [
            [],
            ['email'],
        ];

        for (const scopes of scopeVariants) {
            try {
                const session = await vscode.authentication.getSession(provider, scopes, { silent: true });
                const email = this.extractEmailFromSession(session);
                if (email) { return email; }
            } catch {
                // Some providers/scopes may not exist in every Anti-Gravity build.
            }
        }

        return null;
    }

    private extractEmailFromSession(session: vscode.AuthenticationSession | undefined): string | null {
        if (!session) { return null; }

        const candidates = [session.account.label, session.account.id];
        for (const scope of session.scopes) {
            candidates.push(scope);
        }

        for (const candidate of candidates) {
            const email = this.extractEmailCandidate(candidate);
            if (email) { return email; }
        }

        return null;
    }

    private extractEmailCandidate(candidate: string | undefined): string | null {
        if (!candidate) { return null; }

        const match = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        if (match) { return match[0].toLowerCase(); }

        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            for (const value of Object.values(parsed)) {
                if (typeof value !== 'string') { continue; }
                const nestedMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
                if (nestedMatch) { return nestedMatch[0].toLowerCase(); }
            }
        } catch {
            // Not JSON; plain string candidates are handled above.
        }

        return null;
    }

    private extractAuthStatus(db: import('sql.js').Database): AuthStatusSnapshot | null {
        try {
            const authRes = db.exec(
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus' LIMIT 1"
            );
            if (!authRes.length || !authRes[0].values.length) { return null; }
            return JSON.parse(String(authRes[0].values[0][0])) as AuthStatusSnapshot;
        } catch {
            return null;
        }
    }

    private extractEmailFromUserStatusBuf(buf: Buffer): string | null {
        try {
            const us = decode(buf);
            return this.extractEmailCandidate(getBufStr(us, 7) ?? getBufStr(us, 3) ?? undefined);
        } catch {
            return null;
        }
    }

    private extractUserStatusCandidates(
        db: import('sql.js').Database,
        authStatus = this.extractAuthStatus(db),
    ): UserStatusCandidate[] {
        const candidates: UserStatusCandidate[] = [];

        const unifiedBuf = this.extractUnifiedUserStatusBuf(db);
        if (unifiedBuf) {
            candidates.push({
                source: 'unifiedStateSync',
                email: this.extractEmailFromUserStatusBuf(unifiedBuf),
                buf: unifiedBuf,
            });
        }

        const authStatusBuf = this.extractAuthStatusUserStatusBuf(authStatus);
        if (authStatusBuf) {
            candidates.push({
                source: 'authStatus',
                email: this.extractEmailFromUserStatusBuf(authStatusBuf)
                    ?? this.extractEmailCandidate(authStatus?.email),
                buf: authStatusBuf,
            });
        }

        return candidates;
    }

    private extractMatchingUserStatus(
        db: import('sql.js').Database,
        accountId: string,
    ): UserStatusCandidate | null {
        const candidates = this.extractUserStatusCandidates(db);
        return candidates.find(candidate => candidate.email === accountId) ?? null;
    }

    private resolveUserStatusEmail(
        candidates: UserStatusCandidate[],
        authEmail: string,
    ): string | null {
        if (authEmail !== 'unknown') {
            const authMatched = candidates.find(candidate => candidate.email === authEmail);
            if (authMatched?.email) { return authMatched.email; }
        }

        const unified = candidates.find(candidate => candidate.source === 'unifiedStateSync' && candidate.email);
        if (unified?.email) { return unified.email; }

        return candidates.find(candidate => candidate.email)?.email ?? null;
    }

    private extractAuthStatusUserStatusBuf(authStatus: AuthStatusSnapshot | null): Buffer | null {
        try {
            const raw = authStatus?.userStatusProtoBinaryBase64;
            if (!raw) { return null; }
            return Buffer.from(raw, 'base64');
        } catch {
            return null;
        }
    }

    /**
     * Decode the nested proto structure to get the raw userStatus buffer.
     * Structure: base64 → proto(f1 → proto(f2 → proto(f1=base64str → userStatus)))
     */
    private extractUnifiedUserStatusBuf(db: import('sql.js').Database): Buffer | null {
        try {
            const r = db.exec(
                "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus' LIMIT 1"
            );
            if (!r.length || !r[0].values.length) { return null; }

            const outer = Buffer.from(String(r[0].values[0][0]), 'base64');
            const top = decode(outer);
            const l1buf = getBuf(top, 1);
            if (!l1buf) { return null; }

            const l1 = decode(l1buf);
            const l2buf = getBuf(l1, 2);
            if (!l2buf) { return null; }

            const l2 = decode(l2buf);
            const b64buf = getBuf(l2, 1);
            if (!b64buf) { return null; }

            return Buffer.from(b64buf.toString('utf8'), 'base64');
        } catch {
            return null;
        }
    }

    // ── Parse userStatus protobuf for model quotas ────────────────────────────

    private parseUserStatus(buf: Buffer): RawModelQuota[] {
        const us = decode(buf);
        const now = Date.now();
        const wrapper = getBuf(us, 33);
        if (!wrapper) { return []; }

        const wf = decode(wrapper);
        const modelBlobs = (wf[1] ?? []).filter((v): v is Buffer => Buffer.isBuffer(v));
        const results: RawModelQuota[] = [];

        for (const blob of modelBlobs) {
            const f = decode(blob);

            const nameBuf = getBuf(f, 1);
            if (!nameBuf) { continue; }
            const displayName = nameBuf.toString('utf8');
            if (!displayName || displayName.includes('/')) { continue; }

            const modelId = MODEL_NAME_MAP[displayName];
            if (!modelId) { continue; }

            const modelInfo = MODELS.find(m => m.id === modelId);
            if (!modelInfo) { continue; }

            const f2buf = getBuf(f, 2);
            const f2 = f2buf ? decode(f2buf) : {};
            const remaining = getNum(f2, 1) ?? 0;

            let pctRemaining = 0;
            let resetAt = now + 7 * 24 * 60 * 60 * 1000;

            const f15buf = getBuf(f, 15);
            if (f15buf) {
                let i = 0;
                while (i < f15buf.length) {
                    if (i >= f15buf.length) { break; }
                    const tag = f15buf[i++];
                    const fn = tag >> 3;
                    const wt = tag & 7;

                    if (wt === 5 && fn === 1) {
                        if (i + 4 <= f15buf.length) {
                            pctRemaining = f15buf.readFloatLE(i);
                            i += 4;
                        }
                    } else if (wt === 2) {
                        let len = 0, shift = 0, b = 0;
                        do { b = f15buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
                        if (fn === 2 && i + len <= f15buf.length) {
                            const sub = f15buf.slice(i, i + len);
                            const subf = decode(sub);
                            const secs = getNum(subf, 1);
                            if (secs && secs > 0) {
                                resetAt = secs * 1000;
                                if (resetAt < now) {
                                    const cycle = modelId === 'gemini-3-flash'
                                        ? 5 * 60 * 60 * 1000
                                        : 7 * 24 * 60 * 60 * 1000;
                                    while (resetAt < now) { resetAt += cycle; }
                                }
                            }
                        }
                        i += len;
                    } else if (wt === 0) {
                        let b = 0;
                        do { if (i >= f15buf.length) { break; } b = f15buf[i++]; } while (b & 0x80);
                    } else if (wt === 1) {
                        i += 8;
                    } else {
                        break;
                    }
                }
            }

            const total = pctRemaining > 0.001
                ? Math.round(remaining / pctRemaining)
                : Math.max(remaining, 1280);

            const finalPct = pctRemaining > 0
                ? Math.round(pctRemaining * 100)
                : 0;

            results.push({
                modelId,
                modelName: modelInfo.name,
                remaining,
                total,
                pctRemaining: finalPct,
                resetAt,
                fetchedAt: now,
            });
        }

        return results;
    }

    private mergeWal(dbBuf: Buffer, walPath: string): Buffer {
        if (!fs.existsSync(walPath)) { return dbBuf; }
        try {
            const walBuf = fs.readFileSync(walPath);
            if (walBuf.length < 32) { return dbBuf; }

            // All integers in the SQLite WAL file are stored big-endian.
            // The magic LSB (0x82 vs 0x83) only signals which byte order was
            // used for checksums; it does not affect field layout.
            const magic = walBuf.readUInt32BE(0);
            if (magic !== 0x377f0682 && magic !== 0x377f0683) { return dbBuf; }

            const pageSize = walBuf.readUInt32BE(8);
            if (pageSize === 0 || (pageSize & (pageSize - 1)) !== 0) { return dbBuf; }

            // Salt pair from the WAL header (offsets 16 and 20).
            // Every valid frame in the current WAL generation copies these into
            // its own frame header.  Frames with different salts belong to a
            // previous WAL cycle and must be ignored.
            const walSalt1 = walBuf.readUInt32BE(16);
            const walSalt2 = walBuf.readUInt32BE(20);

            let dbCopy = Buffer.from(dbBuf);
            let offset = 32;
            const len = walBuf.length;
            let lastCommitDbSize = 0;
            let lastCommitOffset = -1;

            while (offset + 24 <= len) {
                const pageNum = walBuf.readUInt32BE(offset);
                if (pageNum === 0) { break; }
                const dbSizeAfterCommit = walBuf.readUInt32BE(offset + 4);

                const frameSalt1 = walBuf.readUInt32BE(offset + 8);
                const frameSalt2 = walBuf.readUInt32BE(offset + 12);
                if (frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) { break; }

                if (offset + 24 + pageSize > len) { break; }
                if (dbSizeAfterCommit !== 0) {
                    lastCommitDbSize = dbSizeAfterCommit;
                    lastCommitOffset = offset;
                }
                offset += 24 + pageSize;
            }

            if (lastCommitOffset < 0) { return dbBuf; }

            offset = 32;
            while (offset <= lastCommitOffset && offset + 24 <= len) {
                const pageNum = walBuf.readUInt32BE(offset);
                if (pageNum === 0) { break; }

                const frameData = walBuf.subarray(offset + 24, offset + 24 + pageSize);
                const targetOffset = (pageNum - 1) * pageSize;

                if (targetOffset + pageSize > dbCopy.length) {
                    const newBuf = Buffer.alloc(targetOffset + pageSize);
                    dbCopy.copy(newBuf);
                    dbCopy = newBuf;
                }

                frameData.copy(dbCopy, targetOffset);
                offset += 24 + pageSize;
            }

            if (lastCommitDbSize > 0) {
                const requiredBytes = lastCommitDbSize * pageSize;
                if (requiredBytes > dbCopy.length) {
                    const newBuf = Buffer.alloc(requiredBytes);
                    dbCopy.copy(newBuf);
                    dbCopy = newBuf;
                } else if (requiredBytes < dbCopy.length) {
                    dbCopy = dbCopy.subarray(0, requiredBytes);
                }

                if (dbCopy.length >= 32) {
                    dbCopy.writeUInt32BE(lastCommitDbSize, 28);
                }
            }
            return dbCopy;
        } catch {
            return dbBuf;
        }
    }

    static defaultStatePath(): string {
        const home = os.homedir();
        switch (process.platform) {
            case 'win32':
                return path.join(process.env['APPDATA'] ?? home, 'Anti-Gravity', 'User', 'globalStorage', 'state.vscdb');
            case 'darwin':
                return path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
            default:
                return path.join(home, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
    }
}
