import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AccountManager } from './accountManager';
import { QuotaFetcher } from './quotaFetcher';
import { OrbitHubProvider } from './orbitHubProvider';
import { TimerManager } from './timerManager';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('orbitHub.dumpState', () => {
            const accounts = context.globalState.get('orbitHub.accounts');
            const cache = context.globalState.get('orbitHub.quotaCache');
            vscode.window.showInformationMessage(JSON.stringify({ accounts, cache }, null, 2), { modal: true });
        }),
        vscode.commands.registerCommand('orbitHub.debug', async () => {
            const sessionsByProvider: any = {};
            const providers = ['google', 'github', 'microsoft', 'cursor', 'antigravity', 'antigravity_auth'];
            for (const p of providers) {
                try {
                    const s = await vscode.authentication.getSession(p, ['email'], { silent: true });
                    if (s) {
                        sessionsByProvider[p] = { id: s.account.id, label: s.account.label };
                    }
                } catch { /* skip */ }
            }
            const accounts = context.globalState.get('orbitHub.accounts');
            vscode.window.showInformationMessage('Orbit Hub Debug: ' + JSON.stringify({ sessionsByProvider, accounts }, null, 2), { modal: true });
        })
    );
    const accountManager = new AccountManager(context);
    const quotaFetcher = new QuotaFetcher();
    const provider = new OrbitHubProvider(context, accountManager, quotaFetcher);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('orbitHub.panel', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('orbitHub.refresh', () => provider.refresh())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('orbitHub.reset', async () => {
            await accountManager.resetAll();
            await provider.refresh();
            vscode.window.showInformationMessage('Orbit Hub: Data Reset');
        })
    );

    context.subscriptions.push(
        vscode.authentication.onDidChangeSessions(e => {
            if (e.provider.id === 'antigravity_auth' || e.provider.id === 'antigravity' || e.provider.id === 'google') {
                provider.handleAuthSessionChange();
            }
        })
    );

    const statePath = QuotaFetcher.defaultStatePath();
    const stateDir = path.dirname(statePath);
    const watchedFiles = new Set([
        path.basename(statePath),
        path.basename(statePath) + '-wal',
        path.basename(statePath) + '-shm',
    ]);
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = (): void => {
        if (refreshTimeout !== null) {
            clearTimeout(refreshTimeout);
        }
        refreshTimeout = setTimeout(() => {
            refreshTimeout = null;
            void provider.refresh();
        }, 300);
    };

    try {
        const watcher = fs.watch(stateDir, (_eventType, filename) => {
            if (!filename) { return; }
            const changed = filename.toString();
            if (watchedFiles.has(changed)) {
                scheduleRefresh();
            }
        });

        context.subscriptions.push({
            dispose: () => {
                if (refreshTimeout !== null) {
                    clearTimeout(refreshTimeout);
                    refreshTimeout = null;
                }
                watcher.close();
            },
        });
    } catch {
        // Polling remains as a fallback if the local state directory cannot be watched.
    }

    // Poll every 25 seconds
    const timer = new TimerManager(25_000, () => { void provider.refresh(); });
    context.subscriptions.push(timer);
    timer.start();
}

export function deactivate(): void { }
