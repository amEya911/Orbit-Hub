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

    async fetchLiveSessionEmail(): Promise<string | null> {
        try {
            // Try common providers in VS Code forks
            const providers = ['google', 'antigravity_auth', 'cursor', 'microsoft', 'github'];
            for (const p of providers) {
                try {
                    const session = await vscode.authentication.getSession(p, ['email', 'profile'], { silent: true });
                    if (session?.account?.label) {
                        console.log(`[OrbitHub] Detected live session via ${p}: ${session.account.label}`);
                        return session.account.label;
                    }
                } catch { /* skip this provider */ }
            }
        } catch { /* ignore total failure */ }
        return null;
    }

    async detectActiveAccount(): Promise<ActiveAccountInfo | null> {
        const liveEmail = await this.fetchLiveSessionEmail();
        
        // Potential paths to scan, prioritized by global vs workspace
        const home = os.homedir();
        const appData = (process.platform === 'darwin') 
            ? path.join(home, 'Library', 'Application Support', 'Antigravity')
            : (process.platform === 'win32')
                ? path.join(process.env['APPDATA'] ?? home, 'Anti-Gravity')
                : path.join(home, '.config', 'Antigravity');
        
        const candidatePaths: { path: string, time: number }[] = [];
        const globalPath = path.join(appData, 'User', 'globalStorage', 'state.vscdb');
        if (fs.existsSync(globalPath)) {
            candidatePaths.push({ path: globalPath, time: fs.statSync(globalPath).mtimeMs });
        }

        // Also add any recent workspace storage paths
        try {
            const wsRoot = path.join(appData, 'User', 'workspaceStorage');
            if (fs.existsSync(wsRoot)) {
                const folders = fs.readdirSync(wsRoot);
                for (const f of folders) {
                    const p = path.join(wsRoot, f, 'state.vscdb');
                    if (fs.existsSync(p)) {
                        candidatePaths.push({ path: p, time: fs.statSync(p).mtimeMs });
                    }
                }
            }
        } catch { /* ignore scan failure */ }

        // Sort by most recently modified
        candidatePaths.sort((a, b) => b.time - a.time);

        for (const entry of candidatePaths) {
            try {
                const { email } = await this.readUserStatus(entry.path);
                // If we match live auth or if live auth is missing, found our winner
                if (!liveEmail || email === liveEmail) {
                    return { id: email, label: email, statePath: entry.path };
                }
            } catch { /* skip this DB */ }
        }

        return null;
    }

    async fetchQuota(account: ActiveAccountInfo): Promise<FetchResult> {
        try {
            const { email, userStatusBuf } = await this.readUserStatus(account.statePath);
            
            // If the DB is still for a different user, don't return those models as belonging to 'account'
            if (account.id !== email && email !== 'unknown') {
                return { 
                    account, 
                    models: [], 
                    error: `Database is still synced to ${email}. Refreshing App...` 
                };
            }

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

    // ── Read User Info from SQLite with Deep Discovery ────────────────────────

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
            let bestQuotaBuf: Buffer | null = null;
            let bestEmail: string = 'unknown';

            const scanRes = db.exec("SELECT key, value FROM ItemTable");
            
            const ensureBuffer = (v: any): Buffer | null => {
                if (v instanceof Uint8Array) return Buffer.from(v);
                if (typeof v === 'string') {
                    if (/^[A-Za-z0-9+/=]{40,}$/.test(v)) {
                        try { return Buffer.from(v, 'base64'); } catch {}
                    }
                    return Buffer.from(v, 'utf8');
                }
                return null;
            };

            const findQuotaRecursive = (buf: Buffer, depth: number): Buffer | null => {
                if (depth > 5) return null;
                const f = decode(buf);
                if (f[33]) return buf;

                for (const fields of Object.values(f)) {
                    for (const v of fields) {
                        if (Buffer.isBuffer(v)) {
                            // Try as raw
                            const res = findQuotaRecursive(v, depth + 1);
                            if (res) return res;
                            // Try as base64 string
                            const s = v.toString('utf8');
                            if (/^[A-Za-z0-9+/=]{40,}$/.test(s)) {
                                try {
                                    const b2 = Buffer.from(s, 'base64');
                                    const res2 = findQuotaRecursive(b2, depth + 1);
                                    if (res2) return res2;
                                } catch {}
                            }
                        }
                    }
                }
                return null;
            };

            if (scanRes.length && scanRes[0].values.length) {
                for (const row of scanRes[0].values) {
                    const key = String(row[0]);
                    const valRaw = row[1];
                    const buf = ensureBuffer(valRaw);
                    if (!buf) continue;

                    // 1. Detect Email
                    const valStr = buf.toString('utf8');
                    if (valStr.includes('@') && bestEmail === 'unknown') {
                        const m = valStr.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                        if (m) bestEmail = m[0];
                    }

                    // 2. Detect Quota Buf
                    const quota = findQuotaRecursive(buf, 0);
                    if (quota) {
                        // If multiple found, prefer the bigger one
                        if (!bestQuotaBuf || quota.length > bestQuotaBuf.length) {
                            bestQuotaBuf = quota;
                        }
                    }
                }
            }

            if (!bestQuotaBuf) {
                console.error('[OrbitHub] No quota buffer found in DB scan.');
                throw new Error('Could not find usage data in database.');
            }

            // Final identity extraction from the buffer if still unknown
            if (bestEmail === 'unknown') {
                const us = decode(bestQuotaBuf);
                const candidateFields = [7, 10, 11, 3, 1, 4];
                for (const f of candidateFields) {
                    const val = getBufStr(us, f);
                    if (val && val.includes('@')) {
                        bestEmail = val;
                        break;
                    }
                }
            }

            return { email: bestEmail, userStatusBuf: bestQuotaBuf };
        } finally {
            if (db) db.close();
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

            let pctRemaining: number | null = null;
            let resetAt = now + 7 * 24 * 60 * 60 * 1000;

            const f15buf = getBuf(f, 15);
            if (f15buf) {
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
                        let len = 0, shift = 0, b = 0;
                        do { b = f15buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
                        if (fn === 2 && i + len <= f15buf.length) {
                            const sub = f15buf.slice(i, i + len);
                            const subf = decode(sub);
                            const secs = getNum(subf, 1);
                            if (secs && secs > 0) {
                                resetAt = secs * 1000;
                                if (resetAt < now) {
                                    const dCycle = 7 * 24 * 60 * 60 * 1000;
                                    const nCycle = 9 * 24 * 60 * 60 * 1000;
                                    const tCycle = 10 * 24 * 60 * 60 * 1000;
                                    
                                    let nextReset = resetAt;
                                    while (nextReset < now) nextReset += dCycle;

                                    // If reset is too soon (< 2d) and potentially off, try cycles
                                    if (nextReset < now + 2 * 24 * 60 * 60 * 1000) {
                                        let next9 = resetAt;
                                        while (next9 < now) next9 += nCycle;
                                        if (next9 > nextReset) nextReset = next9;
                                        
                                        let next10 = resetAt;
                                        while (next10 < now) next10 += tCycle;
                                        if (next10 > nextReset) nextReset = next10;
                                    }
                                    resetAt = nextReset;
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

            let total: number;
            if (pctRemaining !== null && pctRemaining > 0) {
                total = Math.round(remaining / pctRemaining);
            } else {
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
                return path.join(process.env['APPDATA'] ?? home, 'Anti-Gravity', 'User', 'globalStorage', 'state.vscdb');
            case 'darwin':
                return path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
            default:
                return path.join(home, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
    }
}