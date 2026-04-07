import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AccountManager } from './accountManager';
import { QuotaFetcher, MODELS } from './quotaFetcher';

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
            }
        });
    }

    handleAuthSessionChange(): void {
        this.startSyncRetryWindow();
        void this.refresh();
    }

    async refresh(): Promise<void> {
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
                    await this.accountManager.updateCachedQuota({
                        accountId: active.id,
                        models: result.models,
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

    private sendState(): void {
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
            })
            .sort((a, b) => {
                if (a.isActive !== b.isActive) { return a.isActive ? -1 : 1; }
                const aFetchedAt = allCached[a.id]?.fetchedAt ?? 0;
                const bFetchedAt = allCached[b.id]?.fetchedAt ?? 0;
                return bFetchedAt - aFetchedAt;
            });

        const payload = visibleAccounts.map(acc => {
            const cache = allCached[acc.id] ?? null;

            const models = MODELS.map(m => {
                const cached = cache?.models.find(c => c.modelId === m.id) ?? null;
                if (!cached) {
                    return { modelId: m.id, modelName: m.name, state: 'unknown' as const };
                }

                const now = Date.now();
                let pctRemaining = cached.pctRemaining ?? (
                    cached.total > 0
                        ? Math.round((cached.remaining / cached.total) * 100)
                        : 0
                );

                let isEstimation = false;
                if (!acc.isActive && cached.resetAt > 0 && now > cached.resetAt) {
                    pctRemaining = 100;
                    isEstimation = true;
                }
                const isStale = acc.isActive && (now - cached.fetchedAt > 60 * 60 * 1000); // 1 hour

                const state = (
                    pctRemaining <= 0 ? 'exhausted' :
                        pctRemaining <= 20 ? 'low' :
                            isEstimation ? 'available' :
                                isStale ? 'low' : 'ok'
                ) as 'ok' | 'low' | 'exhausted' | 'available';

                return {
                    modelId: cached.modelId,
                    modelName: cached.modelName,
                    remaining: cached.remaining,
                    total: cached.total,
                    pctRemaining,
                    resetAt: cached.resetAt,
                    fetchedAt: cached.fetchedAt,
                    isActive: acc.isActive,
                    isEstimation,
                    isStale,
                    dataAgeMs: now - cached.fetchedAt,
                    state,
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
                models,
            };
        });

        void this.view.webview.postMessage({ type: 'state', accounts: payload, models: MODELS });
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
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Orbit Hub</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
