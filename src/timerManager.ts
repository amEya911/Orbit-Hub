import * as vscode from 'vscode';

export class TimerManager implements vscode.Disposable {
    private handle: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly intervalMs: number,
        private readonly onTick: () => void
    ) { }

    start(): void {
        this.onTick();
        this.handle = setInterval(this.onTick, this.intervalMs);
    }

    dispose(): void {
        if (this.handle !== null) { clearInterval(this.handle); this.handle = null; }
    }
}