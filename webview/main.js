// @ts-nocheck
'use strict';

const vscode = acquireVsCodeApi();
let state = { accounts: [], models: [] };
let collapsedAccounts = new Set();
let initialized = false;

window.addEventListener('DOMContentLoaded', () => {
    vscode.postMessage({ type: 'ready' });
    setInterval(tickCountdowns, 1000);

    // Event Delegation for interactivity.
    //
    // BUG FIX (Bug 2): The refresh button (.refresh-btn) is rendered inside
    // .account-header.  The original handler checked .account-header first,
    // so every click that bubbled up from the button matched the header branch
    // and called toggleAccount() instead of cmd_refresh().
    // e.stopPropagation() inside the button branch never ran because it was
    // reached too late.
    //
    // Fix: check for .refresh-btn BEFORE .account-header so the button click
    // is handled (and propagation stopped) before the header check can match.
    document.addEventListener('click', e => {
        const refreshBtn = e.target.closest('.refresh-btn');
        if (refreshBtn) {
            e.stopPropagation();
            cmd_refresh();
            return;
        }

        const header = e.target.closest('.account-header');
        if (header) {
            const section = header.closest('.account-section');
            const id = section.id.replace('acc-', '');
            toggleAccount(id);
            return;
        }

        const addManualBtn = e.target.closest('.add-manual-link');
        if (addManualBtn) {
            e.preventDefault();
            cmd_addAccount();
            return;
        }

        const resetLink = e.target.closest('.reset-link');
        if (resetLink) {
            e.preventDefault();
            cmd_reset();
            return;
        }
    });
});

window.addEventListener('message', ev => {
    if (ev.data.type === 'state') {
        state = ev.data;
        if (!initialized) {
            state.accounts.forEach(acc => {
                if (!acc.account.isActive) collapsedAccounts.add(acc.account.id);
            });
            initialized = true;
        }
        render();
    }
});

function render() {
    const app = document.getElementById('app');
    if (!app) { return; }
    if (!state.accounts.length) {
        app.innerHTML = buildNoData() + buildGlobalFooter();
    } else {
        app.innerHTML = state.accounts.map(buildAccount).join('') + buildGlobalFooter();
    }
}

function buildGlobalFooter() {
    return `<div class="global-footer">
        <a href="#" class="reset-link">Reset All Data</a>
    </div>`;
}

function buildNoData() {
    return `<div class="empty-state">
      <div class="empty-icon">🛸</div>
      <div class="empty-title">Detecting account…</div>
      <div class="empty-sub">Make sure Anti-Gravity is running and you are logged in.</div>
      <a href="#" class="add-manual-link" style="display: block; margin-top: 12px; color: var(--vscode-textLink-foreground); cursor: pointer;">Add account manually</a>
    </div>`;
}

function buildAccount(entry) {
    const { account, models, fetchedAt } = entry;
    const isCollapsed = collapsedAccounts.has(account.id);
    const fetchedStr = fetchedAt
        ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : null;

    // Only show refresh button for active accounts
    const refreshHtml = account.isActive
        ? `<button class="refresh-btn" title="Refresh">↻</button>`
        : '';

    return `
    <div class="account-section ${isCollapsed ? 'collapsed' : ''}" id="acc-${account.id}">
      <div class="account-header">
        <div class="account-info">
          <span class="chevron">▼</span>
          <span class="account-dot ${account.isActive ? 'active' : 'inactive'}"></span>
          <span class="account-email">${esc(account.label)}</span>
        </div>
        <div class="account-meta">
          ${account.syncError ? `<span class="sync-error" title="${esc(account.syncError)}">⏳ Syncing...</span>` : ''}
          ${fetchedStr ? `<span class="fetched-time">Updated ${fetchedStr}</span>` : ''}
          ${refreshHtml}
        </div>
      </div>
      <div class="account-body">
        <div class="model-quota-label">MODEL QUOTA</div>
        <div class="quota-card">
          ${models.map(m => buildModelRow(m, account.isActive)).join('')}
        </div>
      </div>
    </div>`;
}

function toggleAccount(id) {
    if (collapsedAccounts.has(id)) {
        collapsedAccounts.delete(id);
    } else {
        collapsedAccounts.add(id);
    }
    render();
}

function buildModelRow(m, isAccountActive) {
    if (m.state === 'unknown') {
        return `<div class="model-row">
          <div class="model-row-top">
            <span class="model-name">${esc(m.modelName)}</span>
            <span class="model-reset muted">—</span>
          </div>
          <div class="bar-track">
            ${Array(5).fill('<div class="segment"></div>').join('')}
          </div>
        </div>`;
    }

    const pct = m.pctRemaining ?? 0;
    const segmentsFilled = Math.max(0, Math.min(5, Math.ceil(pct / 20)));

    let statusCls = 'filled';
    if (m.state === 'exhausted') statusCls = 'exhausted';
    else if (m.state === 'low') statusCls = 'low';
    else if (m.state === 'available') statusCls = 'available';

    const isStale = m.isStale ?? false;
    const ageDays = m.dataAgeMs ? Math.floor(m.dataAgeMs / (24 * 60 * 60 * 1000)) : 0;
    const staleMsg = isStale ? (ageDays > 0 ? `Synced ${ageDays}d ago` : 'Synced recently') : '';

    const warnIcon = (m.state === 'low' || isStale) ? `<span class="warn-icon" title="${isStale ? `Data is ${ageDays}d old. Open and refresh Anti-Gravity app to sync.` : ''}">⚠️</span>` : '';
    const fetchedStr = m.fetchedAt ? new Date(m.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

    const resetStr = `<span class="model-reset" 
      data-reset="${m.resetAt}" 
      data-active="${isAccountActive}"
      data-is-stale="${isStale}"
      data-stale-msg="${staleMsg}"
      data-state="${m.state}">${fmtReset(m.resetAt, isAccountActive, m.state, isStale, staleMsg)}</span>`;

    const segmentsHtml = Array.from({ length: 5 }, (_, i) => {
        const cls = i < segmentsFilled ? `filled ${statusCls}` : '';
        return `<div class="segment ${cls}"></div>`;
    }).join('');

    return `<div class="model-row">
      <div class="model-row-top">
        <div class="model-name-wrapper">
          <span class="model-name">${esc(m.modelName)}</span>
          ${warnIcon}
          <span class="fetched-badge">Fetched ${fetchedStr}</span>
        </div>
        ${resetStr}
      </div>
      <div class="bar-track">
        ${segmentsHtml}
      </div>
    </div>`;
}

function tickCountdowns() {
    document.querySelectorAll('[data-reset]').forEach(el => {
        const active = el.dataset.active === 'true';
        const state = el.dataset.state;
        const isStale = el.dataset.isStale === 'true';
        const staleMsg = el.dataset.staleMsg || '';
        el.textContent = fmtReset(parseInt(el.dataset.reset, 10), active, state, isStale, staleMsg);
    });
}

function fmtReset(ms, isActiveAccount = true, state = '', isStale = false, staleMsg = '') {
    if (state === 'available') return '100% Credits Available';

    const prefix = isStale ? ` (${staleMsg})` : '';

    const diff = ms - Date.now();
    if (diff <= 0) {
        return (isActiveAccount ? 'Refreshing…' : 'Available') + prefix;
    }
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);

    if (!isActiveAccount && d === 0 && h === 0 && m === 0) return 'Available' + prefix;

    if (d > 0) { return `Resets in ${d}d ${h}h` + prefix; }
    if (h > 0) { return `Resets in ${h}h ${m}m` + prefix; }
    return `Resets in ${m}m ${pad(s % 60)}s` + prefix;
}

function pad(n) { return String(n).padStart(2, '0'); }
function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cmd_refresh() { vscode.postMessage({ type: 'refresh' }); }

function cmd_addAccount(e) {
    if (e) e.preventDefault();
    vscode.postMessage({ type: 'addAccount' });
}

function cmd_reset() {
    vscode.postMessage({ type: 'reset' });
}