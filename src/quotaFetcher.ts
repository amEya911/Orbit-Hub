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

// ── QuotaFetcher ──────────────────────────────────────────────────────────────

export class QuotaFetcher {

    async detectActiveAccount(): Promise<ActiveAccountInfo | null> {
        const statePath = QuotaFetcher.defaultStatePath();
        if (!fs.existsSync(statePath)) { return null; }
        try {
            const auth = await this.readAuthStatus(statePath);
            return { id: auth.email, label: auth.email, statePath };
        } catch {
            return null;
        }
    }

    async fetchQuota(account: ActiveAccountInfo): Promise<FetchResult> {
        try {
            const auth = await this.readAuthStatus(account.statePath);
            const models = this.parseUserStatus(auth.userStatusProtoBinaryBase64);
            return { account, models };
        } catch (err: unknown) {
            return {
                account,
                models: [],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    private async readAuthStatus(statePath: string): Promise<{
        email: string;
        userStatusProtoBinaryBase64: string;
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
                "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus' LIMIT 1"
            );
            if (!r.length || !r[0].values.length) {
                throw new Error('antigravityAuthStatus not found');
            }
            const parsed = JSON.parse(String(r[0].values[0][0]));
            if (!parsed.userStatusProtoBinaryBase64) {
                throw new Error('userStatusProtoBinaryBase64 missing');
            }
            return {
                email: parsed.email ?? 'unknown',
                userStatusProtoBinaryBase64: parsed.userStatusProtoBinaryBase64,
            };
        } finally {
            db.close();
        }
    }

    private parseUserStatus(base64: string): RawModelQuota[] {
        const buf = Buffer.from(base64, 'base64');
        const top = decode(buf);
        const now = Date.now();

        // Models live inside field33 → field1 entries
        const wrapper = getBuf(top, 33);
        if (!wrapper) { return []; }

        const wf = decode(wrapper);
        const modelBlobs = (wf[1] ?? []).filter((v): v is Buffer => Buffer.isBuffer(v));

        const results: RawModelQuota[] = [];

        for (const blob of modelBlobs) {
            const f = decode(blob);

            // field1[0] = model name buffer
            const nameBuf = getBuf(f, 1);
            if (!nameBuf) { continue; }
            const displayName = nameBuf.toString('utf8');
            if (!displayName || displayName.includes('/')) { continue; }

            const modelId = MODEL_NAME_MAP[displayName];
            if (!modelId) { continue; }

            const modelInfo = MODELS.find(m => m.id === modelId);
            if (!modelInfo) { continue; }

            // field2 = sub-message; field2.field1 = remaining credits (varint)
            const f2buf = getBuf(f, 2);
            const f2 = f2buf ? decode(f2buf) : {};
            const remaining = getNum(f2, 1) ?? 0;

            // field15 = sub-message; field15.field2.field1 = reset unix seconds
            let resetAt = now + 7 * 24 * 60 * 60 * 1000;
            const f15buf = getBuf(f, 15);
            if (f15buf) {
                const f15 = decode(f15buf);
                const f15f2 = getBuf(f15, 2);
                if (f15f2) {
                    const f15f2f = decode(f15f2);
                    const secs = getNum(f15f2f, 1);
                    if (secs && secs > 0) {
                        resetAt = secs * 1000;

                        // Stored timestamp is the LAST reset for weekly models.
                        // Roll forward by 7-day cycle until in the future.
                        // Flash's stored timestamp is already the NEXT reset — don't roll it.
                        if (resetAt < now && modelId !== 'gemini-3-flash') {
                            const cycleMs = 7 * 24 * 60 * 60 * 1000;
                            while (resetAt < now) {
                                resetAt += cycleMs;
                            }
                        }

                        // For Flash: if the stored next-reset is in the past,
                        // roll forward by 5-hour cycles to the nearest upcoming reset.
                        if (modelId === 'gemini-3-flash' && resetAt < now) {
                            const cycleMs = 5 * 60 * 60 * 1000;
                            while (resetAt < now) {
                                resetAt += cycleMs;
                            }
                        }
                    }
                }
            }

            // Totals — inferred from known Anti-Gravity limits
            const TOTALS: Record<string, number> = {
                'gemini-3.1-pro-high': 1280,
                'gemini-3.1-pro-low': 1280,
                'gemini-3-flash': 1280,
                'claude-sonnet-4-6': 1280,
                'claude-opus-4-6': 1280,
                'gpt-oss-120b': 500,
            };
            const total = Math.max(TOTALS[modelId] ?? 1280, remaining);

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