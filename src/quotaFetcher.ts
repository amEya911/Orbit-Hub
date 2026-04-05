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
    id: string;
    label: string;
    statePath: string;
}

export interface RawModelQuota {
    modelId: string;
    modelName: string;
    remaining: number;
    total: number;
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

    async detectActiveAccount(): Promise<ActiveAccountInfo | null> {
        const statePath = QuotaFetcher.defaultStatePath();
        if (!fs.existsSync(statePath)) { return null; }
        try {
            const { email } = await this.readUserStatus(statePath);
            return { id: email, label: email, statePath };
        } catch {
            return null;
        }
    }

    async fetchQuota(account: ActiveAccountInfo): Promise<FetchResult> {
        try {
            const { email, userStatusBuf } = await this.readUserStatus(account.statePath);
            const models = this.parseUserStatus(userStatusBuf);
            // Update label in case account changed
            account.label = email;
            account.id = email;
            return { account, models };
        } catch (err: unknown) {
            return {
                account,
                models: [],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // ── Read antigravityUnifiedStateSync.userStatus from SQLite ───────────────

    private async readUserStatus(statePath: string): Promise<{
        email: string;
        userStatusBuf: Buffer;
    }> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const initSqlJs = require('sql.js') as typeof import('sql.js');
        const sqlJsPath = require.resolve('sql.js');
        const wasmPath = path.join(path.dirname(sqlJsPath), 'sql-wasm.wasm');
        const wasmBinary = fs.readFileSync(wasmPath);
        const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer as ArrayBuffer });
        const db = new SQL.Database(fs.readFileSync(statePath));

        try {
            const r = db.exec(
                "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.userStatus' LIMIT 1"
            );
            if (!r.length || !r[0].values.length) {
                throw new Error('antigravityUnifiedStateSync.userStatus not found');
            }

            // Structure: base64 → proto(field1 → proto(field2 → base64string → proto = userStatus))
            const outerBuf = Buffer.from(String(r[0].values[0][0]), 'base64');
            const outer = decode(outerBuf);

            const layer1Buf = getBuf(outer, 1);
            if (!layer1Buf) { throw new Error('userStatus: missing field1'); }

            const layer1 = decode(layer1Buf);
            const layer2Buf = getBuf(layer1, 2);
            if (!layer2Buf) { throw new Error('userStatus: missing field1.field2'); }

            const layer2 = decode(layer2Buf);
            const innerB64 = getBuf(layer2, 1);
            if (!innerB64) { throw new Error('userStatus: missing field1.field2.field1'); }

            // innerB64 is a Buffer containing a base64 string
            const innerStr = innerB64.toString('utf8');
            const userStatusBuf = Buffer.from(innerStr, 'base64');

            // Decode to get email
            const us = decode(userStatusBuf);
            const email = getBufStr(us, 7) ?? getBufStr(us, 3) ?? 'unknown';

            return { email, userStatusBuf };
        } finally {
            db.close();
        }
    }

    // ── Parse userStatus protobuf for model quotas ────────────────────────────

    private parseUserStatus(buf: Buffer): RawModelQuota[] {
        const us = decode(buf);
        const now = Date.now();

        // Models are in field33 → field1 array (same structure as before)
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

            // field2.field1 = remaining credits (varint)
            const f2buf = getBuf(f, 2);
            const f2 = f2buf ? decode(f2buf) : {};
            const remaining = getNum(f2, 1) ?? 0;

            // field15 contains:
            //   field1 (32-bit float) = percentage remaining (0.0 to 1.0)
            //   field2.field1 (varint) = reset unix seconds
            let pctRemaining: number | null = null;
            let resetAt = now + 7 * 24 * 60 * 60 * 1000;

            const f15buf = getBuf(f, 15);
            if (f15buf) {
                // Read float at offset 1 (after tag byte 0x0d = field1, wire type 5)
                // Tag 0x0d = field 1, wire type 5 (32-bit)
                let i = 0;
                while (i < f15buf.length - 4) {
                    const tag = f15buf[i];
                    const fn = tag >> 3;
                    const wt = tag & 7;
                    i++;
                    if (wt === 5 && fn === 1) {
                        pctRemaining = f15buf.readFloatLE(i);
                        i += 4;
                    } else if (wt === 2) {
                        // length-delimited — read length then content
                        let len = 0, shift = 0, b = 0;
                        do { b = f15buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
                        if (fn === 2 && i + len <= f15buf.length) {
                            const sub = f15buf.slice(i, i + len);
                            const subf = decode(sub);
                            const secs = getNum(subf, 1);
                            if (secs && secs > 0) {
                                resetAt = secs * 1000;
                                if (resetAt < now) {
                                    const cycleMs = modelId === 'gemini-3-flash'
                                        ? 5 * 60 * 60 * 1000
                                        : 7 * 24 * 60 * 60 * 1000;
                                    while (resetAt < now) { resetAt += cycleMs; }
                                }
                            }
                        }
                        i += len;
                    } else if (wt === 0) {
                        let b = 0;
                        do { b = f15buf[i++]; } while (b & 0x80);
                    } else break;
                }
            }

            // Derive total from percentage if available
            // pctRemaining = remaining / total  →  total = remaining / pctRemaining
            let total: number;
            if (pctRemaining !== null && pctRemaining > 0) {
                total = Math.round(remaining / pctRemaining);
            } else if (pctRemaining === 0 || (pctRemaining !== null && pctRemaining < 0.001)) {
                // exhausted — remaining is near 0, use a default
                total = Math.max(remaining, 1280);
            } else {
                // no float found — assume exhausted, total unknown
                total = Math.max(remaining, 1280);
            }

            results.push({
                modelId,
                modelName: modelInfo.name,
                remaining,
                total,
                resetAt,
                fetchedAt: now,
            });
        }

        return results;
    }

    static defaultStatePath(): string {
        const home = os.homedir();
        switch (process.platform) {
            case 'win32':
                return path.join(
                    process.env['APPDATA'] ?? home,
                    'Anti-Gravity', 'User', 'globalStorage', 'state.vscdb'
                );
            case 'darwin':
                return path.join(
                    home, 'Library', 'Application Support',
                    'Antigravity', 'User', 'globalStorage', 'state.vscdb'
                );
            default:
                return path.join(
                    home, '.config',
                    'Antigravity', 'User', 'globalStorage', 'state.vscdb'
                );
        }
    }
}