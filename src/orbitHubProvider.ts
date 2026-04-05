import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AccountManager, ModelCache } from './accountManager';
import { QuotaFetcher, MODELS } from './quotaFetcher';

export class OrbitHubProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;

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
            }
        });
    }

    async refresh(): Promise<void> {
        const active = await this.quotaFetcher.detectActiveAccount();

        if (active) {
            // Only keep the currently active account — remove all others
            const existing = this.accountManager.getAccounts();
            for (const acc of existing) {
                if (acc.id !== active.id) {
                    await this.accountManager.removeAccount(acc.id);
                }
            }

            await this.accountManager.upsertAccount({
                id: active.id,
                label: active.label,
                statePath: active.statePath,
                isActive: true,
            });

            const result = await this.quotaFetcher.fetchQuota(active);

            if (!result.error && result.models.length > 0) {
                const existing = this.accountManager.getCachedQuota(active.id);
                const mergedModels: ModelCache[] = result.models.map(m => ({
                    ...(existing?.models.find(e => e.modelId === m.modelId) ?? {}),
                    ...m,
                }));

                await this.accountManager.updateCachedQuota({
                    accountId: active.id,
                    models: mergedModels,
                    fetchedAt: Date.now(),
                });
            }
        }

        this.sendState();
    }

    private sendState(): void {
        if (!this.view) { return; }

        const accounts = this.accountManager.getAccounts();
        const allCached = this.accountManager.getAllCachedQuotas();

        const payload = accounts.map(acc => {
            const cache = allCached[acc.id] ?? null;

            const models = MODELS.map(m => {
                const cached = cache?.models.find(c => c.modelId === m.id) ?? null;
                if (!cached) {
                    return { modelId: m.id, modelName: m.name, state: 'unknown' as const };
                }

                const pctRemaining = cached.total > 0
                    ? Math.round((cached.remaining / cached.total) * 100)
                    : 0;

                const state = (
                    pctRemaining <= 0 ? 'exhausted' :
                        pctRemaining <= 20 ? 'low' :
                            'ok'
                ) as 'ok' | 'low' | 'exhausted';

                return {
                    modelId: cached.modelId,
                    modelName: cached.modelName,
                    remaining: cached.remaining,
                    total: cached.total,
                    pctRemaining,
                    resetAt: cached.resetAt,
                    fetchedAt: cached.fetchedAt,
                    isActive: acc.isActive,
                    state,
                };
            });

            return {
                account: { id: acc.id, label: acc.label, isActive: acc.isActive },
                fetchedAt: cache?.fetchedAt ?? null,
                models,
            };
        });

        void this.view.webview.postMessage({ type: 'state', accounts: payload, models: MODELS });
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