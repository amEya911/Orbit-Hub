// @ts-nocheck
'use strict';

const vscode = acquireVsCodeApi();
let state = { accounts: [] };
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
        const bar = e.target.closest('.limit-bar-track');
        if (bar) {
            const pct = bar.dataset.pct;
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

    // Event Delegation
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

// ── Rendering ─────────────────────────────────────────────────────────────────

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
    const { account, models, fetchedAt, isPro } = entry;
    const isCollapsed = collapsedAccounts.has(account.id);
    const fetchedStr = fetchedAt ? formatFetchedTime(fetchedAt, account.isActive) : null;
    const groups = groupModels(models, isPro);

    const refreshHtml = account.isActive
        ? `<button class="refresh-btn" title="Refresh">↻</button>`
        : '';

    let bodyContent;
    if (models.length === 0) {
        bodyContent = '<div class="waiting-message">Waiting for quota data…</div>';
    } else if (groups.length === 0) {
        bodyContent = '<div class="waiting-message">No model quota data available.</div>';
    } else {
        bodyContent = `
        <div class="model-quota-label">Model Quota</div>
        <div class="model-quota-description">Within each group, models share a weekly limit${groups.some(g => g.fiveHourLimit) ? ' and a 5-hour limit' : ''}. Quota is consumed proportionally to the cost of the tokens.</div>
        ${groups.map(g => buildGroupCard(g, account.isActive, isPro)).join('')}`;
    }

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
        ${bodyContent}
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

// ── Model grouping ────────────────────────────────────────────────────────────

function groupModels(models, isPro) {
    if (!models || models.length === 0) { return []; }

    const buckets = {};

    for (const m of models) {
        const name = m.modelName.toLowerCase();
        let key, groupName;

        if (name.includes('gemini')) {
            key = 'gemini';
            groupName = 'Gemini Models';
        } else {
            key = 'gpt';
            groupName = 'Claude and GPT models';
        }

        if (!buckets[key]) {
            buckets[key] = { name: groupName, entries: [] };
        }
        buckets[key].entries.push(m);
    }

    const result = [];
    const orderedKeys = ['gemini', 'gpt'].filter(k => buckets[k]);

    for (const key of orderedKeys) {
        const group = buckets[key];
        const entries = group.entries;
        if (entries.length === 0) { continue; }

        let weeklyLimit = null;
        let fiveHourLimit = null;

        if (isPro) {
            // PRO Account:
            // 1. Five Hour Limit comes directly from the protobuf percentage and reset.
            fiveHourLimit = {
                pctRemaining: entries[0].pctRemaining,
                resetAt: entries[0].resetAt,
                state: entries[0].state,
            };

            // 2. Weekly Limit is calculated from the remaining credits.
            const limitTotal = key === 'gemini' ? 1280 : 2560;
            const maxRemaining = Math.max(...entries.map(e => e.remaining ?? 0));
            const calculatedPct = Math.min(100, Math.round((maxRemaining / limitTotal) * 100));

            // Weekly reset time: calculate next Wednesday 17:00 UTC
            const weeklyResetAt = getWeeklyResetTime();

            weeklyLimit = {
                pctRemaining: calculatedPct,
                resetAt: weeklyResetAt,
                state: calculatedPct >= 100 ? 'available' : 'used',
            };
        } else {
            // NORMAL Account (non-Pro):
            // 1. Weekly Limit comes directly from the protobuf percentage and reset.
            weeklyLimit = {
                pctRemaining: entries[0].pctRemaining,
                resetAt: entries[0].resetAt,
                state: entries[0].state,
            };
            // 2. No Five Hour Limit.
            fiveHourLimit = null;
        }

        result.push({
            name: group.name,
            weeklyLimit,
            fiveHourLimit,
        });
    }

    return result;
}

// ── Group card rendering ──────────────────────────────────────────────────────

function buildGroupCard(group, isAccountActive, isPro) {
    const parts = [];

    if (group.weeklyLimit) {
        parts.push(buildLimitRow('Weekly Limit', group.weeklyLimit, isAccountActive, 'weekly', isPro));
    }

    if (group.fiveHourLimit) {
        parts.push(buildLimitRow('Five Hour Limit', group.fiveHourLimit, isAccountActive, '5hour', isPro));
    }

    return `<div class="group-card">
      <div class="group-header">
        <span class="group-name">${esc(group.name)}</span>
        <span class="info-icon" title="Within this group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally.">i</span>
      </div>
      ${parts.join('')}
    </div>`;
}

function buildLimitRow(label, limitData, isAccountActive, limitType, isPro) {
    const pct = limitData.pctRemaining ?? 0;
    const colorCls = getColorClass(pct);
    const descriptionText = buildLimitDescription(pct, limitData.resetAt, isAccountActive, limitData.state, limitType, isPro);

    return `<div class="limit-row">
      <div class="limit-left">
        <span class="limit-label">${esc(label)}</span>
        <div class="limit-description"
             data-reset="${limitData.resetAt}"
             data-active="${isAccountActive}"
             data-state="${limitData.state || ''}"
             data-limit-type="${limitType}"
             data-pct="${pct}"
             data-is-pro="${isPro}">${descriptionText}</div>
      </div>
      <div class="limit-right">
        <span class="limit-pct ${colorCls}">${pct}%</span>
        <div class="limit-bar-track" data-pct="${pct}">
          <div class="limit-bar-fill ${colorCls}" style="width: ${Math.max(0, Math.min(100, pct))}%"></div>
        </div>
      </div>
    </div>`;
}

function getColorClass(pct) {
    if (pct <= 0) return 'exhausted';
    if (pct <= 20) return 'low';
    if (pct <= 50) return 'medium';
    return 'ok';
}

function buildLimitDescription(pct, resetAt, isAccountActive, state, limitType, isPro) {
    const limitName = limitType === '5hour' ? '5-hour limit' : 'weekly limit';

    if (state === 'available' || pct >= 100) {
        return `Your ${limitName} is fully available.`;
    }

    if (pct <= 0) {
        const resetStr = fmtResetDuration(resetAt, limitType, isPro);
        return `Your ${limitName} is exhausted. It will refresh ${resetStr}.`;
    }

    const resetStr = fmtResetDuration(resetAt, limitType, isPro);
    return `You have used some of your ${limitName}, it will fully refresh ${resetStr}.`;
}

// ── Countdown / reset formatting ──────────────────────────────────────────────

function tickCountdowns() {
    document.querySelectorAll('.limit-description[data-reset]').forEach(el => {
        const resetAt = parseInt(el.dataset.reset, 10);
        const active = el.dataset.active === 'true';
        const state = el.dataset.state || '';
        const limitType = el.dataset.limitType || 'weekly';
        const pct = parseInt(el.dataset.pct, 10) || 0;
        const isPro = el.dataset.isPro === 'true';
        el.textContent = buildLimitDescription(pct, resetAt, active, state, limitType, isPro);
    });
}

function fmtReset(ms, isActiveAccount, state, limitType) {
    if (state === 'available') return 'Fully available';

    const diff = ms - Date.now();
    if (diff <= 0) {
        return isActiveAccount ? 'Refreshing…' : 'Available';
    }
    return fmtResetDuration(ms, limitType);
}

function fmtResetDuration(ms, limitType, isPro) {
    const diff = ms - Date.now();
    if (diff <= 0) {
        return 'shortly';
    }
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);

    if (d > 0) {
        if (limitType === 'weekly' && isPro) {
            return `in ${d} day${d > 1 ? 's' : ''}`;
        }
        return `in ${d} day${d > 1 ? 's' : ''}, ${h} hour${h !== 1 ? 's' : ''}`;
    }
    if (h > 0) { return `in ${h} hour${h > 1 ? 's' : ''}, ${m} minute${m !== 1 ? 's' : ''}`; }
    return `in ${m} minute${m !== 1 ? 's' : ''}`;
}

function getWeeklyResetTime() {
    const now = new Date();
    // Wednesday 17:00
    const reset = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0, 0);
    const dayDiff = (3 - now.getDay() + 7) % 7;
    reset.setDate(now.getDate() + (dayDiff === 0 ? 7 : dayDiff));
    return reset.getTime();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
function cmd_reset() { vscode.postMessage({ type: 'reset' }); }
function cmd_removeAccount(id) { vscode.postMessage({ type: 'removeAccount', id }); }