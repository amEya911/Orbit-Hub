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
        <a href="#" class="reset-link">Reset all data</a>
    </div>`;
}

function buildNoData() {
    return `<div class="empty-state">
      <div class="empty-icon"><svg class="icon-orbit" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(-40 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(40 12 12)"/></svg></div>
      <div class="empty-title detecting-anim">Detecting account</div>
      <div class="empty-sub">Ensure Anti-Gravity IDE is running and you are signed in.</div>
    </div>`;
}

function buildSignedOutBanner() {
    return `<div class="signed-out-banner">
      <span class="signed-out-icon"><svg class="icon-bolt" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></span>
      <span class="signed-out-text">No account detected</span>
      <span class="signed-out-sub">Sign in to Anti-Gravity IDE to view quota data.</span>
    </div>`;
}

function buildAccount(entry) {
    const { account, models, fetchedAt } = entry;
    const isCollapsed = collapsedAccounts.has(account.id);
    const fetchedStr = fetchedAt ? formatFetchedTime(fetchedAt, account.isActive) : null;

    // Only show refresh button for active accounts
    const refreshHtml = account.isActive
        ? `<button class="refresh-btn" title="Refresh">↻</button>`
        : '';

    return `
    <div class="account-section ${isCollapsed ? 'collapsed' : ''}" id="acc-${esc(account.id)}" draggable="true">
      <div class="account-header">
        <div class="account-info-container">
          <div class="account-info-top">
            <span class="chevron">▼</span>
            <span class="account-dot ${account.isActive ? 'active' : 'inactive'}"></span>
            <span class="account-email">${esc(account.label)}</span>
          </div>
          ${fetchedStr ? `<div class="fetched-time-row">Updated ${fetchedStr}</div>` : ''}
        </div>
        <div class="account-meta">
          ${account.syncError ? `<span class="sync-error" title="${esc(account.syncError)}"><svg class="icon-sync" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Syncing</span>` : ''}
          ${refreshHtml}
          <button class="remove-btn" title="Remove account"><svg class="icon-close" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
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
    else if (segmentsFilled === 2) statusCls = 'medium';
    else if (m.state === 'available') statusCls = 'available';

    const isStale = m.isStale ?? false;
    const ageDays = m.dataAgeMs ? Math.floor(m.dataAgeMs / (24 * 60 * 60 * 1000)) : 0;
    const staleMsg = isStale ? (ageDays > 0 ? `Synced ${ageDays}d ago` : 'Synced recently') : '';

    const warnIcon = (m.state === 'low' || m.state === 'exhausted' || isStale) ? `<span class="warn-icon" title="${isStale ? `Data is ${ageDays}d old. Open Anti-Gravity IDE and refresh to sync.` : ''}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 4l7.53 13H4.47L12 6zm-1 5v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg></span>` : '';
    const fetchedStr = m.fetchedAt ? formatFetchedTime(m.fetchedAt, isAccountActive) : '—';

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
    if (state === 'available') return '100% credits available';

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

function formatFetchedTime(ms, isActive) {
    if (!ms) return null;
    const date = new Date(ms);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (isActive) {
        return timeStr;
    }
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const fetchDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today - fetchDay) / (1000 * 60 * 60 * 24));
    const shortTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (diffDays === 0) {
        return `today ${shortTime}`;
    } else if (diffDays === 1) {
        return `yesterday`;
    } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: 'long' }).toLowerCase();
    } else if (diffDays < 30) {
        const weeks = Math.floor(diffDays / 7);
        return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else if (diffDays < 365) {
        const months = Math.floor(diffDays / 30);
        return `${months} month${months > 1 ? 's' : ''} ago`;
    } else {
        const years = Math.floor(diffDays / 365);
        return `${years} year${years > 1 ? 's' : ''} ago`;
    }
}
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