import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { QuotaFetcher } from './quotaFetcher';
import { OrbitHubProvider } from './orbitHubProvider';
import { TimerManager } from './timerManager';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('orbitHub.debug', async () => {
            const os = require('os');
            const path = require('path');
            const fs = require('fs');

            // 1. Show all candidate paths
            const home = os.homedir();
            const candidates = [
                path.join(home, 'Library', 'Application Support', 'Anti-Gravity', 'User', 'globalStorage', 'state.vscdb'),
                path.join(home, 'Library', 'Application Support', 'AntiGravity', 'User', 'globalStorage', 'state.vscdb'),
                path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
                path.join(home, 'Library', 'Application Support', 'anti-gravity', 'User', 'globalStorage', 'state.vscdb'),
            ];

            const found = candidates.filter(p => fs.existsSync(p));
            if (!found.length) {
                vscode.window.showErrorMessage(`state.vscdb not found. Tried:\n${candidates.join('\n')}`);
                // Also search ~/Library/Application Support for anything with "gravity" in it
                const appSupport = path.join(home, 'Library', 'Application Support');
                const dirs = fs.readdirSync(appSupport).filter((d: string) => d.toLowerCase().includes('gravity') || d.toLowerCase().includes('antigrav'));
                vscode.window.showInformationMessage(`Dirs with "gravity": ${JSON.stringify(dirs)}`);
                return;
            }

            // 2. Found the file — dump all keys
            const initSqlJs = require('sql.js');
            const sqlJsPath = require.resolve('sql.js');
            const wasmPath = path.join(path.dirname(sqlJsPath), 'sql-wasm.wasm');
            const wasmBinary = fs.readFileSync(wasmPath);
            const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer });
            const db = new SQL.Database(fs.readFileSync(found[0]));

            const allKeys = db.exec("SELECT key FROM ItemTable ORDER BY key");
            const keys: string[] = allKeys[0]?.values.map((r: unknown[]) => String(r[0])) ?? [];
            db.close();

            // Filter to relevant ones
            const relevant = keys.filter(k =>
                k.includes('port') || k.includes('csrf') || k.includes('token') ||
                k.includes('auth') || k.includes('user') || k.includes('email') ||
                k.includes('session') || k.includes('account') || k.includes('lsp')
            );

            const msg = `Path: ${found[0]}\n\nRelevant keys:\n${relevant.join('\n')}\n\nAll keys (${keys.length} total):\n${keys.slice(0, 50).join('\n')}`;
            vscode.window.showInformationMessage(msg, { modal: true });

            // Also log to console for full output
            console.log('[OrbitHub Debug]', msg);
            console.log('[OrbitHub Debug] ALL KEYS:', keys);
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