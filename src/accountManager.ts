import * as vscode from 'vscode';

export interface Account {
    id: string;
    label: string;
    statePath: string;
    isActive: boolean;
}

export interface CachedQuota {
    accountId: string;
    models: ModelCache[];
    fetchedAt: number;
}

export interface ModelCache {
    modelId: string;
    modelName: string;
    remaining: number;
    total: number;
    resetAt: number;
    fetchedAt: number;
}

const ACCOUNTS_KEY = 'orbitHub.accounts';
const QUOTA_KEY = 'orbitHub.quotaCache';

export class AccountManager {
    constructor(private readonly context: vscode.ExtensionContext) { }

    getAccounts(): Account[] {
        return this.context.globalState.get<Account[]>(ACCOUNTS_KEY, []);
    }

    async upsertAccount(account: Account): Promise<void> {
        const accounts = this.getAccounts();
        const idx = accounts.findIndex(a => a.id === account.id);
        if (idx >= 0) {
            accounts[idx] = account;
        } else {
            accounts.push(account);
        }
        for (const a of accounts) {
            if (a.id !== account.id) { a.isActive = false; }
        }
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    }

    async removeAccount(id: string): Promise<void> {
        const accounts = this.getAccounts().filter(a => a.id !== id);
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
        // Also remove cached quota for this account
        const all = this.getAllCachedQuotas();
        delete all[id];
        await this.context.globalState.update(QUOTA_KEY, all);
    }

    async markActive(id: string): Promise<void> {
        const accounts = this.getAccounts();
        for (const a of accounts) { a.isActive = a.id === id; }
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
    }

    // ── Quota cache ────────────────────────────────────────────────────────────

    getAllCachedQuotas(): Record<string, CachedQuota> {
        return this.context.globalState.get<Record<string, CachedQuota>>(QUOTA_KEY, {});
    }

    getCachedQuota(accountId: string): CachedQuota | null {
        return this.getAllCachedQuotas()[accountId] ?? null;
    }

    async updateCachedQuota(quota: CachedQuota): Promise<void> {
        const all = this.getAllCachedQuotas();
        all[quota.accountId] = quota;
        await this.context.globalState.update(QUOTA_KEY, all);
    }

    async resetAll(): Promise<void> {
        await this.context.globalState.update(ACCOUNTS_KEY, []);
        await this.context.globalState.update(QUOTA_KEY, {});
    }
}