// @ts-nocheck
'use strict';

const vscode = acquireVsCodeApi();
let state = { accounts: [], models: [] };
let collapsedAccounts = new Set();
let initialized = false;

window.addEventListener('DOMContentLoaded', () => {
    vscode.postMessage({ type: 'ready' });
    setInterval(tickCountdowns, 1000);

    // Tooltip logic
    const tooltip = document.createElement('div');
    tooltip.className = 'quota-tooltip';
    document.body.appendChild(tooltip);

    document.addEventListener('mousemove', e => {
        const track = e.target.closest('.bar-track');
        if (track) {
            const pct = track.dataset.pct;
            tooltip.textContent = `${pct}% remaining`;
            tooltip.classList.add('visible');
            tooltip.style.left = `${e.clientX}px`;
            tooltip.style.top = `${e.clientY}px`;
        } else {
            tooltip.classList.remove('visible');
        }
    });

    // Drag-and-drop reordering
    let dragSource = null;

    document.addEventListener('dragstart', e => {
        const section = e.target.closest('.account-section');
        if (!section) { return; }
        dragSource = section;
        section.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });

    document.addEventListener('dragover', e => {
        e.preventDefault();
        const section = e.target.closest('.account-section');
        if (!section || section === dragSource) { return; }

        const app = section.parentElement;
        const rect = section.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (e.clientY < midY) {
            app.insertBefore(dragSource, section);
        } else {
            app.insertBefore(dragSource, section.nextSibling);
        }
    });

    document.addEventListener('dragend', e => {
        const section = e.target.closest('.account-section');
        if (section) { section.classList.remove('dragging'); }
        dragSource = null;

        // Persist order
        const app = document.getElementById('app');
        const sections = Array.from(app.querySelectorAll('.account-section'));
        const ids = sections.map(s => s.id.replace('acc-', ''));
        vscode.postMessage({ type: 'reorderAccounts', ids });
    });

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

        const removeBtn = e.target.closest('.remove-btn');
        if (removeBtn) {
            e.stopPropagation();
            const section = removeBtn.closest('.account-section');
            const id = section.id.replace('acc-', '');
            cmd_removeAccount(id);
            return;
        }

        const header = e.target.closest('.account-header');
        if (header) {
            const section = header.closest('.account-section');
            const id = section.id.replace('acc-', '');
            toggleAccount(id);
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
        const anyActive = state.accounts.some(a => a.account.isActive);
        const signedOutBanner = !anyActive ? buildSignedOutBanner() : '';
        app.innerHTML = signedOutBanner + state.accounts.map(buildAccount).join('') + buildGlobalFooter();
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
    </div>`;
}

function buildSignedOutBanner() {
    return `<div class="signed-out-banner">
      <span class="signed-out-icon">⚡</span>
      <span class="signed-out-text">No account signed in</span>
      <span class="signed-out-sub">Sign in to Anti-Gravity to see live quota</span>
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
    <div class="account-section ${isCollapsed ? 'collapsed' : ''}" id="acc-${account.id}" draggable="true">
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
          <button class="remove-btn" title="Remove Account">×</button>
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

    const warnIcon = (m.state === 'low' || m.state === 'exhausted' || isStale) ? `<span class="warn-icon" title="${isStale ? `Data is ${ageDays}d old. Open and refresh Anti-Gravity app to sync.` : ''}">⚠️</span>` : '';
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
      <div class="bar-track" data-pct="${segmentsFilled * 20}">
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

function cmd_reset() {
    vscode.postMessage({ type: 'reset' });
}

function cmd_removeAccount(id) {
    vscode.postMessage({ type: 'removeAccount', id });
}