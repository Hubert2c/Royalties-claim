// =============================================================================
// artist/app.js — Rights-holder portal (songwriters, composers, publishers, performers)
// -----------------------------------------------------------------------------
// Views: overview, my works (+ register a work with splits), confirm splits,
// statements, unclaimed plays (+ claim), disputes, profile.
// =============================================================================

const { esc, money, date, dateTime, label, pill, table, toast } = UI;
const session = UI.session('rightsholder');
const api = (path, options = {}) => UI.api(path, { ...options, token: session.token, onUnauthorized: logout });

let holders = [];        // all registered rights holders (for the split picker)
let myHolderId = null;   // my rights-holder ID
let statementLines = []; // last loaded statement (for CSV export)

// -----------------------------------------------------------------------------
// Login / register / logout
// -----------------------------------------------------------------------------
function showApp() {
  const loggedIn = Boolean(session.token && session.user);
  document.querySelector('#authView').classList.toggle('hidden', loggedIn);
  document.querySelector('#appView').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;
  document.querySelector('#userName').textContent = session.user.name;
  document.querySelector('#userAvatar').textContent = UI.initials(session.user.name);
  if (!bellWidget) bellWidget = UIWidgets.bell({ mount: document.querySelector('#bellMount'), api, onOpenView: (view) => showView(view) });
  else bellWidget.refresh();
  showView('overview');
  refreshPendingBadge();
}

let bellWidget = null;
UIWidgets.mobileNav();

function logout() {
  if (bellWidget) { bellWidget.stop(); bellWidget = null; }
  session.clear();
  showApp();
}

// Switch between the "Sign in" and "Register" forms.
document.querySelectorAll('.auth-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelector('#loginForm').classList.toggle('hidden', tab.dataset.authPanel !== 'login');
  document.querySelector('#registerForm').classList.toggle('hidden', tab.dataset.authPanel !== 'register');
}));

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await UI.api('/api/auth/login', { body: { ...UI.formData(event.target), portal: 'rightsholder' } });
    session.save(data.token, data.user);
    event.target.reset();
    showApp();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await UI.api('/api/auth/register', { body: { ...UI.formData(event.target), role: 'rightsholder' } });
    session.save(data.token, data.user);
    event.target.reset();
    toast('Account created. Welcome!');
    showApp();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('#logoutBtn').addEventListener('click', logout);

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------
const loaders = {
  overview: loadOverview,
  works: loadWorks,
  confirm: loadPendingSplits,
  statements: loadStatements,
  unclaimed: loadUnclaimed,
  disputes: loadDisputes,
  profile: loadProfile
};
const showView = UI.setupNav((view) => loaders[view]().catch((error) => toast(error.message, true)));

// --- Overview: totals, earnings chart, estimator, where songs are played ------------
let insights = null;

async function loadOverview() {
  const [{ totals }, data] = await Promise.all([api('/api/rightsholder/statements'), api('/api/rightsholder/insights')]);
  insights = data;
  document.querySelector('#stEarned').textContent = money(totals.earned);
  document.querySelector('#stPaid').textContent = money(totals.paid);
  document.querySelector('#stPending').textContent = money(totals.pending);
  document.querySelector('#stHeld').textContent = money(totals.heldForMyWorks);

  UIWidgets.barChart('#earningsChart', { labels: data.months, series: [{ name: 'Your royalties', values: data.earnings, tone: 'paid' }] });

  // Plays by type of music user (radio, venue, event...)
  const max = Math.max(1, ...data.byChannel.map((c) => Number(c.plays)));
  document.querySelector('#byChannel').innerHTML = data.byChannel.length
    ? data.byChannel.map((c) => `<div class="bar-row"><span>${label(c.category)}</span>
        <div class="bar"><div class="bar-fill" style="width:${(Number(c.plays) / max) * 100}%"></div></div><strong>${esc(c.plays)} plays</strong></div>`).join('')
    : '<p class="empty-state">No plays detected yet. Register your songs with an ISRC and a fingerprint so they can be recognised.</p>';

  document.querySelector('#topStations').innerHTML = data.topStations.length
    ? data.topStations.map((t) => `<li><span>${esc(t.name)} <small class="muted">${label(t.category)}</small></span><strong>${esc(t.plays)}</strong></li>`).join('')
    : '<li><span class="muted">Nothing yet.</span></li>';

  document.querySelector('#recentPlays').innerHTML = data.recentPlays.length
    ? data.recentPlays.map((p) => `<li>
        <span class="live-icon">${UIIcons.svg(['fingerprint', 'simulation'].includes(p.source) ? 'radio' : 'statements')}</span>
        <div><strong>${esc(p.title)}</strong><small>${esc(p.licensee_name || 'Unknown')}, ${label(p.source)}${p.confidence ? ` ${(Number(p.confidence) * 100).toFixed(0)}% match` : ''}</small></div>
        <div class="live-meta"><small>${dateTime(p.played_at)}</small></div></li>`).join('')
    : '<li><p class="empty-state">No plays detected yet.</p></li>';

  // Earnings estimator: plays × value of one play (latest run) × my share.
  const select = document.querySelector('#estWork');
  select.innerHTML = data.myShares.length
    ? data.myShares.map((w, i) => `<option value="${i}">${esc(w.title)} (your share ${esc(Number(w.share_percent))}%)</option>`).join('')
    : '<option value="">Register a song first</option>';
  updateEstimate();
}

function updateEstimate() {
  if (!insights) return;
  const plays = Number(document.querySelector('#estPlays').value);
  document.querySelector('#estPlaysLabel').textContent = plays;
  const work = insights.myShares[Number(document.querySelector('#estWork').value)];
  const result = document.querySelector('#estResult');
  const note = document.querySelector('#estNote');
  if (!work || !insights.perPlayValue) {
    result.textContent = '—';
    note.textContent = 'An estimate appears once at least one distribution run has been approved.';
    return;
  }
  const estimate = Math.round(plays * insights.perPlayValue * (Number(work.share_percent) / 100));
  result.textContent = money(estimate);
  note.textContent = `Based on ${money(insights.perPlayValue)} per play in the ${insights.perPlayPeriod} run, times your ${Number(work.share_percent)}% share. The real value changes every month with the money collected and the number of plays.`;
}
document.querySelector('#estPlays').addEventListener('input', updateEstimate);
document.querySelector('#estWork').addEventListener('change', updateEstimate);

// --- My works ----------------------------------------------------------------------
async function loadWorks() {
  const { works, holderId } = await api('/api/rightsholder/works');
  myHolderId = holderId;
  table('#worksTable', [
    { title: 'Work', render: (w) => `<strong>${esc(w.title)}</strong><br /><small>ISWC ${esc(w.iswc || '—')}</small>` },
    { title: 'Recordings', render: (w) => w.recordings.map((r) => `${esc(r.title)}<br /><small>ISRC ${esc(r.isrc || '—')} ${Number(r.has_fingerprint) ? '· fingerprinted' : '· no fingerprint'}</small>`).join('<br />') },
    { title: 'Splits', render: (w) => w.splits.filter((s) => s.status !== 'rejected').map((s) => `${esc(s.full_name)} — ${esc(Number(s.share_percent))}% ${label(s.right_type)} ${pill(s.status)}`).join('<br />') },
    { title: 'My share', render: (w) => `${esc(w.my_share)}%` },
    { title: 'Status', render: (w) => `${pill(w.status)}${w.status === 'pending_splits' ? '<br /><small>Royalties held until all splits are confirmed</small>' : ''}` }
  ], works, 'You have not registered any works yet. Click "+ Register a work".');
}

// --- Register a work (with dynamic split rows) --------------------------------------
async function openWorkModal() {
  if (!holders.length || !myHolderId) {
    const [h, w] = await Promise.all([api('/api/rightsholder/holders'), api('/api/rightsholder/works')]);
    holders = h.holders;
    myHolderId = w.holderId;
  }
  const form = document.querySelector('#workForm');
  form.reset();
  form.elements.performer.value = session.user.name;
  document.querySelector('#splitRows').innerHTML = '';
  addSplitRow(myHolderId, 100); // start with me at 100%
  UI.openModal('workModal');
}

function addSplitRow(holderId = '', share = '') {
  const row = document.createElement('div');
  row.className = 'split-row';
  row.innerHTML = `
    <select class="split-holder" required>
      <option value="">Choose a registered rights holder…</option>
      ${holders.map((h) => `<option value="${esc(h.id)}" ${h.id === holderId ? 'selected' : ''}>${esc(h.full_name)}${h.id === myHolderId ? ' (me)' : ''}${h.ipi_number ? ` · IPI ${esc(h.ipi_number)}` : ''}</option>`).join('')}
    </select>
    <input class="split-share" type="number" min="0.01" max="100" step="0.01" value="${esc(share)}" placeholder="%" required />
    <select class="split-right">
      <option value="lyrics">Lyrics</option><option value="music">Music</option><option value="publishing">Publishing</option><option value="performance">Performance</option>
    </select>
    <button class="action-btn reject" type="button" data-remove-split>Remove</button>`;
  document.querySelector('#splitRows').appendChild(row);
  updateSplitTotal();
}

function updateSplitTotal() {
  const total = [...document.querySelectorAll('.split-share')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const el = document.querySelector('#splitTotal');
  el.textContent = `Total: ${Number(total.toFixed(2))}%`;
  el.classList.toggle('total-ok', Math.abs(total - 100) < 0.001);
}

document.querySelector('#newWorkBtn').addEventListener('click', () => openWorkModal().catch((e) => toast(e.message, true)));
document.querySelector('#addSplitBtn').addEventListener('click', () => addSplitRow());
document.querySelector('#splitRows').addEventListener('input', updateSplitTotal);
document.querySelector('#splitRows').addEventListener('click', (event) => {
  if (event.target.matches('[data-remove-split]')) {
    event.target.closest('.split-row').remove();
    updateSplitTotal();
  }
});

document.querySelector('#workForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = UI.formData(event.target);
  const splits = [...document.querySelectorAll('.split-row')].map((row) => ({
    holder_id: row.querySelector('.split-holder').value,
    share_percent: Number(row.querySelector('.split-share').value),
    right_type: row.querySelector('.split-right').value
  }));
  const body = {
    title: f.title,
    iswc: f.iswc,
    recording: { title: f.title, performer: f.performer, isrc: f.isrc, duration_sec: f.duration_sec, fingerprint: f.fingerprint.replace(/^FINGERPRINT=/i, '') },
    splits
  };
  try {
    const result = await api('/api/rightsholder/works', { body });
    toast(result.message);
    UI.closeModal('workModal');
    showView('works');
  } catch (error) { toast(error.message, true); }
});

// --- Confirm splits --------------------------------------------------------------------
async function refreshPendingBadge() {
  try {
    const { splits } = await api('/api/rightsholder/splits/pending');
    const badge = document.querySelector('#pendingBadge');
    badge.textContent = splits.length;
    badge.classList.toggle('hidden', splits.length === 0);
  } catch (error) { /* badge is optional */ }
}

async function loadPendingSplits() {
  const { splits } = await api('/api/rightsholder/splits/pending');
  table('#pendingSplits', [
    { title: 'Work', render: (s) => `<strong>${esc(s.work_title)}</strong><br /><small>Registered by ${esc(s.registered_by || '—')}</small>` },
    { title: 'Your share', render: (s) => `<strong>${esc(Number(s.share_percent))}%</strong> ${label(s.right_type)}` },
    { title: 'All splits', render: (s) => s.all_splits.map((x) => `${esc(x.full_name)} ${esc(Number(x.share_percent))}% ${pill(x.status)}`).join('<br />') },
    { title: '', render: (s) => `<button class="action-btn approve" type="button" data-action="confirm" data-id="${esc(s.id)}">Confirm</button>
        <button class="action-btn reject" type="button" data-action="reject" data-id="${esc(s.id)}">Reject</button>` }
  ], splits, 'Nothing to confirm.');
  refreshPendingBadge();
}

// --- Statements --------------------------------------------------------------------------
async function loadStatements() {
  const { lines } = await api('/api/rightsholder/statements');
  statementLines = lines;
  table('#statementTable', [
    { title: 'Period', render: (l) => esc(l.period) },
    { title: 'Song', render: (l) => `<strong>${esc(l.work_title)}</strong><br /><small>${esc(l.isrc || '')}</small>` },
    { title: 'Where & when', render: (l) => `${esc(l.licensee_name || '—')}<br /><small>${label(l.licensee_category)} · ${dateTime(l.played_at)}</small>` },
    { title: 'Detected by', render: (l) => `${label(l.source)}${l.confidence ? `<br /><small>${(Number(l.confidence) * 100).toFixed(1)}% match</small>` : ''}` },
    { title: 'Play value', render: (l) => money(l.usage_value) },
    { title: 'Your share', render: (l) => `${esc(Number(l.share_percent))}%` },
    { title: 'Amount', render: (l) => `<strong>${money(l.amount)}</strong>` },
    { title: 'Payment', render: (l) => `${pill(l.paid_status)}${l.payout_reference ? `<br /><small>${esc(l.payout_reference)}</small>` : ''}` }
  ], lines, 'No royalties yet. They appear here after the Government approves a distribution run.');
}

document.querySelector('#printStatementBtn').addEventListener('click', () => {
  if (!statementLines.length) { toast('There is nothing to print yet.', true); return; }
  const total = statementLines.reduce((sum, l) => sum + Number(l.amount), 0);
  const rows = statementLines.map((l) => `<tr><td>${esc(l.period)}</td><td>${esc(l.work_title)}</td><td>${esc(l.licensee_name || '')}</td>
    <td>${esc(new Date(l.played_at).toLocaleString('en-GB'))}</td><td>${label(l.source)}</td><td>${esc(Number(l.share_percent))}%</td>
    <td>${money(l.amount)}</td><td>${label(l.paid_status)} ${esc(l.payout_reference || '')}</td></tr>`).join('');
  UIWidgets.printDocument(`Royalty statement — ${session.user.name}`, `
    <p>Rights holder: <strong>${esc(session.user.name)}</strong> (${esc(session.user.email)})<br />Total on this statement: <strong>${money(total)}</strong></p>
    <table><thead><tr><th>Period</th><th>Song</th><th>Music user</th><th>Played</th><th>Detected by</th><th>Share</th><th>Amount</th><th>Payment</th></tr></thead>
    <tbody>${rows}</tbody></table>`);
});

document.querySelector('#exportStatementBtn').addEventListener('click', () => {
  UI.downloadCsv('royalty-statement.csv',
    ['Period', 'Run', 'Song', 'ISRC', 'Licensee', 'Played at', 'Source', 'Play value (Rwf)', 'Share %', 'Amount (Rwf)', 'Status', 'Payout reference'],
    statementLines.map((l) => [l.period, l.run_id, l.work_title, l.isrc, l.licensee_name, l.played_at, l.source, l.usage_value, l.share_percent, l.amount, l.paid_status, l.payout_reference]));
});

// --- Unclaimed plays & claims ----------------------------------------------------------
let unclaimedRows = [];
async function loadUnclaimed() {
  const [{ usage }, { claims }] = await Promise.all([api('/api/public/unclaimed'), api('/api/rightsholder/claims')]);
  unclaimedRows = usage;
  table('#unclaimedTable', [
    { title: 'Reported title', render: (u) => `<strong>${esc(u.raw_title || '—')}</strong><br /><small>${esc(u.raw_artist || '')} ${esc(u.isrc || '')}</small>` },
    { title: 'Where', render: (u) => `${esc(u.licensee_name || '—')}<br /><small>${label(u.category)} · ${label(u.source)}</small>` },
    { title: 'When', render: (u) => dateTime(u.played_at) },
    { title: '', render: (u) => `<button class="action-btn secondary" type="button" data-action="claim" data-id="${esc(u.id)}">This is mine</button>` }
  ], usage, 'No unclaimed plays right now.');
  table('#claimsTable', [
    { title: 'Play', render: (c) => `${esc(c.raw_title || '—')}<br /><small>${dateTime(c.played_at)}</small>` },
    { title: 'Claimed as', render: (c) => esc(c.recording_title) },
    { title: 'Submitted', render: (c) => date(c.created_at) },
    { title: 'Status', render: (c) => pill(c.status) }
  ], claims, 'You have not made any claims.');
}

async function openClaim(usageId) {
  const usage = unclaimedRows.find((u) => u.id === usageId);
  const { recordings } = await api('/api/rightsholder/my-recordings');
  if (!recordings.length) { toast('Register your work first, then claim the play.', true); return; }
  const form = document.querySelector('#claimForm');
  form.reset();
  form.elements.usageId.value = usageId;
  document.querySelector('#claimPlay').textContent = usage ? `"${usage.raw_title}" by ${usage.raw_artist || 'unknown'} on ${usage.licensee_name || 'unknown'}, ${new Date(usage.played_at).toLocaleString('en-GB')}` : '';
  document.querySelector('#claimRecording').innerHTML = recordings.map((r) => `<option value="${esc(r.id)}">${esc(r.title)} (${esc(r.isrc || 'no ISRC')})</option>`).join('');
  UI.openModal('claimModal');
}

document.querySelector('#claimForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/rightsholder/claims', { form: new FormData(event.target) });
    toast(result.message);
    UI.closeModal('claimModal');
    loadUnclaimed();
  } catch (error) { toast(error.message, true); }
});

// --- Disputes -----------------------------------------------------------------------------
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

// --- Profile ------------------------------------------------------------------------------
async function loadProfile() {
  const { profile } = await api('/api/rightsholder/profile');
  document.querySelector('#profileBox').innerHTML = `
    <div><span>Name</span><strong>${esc(profile.full_name)}</strong></div>
    <div><span>Type</span><strong>${label(profile.holder_type)}</strong></div>
    <div><span>IPI</span><strong>${esc(profile.ipi_number || '—')}</strong></div>
    <div><span>Payout</span><strong>${profile.payout_ref_last4 ? `${label(profile.payout_method)} •••• ${esc(profile.payout_ref_last4)}` : 'Not set — you cannot be paid until you add it'}</strong></div>`;
  const form = document.querySelector('#profileForm');
  form.elements.ipiNumber.value = profile.ipi_number || '';
  form.elements.payoutMethod.value = profile.payout_method || 'momo';
}

document.querySelector('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/rightsholder/profile', { method: 'PUT', body: UI.formData(event.target) });
    toast(result.message);
    event.target.elements.payoutRef.value = '';
    loadProfile();
  } catch (error) { toast(error.message, true); }
});

// -----------------------------------------------------------------------------
// Buttons inside tables
// -----------------------------------------------------------------------------
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'confirm' || action === 'reject') {
      if (action === 'reject' && !window.confirm('Reject this split? The person who registered the song will have to correct it.')) return;
      const result = await api(`/api/rightsholder/splits/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      toast(result.message);
      loadPendingSplits();
    } else if (action === 'claim') {
      await openClaim(id);
    }
  } catch (error) { toast(error.message, true); }
});

showApp();
