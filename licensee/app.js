// =============================================================================
// licensee/app.js — Licensee portal (radio/TV, events, advertisers, venues...)
// -----------------------------------------------------------------------------
// Views: licences & payments, report usage (CSV or one by one), my usage,
// API keys, disputes, profile.
// =============================================================================

const { esc, money, date, dateTime, label, pill, table, toast } = UI;
const session = UI.session('licensee');
const api = (path, options = {}) => UI.api(path, { ...options, token: session.token, onUnauthorized: logout });

let tariffs = [];
let licences = [];
let profile = null;

// -----------------------------------------------------------------------------
// Login / register / logout
// -----------------------------------------------------------------------------
async function showApp() {
  const loggedIn = Boolean(session.token && session.user);
  document.querySelector('#authView').classList.toggle('hidden', loggedIn);
  document.querySelector('#appView').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;
  try {
    ({ profile } = await api('/api/licensee/profile'));
    document.querySelector('#orgName').textContent = profile.name;
    document.querySelector('#orgCategory').textContent = String(profile.category).replace(/_/g, ' ');
    document.querySelector('#userAvatar').textContent = UI.initials(profile.name);
  } catch (error) { toast(error.message, true); }
  if (!bellWidget) bellWidget = UIWidgets.bell({ mount: document.querySelector('#bellMount'), api, onOpenView: (view) => showView(view) });
  else bellWidget.refresh();
  showView('licences');
}

let bellWidget = null;
UIWidgets.mobileNav();

function logout() {
  if (bellWidget) { bellWidget.stop(); bellWidget = null; }
  session.clear();
  showApp();
}

document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelector('#loginForm').classList.toggle('hidden', tab.dataset.authPanel !== 'login');
  document.querySelector('#registerForm').classList.toggle('hidden', tab.dataset.authPanel !== 'register');
}));

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await UI.api('/api/auth/login', { body: { ...UI.formData(event.target), portal: 'licensee' } });
    session.save(data.token, data.user);
    event.target.reset();
    showApp();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await UI.api('/api/auth/register', { body: { ...UI.formData(event.target), role: 'licensee' } });
    session.save(data.token, data.user);
    event.target.reset();
    toast('Organisation registered.');
    showApp();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#logoutBtn').addEventListener('click', logout);

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------
const loaders = { licences: loadLicences, report: async () => {}, usage: loadUsage, keys: loadKeys, disputes: loadDisputes, profile: loadProfile };
const showView = UI.setupNav((view) => loaders[view]().catch((error) => toast(error.message, true)));

// --- Licences --------------------------------------------------------------------
async function loadLicences() {
  const [licenceData, usageData] = await Promise.all([api('/api/licensee/licences'), api('/api/licensee/usage')]);
  ({ licences } = licenceData);

  // Summary figures above the table.
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const active = licences.filter((l) => l.status === 'paid' && l.period_start <= today && l.period_end >= today);
  const due = licences.filter((l) => l.status === 'invoiced');
  const paidThisYear = licences.filter((l) => l.status === 'paid' && String(l.created_at).startsWith(year)).reduce((sum, l) => sum + Number(l.fee_due), 0);
  const matched = usageData.usage.filter((u) => u.status === 'matched').length;
  document.querySelector('#lcActive').textContent = active.length;
  document.querySelector('#lcDue').textContent = money(due.reduce((sum, l) => sum + Number(l.fee_due), 0));
  document.querySelector('#lcDueCount').textContent = `${due.length} approved invoice${due.length === 1 ? '' : 's'}`;
  document.querySelector('#lcPaid').textContent = money(paidThisYear);
  document.querySelector('#lcPlays').textContent = usageData.usage.length;
  document.querySelector('#lcMatched').textContent = `${matched} matched to registered songs`;

  table('#licencesTable', [
    { title: 'Licence', render: (l) => `<strong>${esc(l.tariff_name)}</strong><br /><small>${esc(l.description || l.id)}</small>` },
    { title: 'Period', render: (l) => `${date(l.period_start)} – ${date(l.period_end)}` },
    { title: 'Fee', render: (l) => `<strong>${money(l.fee_due)}</strong>` },
    { title: 'Status', render: (l) => pill(l.status) },
    { title: 'Clearance code', render: (l) => (l.clearance_code ? `<code>${esc(l.clearance_code)}</code>${l.status === 'paid' ? '' : '<br /><small>valid after payment</small>'}` : '—') },
    { title: '', render: (l) => (l.status === 'invoiced'
      ? `<button class="action-btn approve" type="button" data-action="pay" data-id="${esc(l.id)}">Pay now</button>`
      : (l.status === 'paid' ? `<button class="action-btn" type="button" data-action="certificate" data-id="${esc(l.id)}">Certificate</button><br /><small>${esc(l.payment_reference || '')}</small>` : '')) }
  ], licences, 'No licences yet. Click "+ Apply for a licence".');
}

// --- Apply for a licence -----------------------------------------------------------
const BASIS_TEXT = { flat_annual: 'per year (charged per month for shorter periods)', percent_gross: '% of your gross receipts', per_ad: 'per advert', per_event: 'per event' };

async function openApply() {
  ({ tariffs } = await api('/api/licensee/tariffs'));
  // Show the tariffs for my category first.
  const sorted = [...tariffs].sort((a, b) => (a.usage_type === profile.category ? -1 : 0) - (b.usage_type === profile.category ? -1 : 0));
  document.querySelector('#tariffSelect').innerHTML = sorted.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  const form = document.querySelector('#applyForm');
  form.reset();
  const year = new Date().getFullYear();
  form.elements.periodStart.value = `${year}-01-01`;
  form.elements.periodEnd.value = `${year}-12-31`;
  updateTariffFields();
  UI.openModal('applyModal');
}

// Show only the fields the chosen tariff needs.
function updateTariffFields() {
  const tariff = tariffs.find((t) => t.id === document.querySelector('#tariffSelect').value);
  if (!tariff) return;
  const rate = tariff.basis === 'percent_gross' ? `${Number(tariff.rate)}` : money(tariff.rate);
  document.querySelector('#tariffHint').textContent = `${rate} ${BASIS_TEXT[tariff.basis]}. Legal basis: ${tariff.legal_reference || '—'}`;
  document.querySelector('.field-quantity').classList.toggle('hidden', !['per_ad', 'per_event'].includes(tariff.basis));
  document.querySelector('.field-gross').classList.toggle('hidden', tariff.basis !== 'percent_gross');
}

document.querySelector('#applyBtn').addEventListener('click', () => openApply().catch((e) => toast(e.message, true)));
document.querySelector('#tariffSelect').addEventListener('change', updateTariffFields);
document.querySelector('#applyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/licensee/licences', { body: UI.formData(event.target) });
    toast(result.message);
    UI.closeModal('applyModal');
    showView('licences');
  } catch (error) { toast(error.message, true); }
});

// --- Pay (simulated) -------------------------------------------------------------------
document.querySelector('#payForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = UI.formData(event.target);
  try {
    const result = await api(`/api/licensee/licences/${encodeURIComponent(data.licenceId)}/pay`, { body: data });
    toast(result.message);
    UI.closeModal('payModal');
    loadLicences();
  } catch (error) { toast(error.message, true); }
});

// --- Report usage -----------------------------------------------------------------------
function showReportResult(summary) {
  const errors = summary.errors && summary.errors.length ? `<ul>${summary.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
  document.querySelector('#reportResult').innerHTML = `
    <div class="notice ${summary.unmatched ? '' : 'notice-good'}">
      Saved ${esc(summary.saved)} · matched ${esc(summary.matched)} · unmatched ${esc(summary.unmatched)}
      ${summary.unmatched ? '<br />Unmatched songs go on the public unclaimed list so their owners can claim them.' : ''}
      ${errors}
    </div>`;
}

document.querySelector('#csvForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/licensee/usage/csv', { form: new FormData(event.target) });
    toast(result.message);
    showReportResult(result.summary);
    event.target.reset();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#rowForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const row = UI.formData(event.target);
  const source = row.source;
  delete row.source;
  row.played_at = new Date(row.played_at).toISOString();
  try {
    const result = await api('/api/licensee/usage', { body: { source, rows: [row] } });
    toast(result.message);
    showReportResult(result.summary);
    event.target.reset();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#sampleCsvBtn').addEventListener('click', () => {
  const now = new Date();
  const at = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
  UI.downloadCsv('sample-play-log.csv', ['played_at', 'title', 'artist', 'isrc', 'duration_sec'], [
    [at(90), 'Midnight Echo', 'Munezero Hubert', 'RWA012600001', 210],
    [at(60), 'Golden Hours', 'Aline Kay', '', 198],
    [at(30), 'Song Not Yet Registered', 'New Artist', '', 185]
  ]);
});

// --- My usage ------------------------------------------------------------------------------
async function loadUsage() {
  const { usage } = await api('/api/licensee/usage');
  table('#usageTable', [
    { title: 'Played', render: (u) => dateTime(u.played_at) },
    { title: 'Reported as', render: (u) => `${esc(u.raw_title || '—')}<br /><small>${esc(u.raw_artist || '')} ${esc(u.isrc || '')}</small>` },
    { title: 'Source', render: (u) => label(u.source) },
    { title: 'Matched to', render: (u) => esc(u.recording_title || '—') },
    { title: 'Status', render: (u) => pill(u.status) }
  ], usage, 'No usage reported yet.');
}

// --- API keys ------------------------------------------------------------------------------
async function loadKeys() {
  const { keys } = await api('/api/licensee/api-keys');
  table('#keysTable', [
    { title: 'Label', render: (k) => esc(k.label) },
    { title: 'Key', render: (k) => `<code>${esc(k.key_prefix)}…</code>` },
    { title: 'Created', render: (k) => date(k.created_at) },
    { title: 'Status', render: (k) => pill(Number(k.revoked) ? 'revoked' : 'active') },
    { title: '', render: (k) => (Number(k.revoked) ? '' : `<button class="action-btn reject" type="button" data-action="revoke" data-id="${esc(k.id)}">Revoke</button>`) }
  ], keys, 'No API keys yet.');
}

document.querySelector('#newKeyBtn').addEventListener('click', async () => {
  const labelText = window.prompt('What is this key for?', 'Playout system');
  if (labelText === null) return;
  try {
    const result = await api('/api/licensee/api-keys', { body: { label: labelText } });
    await loadKeys();
    document.querySelector('#newKeyBox').innerHTML = `<div class="notice notice-good">Copy this key now — it will not be shown again:<br /><code class="key-display">${esc(result.key)}</code></div>`;
  } catch (error) { toast(error.message, true); }
});

// --- Disputes ------------------------------------------------------------------------------
async function loadDisputes() {
  const { disputes } = await api('/api/disputes');
  table('#disputesTable', [
    { title: 'Raised', render: (d) => date(d.created_at) },
    { title: 'About', render: (d) => `${label(d.subject_type)} ${esc(d.subject_id || '')}` },
    { title: 'Reason', render: (d) => esc(d.reason) },
    { title: 'Status', render: (d) => pill(d.status) },
    { title: 'Decision', render: (d) => esc(d.resolution || '—') }
  ], disputes, 'No disputes.');
}

document.querySelector('#disputeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/disputes', { body: UI.formData(event.target) });
    toast(result.message);
    event.target.reset();
    loadDisputes();
  } catch (error) { toast(error.message, true); }
});

// --- Profile -------------------------------------------------------------------------------
async function loadProfile() {
  ({ profile } = await api('/api/licensee/profile'));
  document.querySelector('#profileBox').innerHTML = `
    <div><span>Organisation</span><strong>${esc(profile.name)}</strong></div>
    <div><span>Category</span><strong>${label(profile.category)}</strong></div>
    <div><span>Licensee ID</span><strong><code>${esc(profile.id)}</code></strong></div>
    <div><span>TIN</span><strong>${esc(profile.tin || '—')}</strong></div>
    <div><span>RURA licence</span><strong>${esc(profile.rura_licence_no || '—')}</strong></div>`;
  const form = document.querySelector('#profileForm');
  form.elements.tin.value = profile.tin || '';
  form.elements.ruraLicenceNo.value = profile.rura_licence_no || '';
}

document.querySelector('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/licensee/profile', { method: 'PUT', body: UI.formData(event.target) });
    toast(result.message);
    loadProfile();
  } catch (error) { toast(error.message, true); }
});

// --- Licence certificate (printable, for display at the premises or for a permit office) ---
function printCertificate(licence) {
  UIWidgets.printDocument('Music licence certificate', `
    <div class="cert-box">
      <p>This certifies that</p>
      <h2>${esc(profile.name)}</h2>
      <p>${label(profile.category)}${profile.tin ? `, TIN ${esc(profile.tin)}` : ''}</p>
      <p>holds a paid music licence under the tariff <strong>${esc(licence.tariff_name)}</strong>
        ${licence.description ? `(${esc(licence.description)})` : ''},
        valid from <strong>${date(licence.period_start)}</strong> to <strong>${date(licence.period_end)}</strong>.</p>
      <p>Clearance code</p>
      <p class="cert-code">${esc(licence.clearance_code)}</p>
      <p>Licence fee paid: ${money(licence.fee_due)} (reference ${esc(licence.payment_reference || '—')}).</p>
      <p>Anyone can check this code on the public dashboard of Royalty Hub.</p>
    </div>`);
}

// -----------------------------------------------------------------------------
// Buttons inside tables
// -----------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'pay') {
      const licence = licences.find((l) => l.id === id);
      const form = document.querySelector('#payForm');
      form.reset();
      form.elements.licenceId.value = id;
      document.querySelector('#payAmount').textContent = `${money(licence.fee_due)} — ${licence.tariff_name}`;
      UI.openModal('payModal');
    } else if (action === 'certificate') {
      printCertificate(licences.find((l) => l.id === id));
    } else if (action === 'revoke') {
      if (!window.confirm('Revoke this key? Systems using it will stop working.')) return;
      const result = await api(`/api/licensee/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} });
      toast(result.message);
      loadKeys();
    }
  } catch (error) { toast(error.message, true); }
});

showApp();
