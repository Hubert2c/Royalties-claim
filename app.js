// =============================================================================
// app.js — Government administration console (admin + read-only auditor)
// -----------------------------------------------------------------------------
// Each sidebar view has a load function below (loadOverview, loadLicences, ...).
// Buttons inside tables carry data-* attributes; one click listener at the
// bottom of the file decides what each button does.
// =============================================================================

const { esc, money, percent, date, dateTime, label, pill, table, toast } = UI;
const session = UI.session('government');

// Shortcut for API calls that need the login token.
const api = (path, options = {}) => UI.api(path, { ...options, token: session.token, onUnauthorized: logout });

// Auditors can read everything but not change anything.
const canWrite = () => session.user && session.user.role === 'admin';

// Today's month as YYYY-MM (used as the default period everywhere).
const thisMonth = new Date().toISOString().slice(0, 7);

// -----------------------------------------------------------------------------
// Login / logout
// -----------------------------------------------------------------------------
function showApp() {
  const loggedIn = Boolean(session.token && session.user);
  document.querySelector('#authView').classList.toggle('hidden', loggedIn);
  document.querySelector('#appView').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;

  document.querySelector('#userName').textContent = session.user.name;
  document.querySelector('#userRole').textContent = session.user.role === 'admin' ? 'Administrator' : 'Auditor (read-only)';
  document.querySelector('#userAvatar').textContent = UI.initials(session.user.name);
  document.querySelector('#auditorBanner').classList.toggle('hidden', canWrite());
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !canWrite()));
  if (!bellWidget) bellWidget = UIWidgets.bell({ mount: document.querySelector('#bellMount'), api, onOpenView: (view) => showView(view) });
  else bellWidget.refresh();
  showView('overview');
}

// --- Notification bell, quick search (Ctrl+K) and mobile menu ----------------------
let bellWidget = null;
UIWidgets.mobileNav();
const quickSearch = UIWidgets.palette({
  views: [...document.querySelectorAll('.nav-item[data-view]')].map((b) => ({ view: b.dataset.view, label: b.textContent.trim() })),
  search: async (q) => (await api(`/api/admin/search?q=${encodeURIComponent(q)}`)).results,
  onPick: (item) => {
    showView(item.view);
    if (item.type === 'Distribution run') openRun(item.id).catch((e) => toast(e.message, true));
  }
});
document.querySelector('#searchTrigger').addEventListener('click', () => quickSearch.open());

function logout() {
  stopLive();
  if (bellWidget) { bellWidget.stop(); bellWidget = null; }
  session.clear();
  showApp();
}

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { email, password } = UI.formData(event.target);
  try {
    const data = await UI.api('/api/auth/login', { body: { email, password, portal: 'government' } });
    session.save(data.token, data.user);
    event.target.reset();
    showApp();
  } catch (error) {
    toast(error.message, true);
  }
});
document.querySelector('#logoutBtn').addEventListener('click', logout);

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------
const loaders = {
  overview: loadOverview,
  licences: loadLicences,
  tariffs: loadTariffs,
  usage: loadUsage,
  compliance: loadCompliance,
  runs: loadRuns,
  claims: loadClaims,
  catalogue: loadCatalogue,
  audit: loadAudit,
  settings: loadSettings
};
const showView = UI.setupNav((view) => {
  if (view === 'overview') startLive(); else stopLive();
  loaders[view]().catch((error) => toast(error.message, true));
});

// Small helper for action buttons inside tables (hidden for auditors).
const actionBtn = (text, action, id, style = 'secondary') => (canWrite()
  ? `<button class="action-btn ${style}" type="button" data-action="${action}" data-id="${esc(id)}">${esc(text)}</button>` : '');

// --- Overview ------------------------------------------------------------------
async function loadOverview() {
  const [{ overview: o }, trends] = await Promise.all([api('/api/admin/overview'), api('/api/admin/trends')]);

  // Money-flow bar: collected = admin fee + paid + held + not yet distributed.
  UIWidgets.flowBar('#ovFlow', { collected: o.collectedTotal, adminFees: o.adminFees, paid: o.distributedPaid, held: o.heldAmount });
  document.querySelector('#ovFeeRate').textContent = `Administration fee ${percent(o.adminFeeRate, 1)} (legal cap 30%)`;

  UIWidgets.barChart('#ovTrend', {
    labels: trends.months,
    series: [
      { name: 'Collected', values: trends.collections, tone: 'primary' },
      { name: 'Paid to creators', values: trends.payouts, tone: 'paid' }
    ]
  });

  // Work queue tiles — tiles that need action are highlighted.
  const queue = [
    ['Licence applications', o.pendingLicences, 'licences', true],
    ['Unpaid invoices', o.unpaidInvoices, 'compliance', true],
    ['Pending claims', o.pendingClaims, 'claims', true],
    ['Open disputes', o.openDisputes, 'claims', true],
    ['Unmatched plays', o.unmatchedUsage, 'usage', true],
    ['Plays this month', o.usageThisPeriod, 'usage', false],
    ['Active works', `${o.activeWorks} of ${o.worksCount}`, 'catalogue', false],
    ['Licensees', o.licenseesCount, 'licences', false]
  ];
  document.querySelector('#ovQueue').innerHTML = queue
    .map(([name, value, view, needsAction]) => `<button class="mini-stat as-link ${needsAction && Number(value) > 0 ? 'attention' : ''}" type="button" data-goto="${view}">
        <span>${esc(name)}</span><strong>${esc(value)}</strong></button>`)
    .join('');

  const max = Math.max(1, ...o.usageBySource.map((s) => Number(s.count)));
  document.querySelector('#ovSources').innerHTML = o.usageBySource.length
    ? o.usageBySource.map((s) => `
        <div class="bar-row"><span>${label(s.source)}</span>
          <div class="bar"><div class="bar-fill" style="width:${(Number(s.count) / max) * 100}%"></div></div>
          <strong>${esc(s.count)}</strong></div>`).join('')
    : '<p class="empty-state">No plays reported this month yet.</p>';

  document.querySelector('#ovAudit').innerHTML = o.recentAudit.map((a) => `
    <div class="activity-item">
      <div class="activity-meta"><span class="activity-dot"></span>
        <div><strong>${label(a.action)}</strong><br /><small>#${esc(a.seq)}, ${label(a.entity)}${a.entity_id ? ` ${esc(a.entity_id)}` : ''}, by ${label(a.actor_role)}</small></div>
      </div>
      <small>${dateTime(a.created_at)}</small>
    </div>`).join('');

  await loadLive();
}

// --- Live airplay feed (polled every 5 seconds while the overview is open) ---------
const SOURCE_ICON = { fingerprint: 'radio', simulation: 'radio', play_log: 'statements', set_list: 'works', cue_sheet: 'licence', ddex: 'report' };
let liveTimer = null;
let seenPlays = new Set();

async function loadLive() {
  const { plays } = await api('/api/admin/live');
  const firstLoad = seenPlays.size === 0;
  document.querySelector('#ovLive').innerHTML = plays.length ? plays.slice(0, 6).map((p) => {
    const isNew = !firstLoad && !seenPlays.has(p.id);
    const title = p.recording_title || p.raw_title || 'Unknown title';
    const how = p.confidence ? `${label(p.source)}, ${(Number(p.confidence) * 100).toFixed(0)}% match` : label(p.source);
    return `<li class="${isNew ? 'is-new' : ''}">
      <span class="live-icon">${UIIcons.svg(SOURCE_ICON[p.source] || 'usage')}</span>
      <div><strong>${esc(title)}</strong><small>${esc(p.licensee_name || 'Unknown user')}, ${how}</small></div>
      <div class="live-meta">${pill(p.status)}<br /><small>${dateTime(p.played_at)}</small></div>
    </li>`;
  }).join('') : '<li><p class="empty-state">No plays yet. Try "Simulate airplay" under Usage &amp; monitoring.</p></li>';
  seenPlays = new Set(plays.map((p) => p.id));
}

function startLive() {
  stopLive();
  liveTimer = setInterval(() => loadLive().catch(() => {}), 5000);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }

// --- Licences ------------------------------------------------------------------
async function loadLicences() {
  const [{ licences }, { licensees }] = await Promise.all([api('/api/admin/licences'), api('/api/admin/licensees')]);
  table('#licencesTable', [
    { title: 'Licensee', render: (l) => `<strong>${esc(l.licensee_name)}</strong><br /><small>${label(l.category)}</small>` },
    { title: 'Tariff', render: (l) => `${esc(l.tariff_name)}${l.description ? `<br /><small>${esc(l.description)}</small>` : ''}` },
    { title: 'Period', render: (l) => `${date(l.period_start)} – ${date(l.period_end)}` },
    { title: 'Fee', render: (l) => money(l.fee_due) },
    { title: 'Status', render: (l) => pill(l.status) },
    { title: 'Clearance', render: (l) => (l.clearance_code ? `<code>${esc(l.clearance_code)}</code>` : '—') },
    { title: '', render: (l) => (l.status === 'applied'
      ? actionBtn('Approve & invoice', 'approve-licence', l.id, 'approve') + actionBtn('Reject', 'reject-licence', l.id, 'reject') : '') }
  ], licences, 'No licence applications yet.');

  table('#licenseesTable', [
    { title: 'Name', render: (l) => `<strong>${esc(l.name)}</strong><br /><small>${esc(l.email || '')}</small>` },
    { title: 'Category', render: (l) => label(l.category) },
    { title: 'TIN (RRA)', render: (l) => esc(l.tin || '—') },
    { title: 'RURA licence', render: (l) => esc(l.rura_licence_no || '—') },
    { title: 'Paid licences', render: (l) => esc(l.paid_licences) },
    { title: 'Usage reported', render: (l) => esc(l.usage_count) }
  ], licensees, 'No licensees registered.');
}

// --- Tariffs -------------------------------------------------------------------
const BASIS_TEXT = { flat_annual: 'per year', percent_gross: '% of gross', per_ad: 'per advert', per_event: 'per event' };
const rateText = (t) => (t.basis === 'percent_gross' ? `${Number(t.rate)}% of gross` : `${money(t.rate)} ${BASIS_TEXT[t.basis]}`);

async function loadTariffs() {
  const { tariffs } = await api('/api/admin/tariffs');
  table('#tariffsTable', [
    { title: 'Usage type', render: (t) => label(t.usage_type) },
    { title: 'Name', render: (t) => `<strong>${esc(t.name)}</strong><br /><small>${esc(t.legal_reference || 'No legal reference')}</small>` },
    { title: 'Rate', render: rateText },
    { title: 'Status', render: (t) => pill(t.status) },
    { title: '', render: (t) => (t.status === 'draft' ? actionBtn('Approve', 'approve-tariff', t.id, 'approve') : '')
      + (t.status === 'approved' ? actionBtn('Retire', 'retire-tariff', t.id, 'reject') : '') }
  ], tariffs);
}

document.querySelector('#newTariffBtn').addEventListener('click', () => UI.openModal('tariffModal'));
document.querySelector('#tariffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/admin/tariffs', { body: UI.formData(event.target) });
    toast(result.message);
    event.target.reset();
    UI.closeModal('tariffModal');
    loadTariffs();
  } catch (error) { toast(error.message, true); }
});

// --- Usage & monitoring ----------------------------------------------------------
async function loadUsage() {
  const periodInput = document.querySelector('#usagePeriod');
  if (!periodInput.value) periodInput.value = thisMonth;
  const status = document.querySelector('#usageStatus').value;

  const [{ usage }, { licensees }] = await Promise.all([
    api(`/api/admin/usage?period=${periodInput.value}${status ? `&status=${status}` : ''}`),
    api('/api/admin/licensees')
  ]);

  const stationSelect = document.querySelector('#simulateStation');
  const stations = licensees.filter((l) => ['radio', 'tv'].includes(l.category));
  stationSelect.innerHTML = (stations.length ? stations : licensees).map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');

  table('#usageTable', [
    { title: 'Played', render: (u) => dateTime(u.played_at) },
    { title: 'Licensee', render: (u) => esc(u.licensee_name || '—') },
    { title: 'Source', render: (u) => label(u.source) },
    { title: 'Reported as', render: (u) => `${esc(u.raw_title || '—')}<br /><small>${esc(u.raw_artist || '')} ${esc(u.isrc || '')}</small>` },
    { title: 'Matched recording', render: (u) => esc(u.recording_title || '—') },
    { title: 'Confidence', render: (u) => (u.confidence !== null && u.confidence !== undefined ? percent(u.confidence, 1) : '—') },
    { title: 'Status', render: (u) => pill(u.status) }
  ], usage, 'No usage for this period.');
}
document.querySelector('#usagePeriod').addEventListener('change', loadUsage);
document.querySelector('#usageStatus').addEventListener('change', loadUsage);

document.querySelector('#simulateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/admin/usage/simulate', { body: UI.formData(event.target) });
    toast(result.message);
    document.querySelector('#usagePeriod').value = thisMonth;
    loadUsage();
  } catch (error) { toast(error.message, true); }
});

// --- Compliance ------------------------------------------------------------------
const COMPLIANCE_TEXT = {
  compliant: 'Paid licence in force',
  unlicensed_use: 'Used music without a paid licence',
  invoice_unpaid: 'Invoice not paid',
  no_licence: 'No licence (no usage reported)'
};

async function loadCompliance() {
  const periodInput = document.querySelector('#compliancePeriod');
  if (!periodInput.value) periodInput.value = thisMonth;
  const { compliance } = await api(`/api/admin/compliance?period=${periodInput.value}`);
  table('#complianceTable', [
    { title: 'Licensee', render: (c) => `<strong>${esc(c.name)}</strong><br /><small>${label(c.category)} · TIN ${esc(c.tin || '—')}</small>` },
    { title: 'Plays this period', render: (c) => esc(c.usage_count) },
    { title: 'Amount owed', render: (c) => money(c.amount_owed) },
    { title: 'Status', render: (c) => `${pill(c.status)}<br /><small>${esc(COMPLIANCE_TEXT[c.status])}</small>` },
    { title: '', render: (c) => (c.status === 'compliant' ? '' : actionBtn('Send reminder', 'remind', c.id) + (c.status === 'unlicensed_use' ? actionBtn('Legal notice', 'legal-notice', c.id, 'reject') : '')) }
  ], compliance);
}
document.querySelector('#compliancePeriod').addEventListener('change', loadCompliance);

// --- Distribution runs -------------------------------------------------------------
async function loadRuns() {
  const runPeriod = document.querySelector('#runPeriod');
  if (!runPeriod.value) runPeriod.value = thisMonth;
  const [{ runs }, settings] = await Promise.all([api('/api/admin/runs'), api('/api/admin/settings')]);
  document.querySelector('#runFeeNote').textContent = `Pool = licence payments received in the month. Current administration fee: ${percent(settings.adminFeeRate, 1)} (maximum 30%). Each matched play gets an equal share; each play is split by the work's confirmed splits.`;

  table('#runsTable', [
    { title: 'Run', render: (r) => `<button class="table-link" type="button" data-action="open-run" data-id="${esc(r.id)}">${esc(r.id)}</button>` },
    { title: 'Period', render: (r) => esc(r.period) },
    { title: 'Pool', render: (r) => money(r.total_pool) },
    { title: 'Admin fee', render: (r) => `${money(r.admin_fee)}<br /><small>${percent(r.admin_fee_rate, 1)}</small>` },
    { title: 'Distributable', render: (r) => money(r.distributable) },
    { title: 'Held', render: (r) => money(r.held_amount) },
    { title: 'Plays', render: (r) => esc(r.usage_count) },
    { title: 'Status', render: (r) => pill(r.status) }
  ], runs, 'No distribution runs yet. Calculate one above.');
}

document.querySelector('#runForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/admin/runs', { body: UI.formData(event.target) });
    toast(result.message);
    await loadRuns();
    openRun(result.run.id);
  } catch (error) { toast(error.message, true); }
});

async function openRun(id) {
  const { run, byHolder, byWork } = await api(`/api/admin/runs/${encodeURIComponent(id)}`);
  document.querySelector('#runModalTitle').textContent = `Run ${run.id} — ${run.period}`;

  // Buttons depend on the run's status: draft -> approve/cancel, approved -> pay.
  let actions = '';
  if (canWrite() && run.status === 'draft') {
    actions = `<button class="secondary-btn" type="button" data-action="cancel-run" data-id="${esc(run.id)}">Cancel draft</button>
      <button class="primary-btn" type="button" data-action="approve-run" data-id="${esc(run.id)}">Approve run</button>`;
  } else if (canWrite() && run.status === 'approved') {
    actions = `<button class="primary-btn" type="button" data-action="pay-run" data-id="${esc(run.id)}">Pay rights holders (simulated)</button>`;
  }

  document.querySelector('#runModalBody').innerHTML = `
    <div class="claim-summary">
      <div class="detail-box">
        <h4>Calculation</h4>
        <p>Pool (payments received): <strong>${money(run.total_pool)}</strong></p>
        <p>− Administration fee (${percent(run.admin_fee_rate, 1)}): <strong>${money(run.admin_fee)}</strong></p>
        <p>= Distributable: <strong>${money(run.distributable)}</strong></p>
        <p>Matched plays: <strong>${esc(run.usage_count)}</strong> · Held: <strong>${money(run.held_amount)}</strong></p>
      </div>
      <div class="detail-box">
        <h4>Status</h4>
        <p>${pill(run.status)}</p>
        <p>Created ${dateTime(run.created_at)}</p>
        <p>Approved ${dateTime(run.approved_at)} · Paid ${dateTime(run.paid_at)}</p>
      </div>
    </div>
    <div class="detail-box"><h4>By rights holder</h4><div id="runByHolder"></div></div>
    <div class="detail-box"><h4>By work</h4><div id="runByWork"></div></div>
    <div class="form-actions">${actions}</div>`;

  table('#runByHolder', [
    { title: 'Rights holder', render: (h) => esc(h.full_name) },
    { title: 'Payout to', render: (h) => (h.payout_ref_last4 ? `${label(h.payout_method)} •••• ${esc(h.payout_ref_last4)}` : '<span class="muted">No payout details</span>') },
    { title: 'Lines', render: (h) => esc(h.lines) },
    { title: 'Amount', render: (h) => money(h.amount) },
    { title: 'Paid', render: (h) => money(h.paid) }
  ], byHolder, 'No payable lines.');
  table('#runByWork', [
    { title: 'Work', render: (w) => `${esc(w.title)} ${w.status !== 'active' ? pill('held') : ''}` },
    { title: 'Plays', render: (w) => esc(w.plays) },
    { title: 'Value', render: (w) => money(w.amount) },
    { title: 'Held', render: (w) => money(w.held) }
  ], byWork, 'No plays in this period.');

  UI.openModal('runModal');
}

// --- Claims & disputes ---------------------------------------------------------------
async function loadClaims() {
  const [{ claims }, { disputes }] = await Promise.all([api('/api/admin/claims'), api('/api/admin/disputes')]);
  table('#claimsTable', [
    { title: 'Claimant', render: (c) => esc(c.claimant_name) },
    { title: 'Unmatched play', render: (c) => `${esc(c.raw_title || '—')} <small>(${esc(c.raw_artist || '?')})</small><br /><small>${esc(c.licensee_name || '')} · ${dateTime(c.played_at)}</small>` },
    { title: 'Claimed as', render: (c) => `${esc(c.recording_title)}<br /><small>${esc(c.isrc || '')}</small>` },
    { title: 'Note / evidence', render: (c) => `${esc(c.note || '')}${c.evidence_file ? `<br /><button class="table-link" type="button" data-action="evidence" data-id="${esc(c.id)}">Open evidence</button>` : ''}` },
    { title: 'Status', render: (c) => pill(c.status) },
    { title: '', render: (c) => (c.status === 'pending' ? actionBtn('Approve', 'approve-claim', c.id, 'approve') + actionBtn('Reject', 'reject-claim', c.id, 'reject') : '') }
  ], claims, 'No claims yet.');

  table('#disputesTable', [
    { title: 'Raised by', render: (d) => `${esc(d.raised_by_name)}<br /><small>${label(d.raised_by_role)}</small>` },
    { title: 'About', render: (d) => `${label(d.subject_type)} ${esc(d.subject_id || '')}` },
    { title: 'Reason', render: (d) => esc(d.reason) },
    { title: 'Status', render: (d) => `${pill(d.status)}${d.resolution ? `<br /><small>${esc(d.resolution)}</small>` : ''}` },
    { title: '', render: (d) => (d.status === 'open' ? actionBtn('Resolve', 'resolve-dispute', d.id, 'approve') : '') }
  ], disputes, 'No disputes.');
  loadClaims.disputes = disputes; // remembered for the resolve dialog
}

document.querySelector('#disputeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = UI.formData(event.target);
  try {
    const result = await api(`/api/admin/disputes/${encodeURIComponent(data.id)}/resolve`, { body: data });
    toast(result.message);
    UI.closeModal('disputeModal');
    loadClaims();
  } catch (error) { toast(error.message, true); }
});

// --- Catalogue -------------------------------------------------------------------------
async function loadCatalogue() {
  const [{ works }, { holders }] = await Promise.all([api('/api/admin/works'), api('/api/admin/rights-holders')]);
  table('#worksTable', [
    { title: 'Work', render: (w) => `<strong>${esc(w.title)}</strong><br /><small>${esc(w.iswc || 'No ISWC')}</small>` },
    { title: 'Splits', render: (w) => w.splits.map((s) => `${esc(s.full_name)} ${esc(Number(s.share_percent))}% ${s.status !== 'confirmed' ? pill(s.status) : ''}`).join('<br />') },
    { title: 'Recordings', render: (w) => esc(w.recordings) },
    { title: 'Plays', render: (w) => esc(w.plays) },
    { title: 'Status', render: (w) => pill(w.status) }
  ], works);
  table('#holdersTable', [
    { title: 'Name', render: (h) => esc(h.full_name) },
    { title: 'Type', render: (h) => label(h.holder_type) },
    { title: 'IPI', render: (h) => esc(h.ipi_number || '—') },
    { title: 'Payout', render: (h) => (h.payout_ref_last4 ? `${label(h.payout_method)} •••• ${esc(h.payout_ref_last4)}` : '—') },
    { title: 'Status', render: (h) => pill(h.status) }
  ], holders);
}

// --- Audit log ---------------------------------------------------------------------------
async function loadAudit() {
  const { entries } = await api('/api/admin/audit?limit=300');
  table('#auditTable', [
    { title: '#', render: (a) => esc(a.seq) },
    { title: 'When', render: (a) => dateTime(a.created_at) },
    { title: 'Who', render: (a) => `${esc(a.actor_name || a.actor_id || 'system')}<br /><small>${label(a.actor_role)}</small>` },
    { title: 'Action', render: (a) => `<strong>${label(a.action)}</strong><br /><small>${label(a.entity)} ${esc(a.entity_id || '')}</small>` },
    { title: 'Details', render: (a) => `<small class="mono">${esc(a.details || '')}</small>` },
    { title: 'Hash', render: (a) => `<small class="mono" title="${esc(a.hash)}">${esc(a.hash.slice(0, 12))}…</small>` }
  ], entries);
}

document.querySelector('#verifyAuditBtn').addEventListener('click', async () => {
  try {
    const { verification: v } = await api('/api/admin/audit/verify');
    document.querySelector('#auditVerify').innerHTML = v.valid
      ? `<div class="notice notice-good">Chain verified: all ${esc(v.count)} entries are intact.</div>`
      : `<div class="notice notice-bad">Chain BROKEN at entry #${esc(v.brokenAt)}: ${esc(v.reason)}</div>`;
  } catch (error) { toast(error.message, true); }
});

// --- Settings & API keys -----------------------------------------------------------------
async function loadSettings() {
  const [settings, { keys }] = await Promise.all([api('/api/admin/settings'), api('/api/admin/api-keys')]);
  const feeInput = document.querySelector('#feeRate');
  feeInput.value = (settings.adminFeeRate * 100).toFixed(1);
  feeInput.disabled = !canWrite();
  document.querySelector('#newKeyBox').innerHTML = '';
  table('#keysTable', [
    { title: 'Label', render: (k) => esc(k.label) },
    { title: 'Type', render: (k) => (k.owner_type === 'monitor' ? 'Monitoring service' : `Licensee: ${esc(k.licensee_name || k.owner_id)}`) },
    { title: 'Key', render: (k) => `<code>${esc(k.key_prefix)}…</code>` },
    { title: 'Created', render: (k) => date(k.created_at) },
    { title: 'Status', render: (k) => pill(Number(k.revoked) ? 'revoked' : 'active') },
    { title: '', render: (k) => (Number(k.revoked) ? '' : actionBtn('Revoke', 'revoke-key', k.id, 'reject')) }
  ], keys, 'No API keys yet.');
}

document.querySelector('#feeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/admin/settings', { method: 'PUT', body: { adminFeeRate: Number(document.querySelector('#feeRate').value) / 100 } });
    toast(result.message);
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#newKeyBtn').addEventListener('click', async () => {
  const labelText = window.prompt('Label for this monitor key:', 'National radio monitor');
  if (labelText === null) return;
  try {
    const result = await api('/api/admin/api-keys', { body: { label: labelText } });
    await loadSettings();
    document.querySelector('#newKeyBox').innerHTML = `<div class="notice notice-good">Copy this key now — it will not be shown again:<br /><code class="key-display">${esc(result.key)}</code></div>`;
  } catch (error) { toast(error.message, true); }
});

// -----------------------------------------------------------------------------
// One click handler for all buttons inside tables and dialogs
// -----------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const goto = event.target.closest('[data-goto]');
  if (goto) { showView(goto.dataset.goto); return; }

  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  const encodedId = encodeURIComponent(id || '');

  // Each action: [API path, success callback]. Confirm-worthy actions ask first.
  const simplePost = {
    'approve-licence': [`/api/admin/licences/${encodedId}/approve`, loadLicences],
    'reject-licence': [`/api/admin/licences/${encodedId}/reject`, loadLicences, 'Reject this licence application?'],
    'approve-tariff': [`/api/admin/tariffs/${encodedId}/approve`, loadTariffs, 'Approve this tariff? Licensees will be able to use it.'],
    'retire-tariff': [`/api/admin/tariffs/${encodedId}/retire`, loadTariffs, 'Retire this tariff? New licences will not be able to use it.'],
    remind: [`/api/admin/compliance/${encodedId}/remind`, loadCompliance],
    'approve-claim': [`/api/admin/claims/${encodedId}/approve`, loadClaims],
    'reject-claim': [`/api/admin/claims/${encodedId}/reject`, loadClaims, 'Reject this claim?'],
    'approve-run': [`/api/admin/runs/${encodedId}/approve`, () => { loadRuns(); openRun(id); }, 'Approve this run? Rights holders will see it on their statements.'],
    'cancel-run': [`/api/admin/runs/${encodedId}/cancel`, () => { UI.closeModal('runModal'); loadRuns(); }, 'Cancel this draft run?'],
    'pay-run': [`/api/admin/runs/${encodedId}/pay`, () => { loadRuns(); openRun(id); }, 'Send payouts to all rights holders in this run? (simulated)'],
    'revoke-key': [`/api/admin/api-keys/${encodedId}/revoke`, loadSettings, 'Revoke this API key? Systems using it will stop working.']
  };

  try {
    if (simplePost[action]) {
      const [path, after, question] = simplePost[action];
      if (question && !window.confirm(question)) return;
      const result = await api(path, { method: 'POST', body: {} });
      toast(result.message);
      after();
    } else if (action === 'legal-notice') {
      if (!window.confirm('Record a formal legal notice for this licensee?')) return;
      const result = await api(`/api/admin/compliance/${encodedId}/remind`, { body: { level: 'legal_notice' } });
      toast(result.message);
    } else if (action === 'open-run') {
      await openRun(id);
    } else if (action === 'evidence') {
      await UI.download(`/api/admin/claims/${encodedId}/evidence`, session.token);
    } else if (action === 'resolve-dispute') {
      const dispute = (loadClaims.disputes || []).find((d) => d.id === id);
      const form = document.querySelector('#disputeForm');
      form.reset();
      form.elements.id.value = id;
      document.querySelector('#disputeReason').textContent = dispute ? `"${dispute.reason}"` : '';
      UI.openModal('disputeModal');
    }
  } catch (error) {
    toast(error.message, true);
  }
});

showApp();
