import * as vscode from 'vscode';
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

    // Poll every 25 seconds
    const timer = new TimerManager(25_000, () => { void provider.refresh(); });
    context.subscriptions.push(timer);
    timer.start();
}

export function deactivate(): void { }