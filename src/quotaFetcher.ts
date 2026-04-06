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

    /**
     * Detect the currently active account by reading antigravityAuthStatus
     * (updates immediately on login) and cross-referencing with userStatus.
     */
    async detectActiveAccount(): Promise<ActiveAccountInfo | null> {
        const statePath = QuotaFetcher.defaultStatePath();
        if (!fs.existsSync(statePath)) { return null; }

        try {
            const SQL = await this.loadSql();
            const dbBuf = fs.readFileSync(statePath);
            const mergedBuf = this.mergeWal(dbBuf, statePath + '-wal');
            const db = new SQL.Database(mergedBuf);
            let authEmail = 'unknown';
            let userEmail = 'unknown';

            try {
                // Step 1: Read authStatus email — updates INSTANTLY on switch.
                // This is the Google OAuth credential email, used to detect
                // when the user switches accounts.
                const authRes = db.exec(
                    "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus' LIMIT 1"
                );
                if (authRes.length && authRes[0].values.length) {
                    const parsed = JSON.parse(String(authRes[0].values[0][0]));
                    if (parsed.email) { authEmail = parsed.email; }
                }

                // Step 2: Read userStatus email — the subscription account that
                // OWNS the quota data. May differ from authEmail (different
                // identity layers). Updates lazily (30–60s after switch).
                const userStatusEmail = this.extractEmailFromUserStatus(db);
                if (userStatusEmail && userStatusEmail !== 'unknown') {
                    userEmail = userStatusEmail;
                }
            } finally {
                db.close();
            }

            // Account identity = userStatus email (quota data belongs to it).
            // Fall back to authStatus email only if userStatus is unavailable.
            const id = userEmail !== 'unknown' ? userEmail
                : authEmail !== 'unknown' ? authEmail
                    : null;
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
     * Fetch quota for the active account. If userStatus hasn't synced yet
     * for this account, returns empty models with a descriptive error.
     */
    async fetchQuota(account: ActiveAccountInfo): Promise<FetchResult> {
        try {
            const SQL = await this.loadSql();
            const dbBuf = fs.readFileSync(account.statePath);
            const mergedBuf = this.mergeWal(dbBuf, account.statePath + '-wal');
            const db = new SQL.Database(mergedBuf);

            try {
                const userStatusBuf = this.extractUserStatusBuf(db);

                if (!userStatusBuf) {
                    return { account, models: [], error: 'userStatus not found in DB' };
                }

                // account.id comes from userStatus email, so the quota data
                // in userStatusBuf always belongs to this account. No email
                // mismatch check needed — they're from the same source.
                const models = this.parseUserStatus(userStatusBuf);
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

    private async loadSql(): Promise<import('sql.js').SqlJsStatic> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const initSqlJs = require('sql.js') as typeof import('sql.js');
        const sqlJsPath = require.resolve('sql.js');
        const wasmPath = path.join(path.dirname(sqlJsPath), 'sql-wasm.wasm');
        const wasmBinary = fs.readFileSync(wasmPath);
        return initSqlJs({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
    }

    /**
     * Extract the email stored inside antigravityUnifiedStateSync.userStatus.
     * This is the account whose quota data is currently in the DB.
     */
    private extractEmailFromUserStatus(db: import('sql.js').Database): string | null {
        try {
            const buf = this.extractUserStatusBuf(db);
            if (!buf) { return null; }
            const us = decode(buf);
            return getBufStr(us, 7) ?? getBufStr(us, 3) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Decode the nested proto structure to get the raw userStatus buffer.
     * Structure: base64 → proto(f1 → proto(f2 → proto(f1=base64str → userStatus)))
     */
    private extractUserStatusBuf(db: import('sql.js').Database): Buffer | null {
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

            // field2.field1 = remaining credits
            const f2buf = getBuf(f, 2);
            const f2 = f2buf ? decode(f2buf) : {};
            const remaining = getNum(f2, 1) ?? 0;

            // field15: contains float (pct remaining) and reset timestamp
            let pctRemaining = 0;
            let resetAt = now + 7 * 24 * 60 * 60 * 1000;

            const f15buf = getBuf(f, 15);
            if (f15buf) {
                // Walk field15 manually to extract float and timestamp
                let i = 0;
                while (i < f15buf.length) {
                    if (i >= f15buf.length) { break; }
                    const tag = f15buf[i++];
                    const fn = tag >> 3;
                    const wt = tag & 7;

                    if (wt === 5 && fn === 1) {
                        // 32-bit float = percentage remaining
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
                                // Roll forward if in the past
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
                        // varint — skip
                        let b = 0;
                        do { if (i >= f15buf.length) { break; } b = f15buf[i++]; } while (b & 0x80);
                    } else if (wt === 1) {
                        i += 8;
                    } else {
                        break;
                    }
                }
            }

            // Derive total from pct: total = remaining / pctRemaining
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

    /**
     * Merge WAL frames into a copy of the database buffer.
     *
     * BUG FIX (Bugs 1 & 3): SQLite reuses the WAL file from the start after
     * each checkpoint, writing a new salt pair into the WAL header. Frames
     * from a previous WAL cycle that still exist beyond the end of the current
     * write position carry the OLD salt. Without salt validation, those stale
     * frames were being replayed on top of freshly-checkpointed pages,
     * reverting the database to an older state and making all live changes
     * invisible until Anti-Gravity was restarted (which triggers a full
     * checkpoint + WAL reset).
     *
     * Fix: read salt1/salt2 from the WAL header and stop as soon as a frame's
     * salt differs — those frames belong to a previous WAL generation.
     */
    private mergeWal(dbBuf: Buffer, walPath: string): Buffer {
        if (!fs.existsSync(walPath)) { return dbBuf; }
        try {
            const walBuf = fs.readFileSync(walPath);
            if (walBuf.length < 32) { return dbBuf; }

            const magic = walBuf.readUInt32BE(0);
            const magicLE = walBuf.readUInt32LE(0);
            let isLittleEndian = true;
            if (magic === 0x377f0682 || magic === 0x377f0683) { isLittleEndian = false; }
            else if (magicLE === 0x377f0682 || magicLE === 0x377f0683) { isLittleEndian = true; }
            else { return dbBuf; }

            const read32 = (off: number): number =>
                isLittleEndian ? walBuf.readUInt32LE(off) : walBuf.readUInt32BE(off);

            const pageSize = read32(8);
            if (pageSize === 0 || (pageSize & (pageSize - 1)) !== 0) { return dbBuf; }

            // Read the WAL-header salt pair.  Every valid frame in the current
            // WAL generation must carry these same salts in its frame header
            // (bytes 8–15 of each 24-byte frame header).
            const walSalt1 = read32(16);
            const walSalt2 = read32(20);

            let dbCopy = Buffer.from(dbBuf);
            let offset = 32; // first frame starts right after the 32-byte WAL header
            const len = walBuf.length;

            while (offset + 24 <= len) {
                const pageNum = read32(offset);
                if (pageNum === 0) { break; }

                // Validate that this frame belongs to the current WAL cycle.
                // Stale frames from a previous cycle have different salts — stop here.
                const frameSalt1 = read32(offset + 8);
                const frameSalt2 = read32(offset + 12);
                if (frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) { break; }

                if (offset + 24 + pageSize > len) { break; }

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