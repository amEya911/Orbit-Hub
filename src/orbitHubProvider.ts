import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AccountManager } from './accountManager';
import { QuotaFetcher } from './quotaFetcher';

export class OrbitHubProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    /** Short burst retries after an account switch so quota appears without waiting for the 25s poll */
    private syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private syncRetryUntil = 0;
    private readonly syncRetryIntervalMs = 2_000;
    private readonly syncRetryWindowMs = 60_000;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly accountManager: AccountManager,
        private readonly quotaFetcher: QuotaFetcher,
    ) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _ctx: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview')],
        };
        webviewView.webview.html = this.buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg: { type: string }) => {
            if (msg.type === 'ready') {
                this.sendState();
                await this.refresh();
            } else if (msg.type === 'refresh') {
                await this.refresh();
            } else if (msg.type === 'reset') {
                await vscode.commands.executeCommand('orbitHub.reset');
            } else if (msg.type === 'removeAccount') {
                const { id } = msg as { type: 'removeAccount', id: string };
                const accounts = this.accountManager.getAccounts();
                const account = accounts.find(a => a.id === id);
                if (!account) { return; }

                if (account.isActive) {
                    vscode.window.showInformationMessage(`Cannot remove the active account (${account.label}). Please switch accounts first.`);
                    return;
                }

                const choice = await vscode.window.showWarningMessage(
                    `Are you sure you want to remove account "${account.label}"? This will also clear its cached quota data.`,
                    { modal: true },
                    'Remove account'
                );

                if (choice === 'Remove account') {
                    await this.accountManager.removeAccount(id);
                    await this.refresh();
                }
            } else if (msg.type === 'reorderAccounts') {
                const { ids } = msg as { type: 'reorderAccounts', ids: string[] };
                const accounts = this.accountManager.getAccounts();
                const reordered = ids.map(id => accounts.find(a => a.id === id)).filter((a): a is any => !!a);
                
                // Add any accounts that were missing from the reorder list (safety)
                for (const acc of accounts) {
                    if (!ids.includes(acc.id)) { reordered.push(acc); }
                }

                await this.context.globalState.update('orbitHub.accounts', reordered);
                this.sendState(); // Instantly push the new order to the webview
            }
        });
    }

    handleAuthSessionChange(): void {
        this.startSyncRetryWindow();
        void this.refresh();
    }

    async refresh(): Promise<void> {
        const syncCmds = [
            'antigravity.refreshUserStatus',
            'cursor.refreshUserStatus',
            'antigravity.action.refreshUserStatus',
            'cursor.action.refreshUserStatus',
            'antigravity.syncUserStatus',
            'cursor.syncUserStatus'
        ];
        for (const cmd of syncCmds) {
            try {
                await vscode.commands.executeCommand(cmd);
                break;
            } catch (err) {
                // Ignore and try next candidate
            }
        }

        this.sendState();
        try {
            const active = await this.quotaFetcher.detectActiveAccount();
            const accounts = this.accountManager.getAccounts();

            if (active) {
                const existingAccount = accounts.find(acc => acc.id === active.id);
                const hasCachedQuota = this.accountManager.getCachedQuota(active.id) !== null;

                // Fetch quota before promoting a brand-new active account so a
                // transient/stale auth identity does not show up as a blank or
                // incorrect auth-only row.
                const result = await this.quotaFetcher.fetchQuota(active);
                const shouldHoldAuthOnlyAccount = active.source === 'authStatus'
                    && !existingAccount
                    && !hasCachedQuota;

                if (shouldHoldAuthOnlyAccount || (!existingAccount && !hasCachedQuota && result.models.length === 0)) {
                    if (shouldHoldAuthOnlyAccount || result.syncPending) {
                        this.startSyncRetryWindow();
                    }
                    this.sendState();
                    return;
                }

                // ── Normal account update flow ────────────────────────────
                let found = false;
                for (const acc of accounts) {
                    if (acc.id === active.id) {
                        acc.isActive = true;
                        acc.label = active.label;
                        acc.authEmail = active.authEmail;
                        acc.statePath = active.statePath;
                        acc.source = active.source;
                        found = true;
                    } else {
                        acc.isActive = false;
                    }
                }
                if (!found) {
                    accounts.push({
                        id: active.id,
                        label: active.label,
                        authEmail: active.authEmail,
                        statePath: active.statePath,
                        isActive: true,
                        source: active.source,
                    });
                }

                // Persist the updated account list
                await this.context.globalState.update('orbitHub.accounts', accounts);

                // Store sync error if any (for UI display)
                const accIdx = accounts.findIndex(a => a.id === active.id);
                if (accIdx >= 0) {
                    accounts[accIdx].syncError = result.error;
                }
                await this.context.globalState.update('orbitHub.accounts', accounts);

                if (result.models.length > 0) {
                    // Compute weekly percentage from high-water-mark tracking.
                    // The protobuf f15 field is the 5-hour limit only; the weekly
                    // percentage must be derived from remaining / weeklyTotal.
                    const oldCache = this.accountManager.getCachedQuota(active.id);
                    const oldModels = oldCache?.models ?? [];

                    const computedModels = result.models.map(m => {
                        const old = oldModels.find(o => o.modelId === m.modelId);
                        // High-water mark: the maximum `remaining` we have ever observed
                        // for this model.  When the weekly quota resets (every Wednesday),
                        // remaining goes back up, pushing the high-water mark.
                        const prevTotal = old?.weeklyTotal ?? 0;

                        // Use known weekly capacity baselines for Pro/Ultra accounts to avoid cold-start/bad-caching issues.
                        let baselineTotal = 2500;
                        const id = m.modelId.toLowerCase();
                        if (id.includes('gemini-3.5-flash-medium')) baselineTotal = 1229;
                        else if (id.includes('gemini-3.5-flash-high')) baselineTotal = 1364;
                        else if (id.includes('gemini-3.5-flash-low')) baselineTotal = 1430;
                        else if (id.includes('gemini-3.1-pro-low')) baselineTotal = 1248;
                        else if (id.includes('gemini-3.1-pro-high')) baselineTotal = 1224;
                        else if (id.includes('gemini')) baselineTotal = 1250;
                        else if (id.includes('gpt-oss')) baselineTotal = 800;

                        const weeklyTotal = Math.max(baselineTotal, m.remaining);

                        let weeklyPct: number;
                        let weeklyReset = m.weeklyReset;

                        if (m.weeklyPct >= 0) {
                            // Parser provided a real value (future-proof)
                            weeklyPct = m.weeklyPct;
                        } else {
                            if (weeklyTotal > 0) {
                                weeklyPct = Math.round((m.remaining / weeklyTotal) * 100);
                            } else {
                                weeklyPct = 100;
                            }

                            // Compute weekly reset: next Wednesday at 17:00 UTC
                            const now = new Date();
                            const utcDay = now.getUTCDay(); // 0=Sun … 3=Wed
                            let daysUntilWed = (3 - utcDay + 7) % 7;
                            if (daysUntilWed === 0) {
                                // If it's Wednesday, check if we're past 17:00 UTC
                                if (now.getUTCHours() >= 17) { daysUntilWed = 7; }
                            }
                            const nextWed = new Date(now);
                            nextWed.setUTCDate(now.getUTCDate() + daysUntilWed);
                            nextWed.setUTCHours(17, 0, 0, 0);
                            weeklyReset = nextWed.getTime();
                        }

                        return {
                            ...m,
                            weeklyPct,
                            weeklyReset,
                            weeklyTotal,
                        };
                    });

                    await this.accountManager.updateCachedQuota({
                        accountId: active.id,
                        models: computedModels,
                        isPro: result.isPro,
                        fetchedAt: Date.now(),
                    });
                    this.stopSyncRetryWindow();
                } else if (result.syncPending) {
                    this.startSyncRetryWindow();
                } else {
                    this.stopSyncRetryWindow();
                }
            } else {
                // System might be offline or app closed
                for (const acc of accounts) { acc.isActive = false; }
                await this.context.globalState.update('orbitHub.accounts', accounts);
                this.stopSyncRetryWindow();
            }
        } catch (err) {
            console.error('[OrbitHub] Refresh failed:', err);
        }

        this.sendState();
    }

    public sendState(): void {
        if (!this.view) { return; }

        const accounts = this.accountManager.getAccounts();
        const allCached = this.accountManager.getAllCachedQuotas();
        const authAliasIds = new Set(
            accounts
                .filter(acc =>
                    acc.isActive
                    && acc.source === 'unifiedStateSync'
                    && acc.authEmail
                    && acc.authEmail !== acc.id
                )
                .map(acc => acc.authEmail as string)
        );
        const visibleAccounts = accounts
            .filter(acc => {
                const isAuthAliasOnly = authAliasIds.has(acc.id) && acc.source !== 'unifiedStateSync';
                if (isAuthAliasOnly) { return false; }
                return acc.isActive || allCached[acc.id];
            });
            // Automatic sorting removed to respect manually dragged order.

        const payload = visibleAccounts.map(acc => {
            const cache = allCached[acc.id] ?? null;

            // Build model list dynamically from cached data — no hardcoded MODELS array.
            const cachedModels = cache?.models ?? [];
            const models = cachedModels.map(cached => {
                const now = Date.now();

                let weeklyPct = cached.weeklyPct !== undefined ? cached.weeklyPct : ((cached as any).pctRemaining !== undefined ? (cached as any).pctRemaining : 100);
                let fiveHourPct = cached.fiveHourPct !== undefined ? cached.fiveHourPct : (cache?.isPro ? 100 : undefined);
                let isWeeklyEstimation = false;
                let isFiveHourEstimation = false;

                if (!acc.isActive) {
                    if (cached.weeklyReset > 0 && now > cached.weeklyReset) {
                        weeklyPct = 100;
                        isWeeklyEstimation = true;
                    }
                    if (cached.fiveHourReset && cached.fiveHourReset > 0 && now > cached.fiveHourReset) {
                        fiveHourPct = 100;
                        isFiveHourEstimation = true;
                    }
                }

                const isStale = acc.isActive && (now - cached.fetchedAt > 60 * 60 * 1000); // 1 hour

                const weeklyState = (
                    weeklyPct <= 0 ? 'exhausted' :
                        weeklyPct <= 20 ? 'low' :
                            isWeeklyEstimation ? 'available' :
                                isStale ? 'low' : 'ok'
                ) as 'ok' | 'low' | 'exhausted' | 'available';

                let fiveHourState: 'ok' | 'low' | 'exhausted' | 'available' | undefined = undefined;
                if (fiveHourPct !== undefined) {
                    fiveHourState = (
                        fiveHourPct <= 0 ? 'exhausted' :
                            fiveHourPct <= 20 ? 'low' :
                                isFiveHourEstimation ? 'available' :
                                    isStale ? 'low' : 'ok'
                    ) as 'ok' | 'low' | 'exhausted' | 'available';
                }

                return {
                    modelId: cached.modelId,
                    modelName: cached.modelName,
                    remaining: cached.remaining,
                    weeklyPct,
                    weeklyReset: cached.weeklyReset,
                    weeklyState,
                    isWeeklyEstimation,
                    fiveHourPct,
                    fiveHourReset: cached.fiveHourReset,
                    fiveHourState,
                    isFiveHourEstimation,
                    fetchedAt: cached.fetchedAt,
                    isActive: acc.isActive,
                    isStale,
                    dataAgeMs: now - cached.fetchedAt,
                };
            });

            return {
                account: {
                    id: acc.id,
                    label: acc.label,
                    isActive: acc.isActive,
                    syncError: (acc as any).syncError
                },
                fetchedAt: cache?.fetchedAt ?? null,
                isPro: cache?.isPro ?? false,
                models,
            };
        });

        void this.view.webview.postMessage({ type: 'state', accounts: payload });
    }

    private startSyncRetryWindow(): void {
        const nextDeadline = Date.now() + this.syncRetryWindowMs;
        if (nextDeadline > this.syncRetryUntil) {
            this.syncRetryUntil = nextDeadline;
        }
        this.scheduleSyncRetry();
    }

    private stopSyncRetryWindow(): void {
        this.syncRetryUntil = 0;
        if (this.syncRetryTimer !== null) {
            clearTimeout(this.syncRetryTimer);
            this.syncRetryTimer = null;
        }
    }

    private scheduleSyncRetry(): void {
        if (this.syncRetryTimer !== null || Date.now() >= this.syncRetryUntil) {
            return;
        }

        this.syncRetryTimer = setTimeout(() => {
            this.syncRetryTimer = null;
            void this.refresh();
        }, this.syncRetryIntervalMs);
    }

    private buildHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'style.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'main.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}?v=${nonce}">
  <title>Orbit Hub</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}?v=${nonce}"></script>
</body>
</html>`;
    }
}
