// =============================================================================
// shared/ui.js — small helpers shared by all portals (no framework needed)
// -----------------------------------------------------------------------------
// Provides window.UI with:
//   UI.apiBase            where the API lives (same server, or :3001 when a
//                         portal is opened on its own port 8000 / 3002)
//   UI.session(portal)    remember/forget the login for one portal
//   UI.api(path, opts)    call the API and get JSON back (throws on errors)
//   UI.esc(text)          make text safe to put inside HTML (prevents XSS)
//   UI.money / date / dateTime / percent   formatting helpers
//   UI.pill(status)       a coloured status label
//   UI.table(...)         render a table from rows + column definitions
//   UI.toast(msg)         a short notification
//   UI.openModal / closeModal
//   UI.setupNav(...)      sidebar navigation between views
// =============================================================================
(function () {
  // --- Where is the API? ----------------------------------------------------------
  // When the artist portal runs on :8000 or the licensee portal on :3002, the API
  // is on :3001 of the same host. Otherwise (e.g. http://localhost:3001/artist or a
  // single deployed domain) the API is on the same origin.
  const separatePortalPorts = ['8000', '3002'];
  const apiBase = separatePortalPorts.includes(window.location.port)
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : '';

  // --- Login session per portal --------------------------------------------------
  function session(portal) {
    const keys = (window.PORTAL_STORAGE_KEYS || {})[portal] || { token: `royalty_${portal}_token`, user: `royalty_${portal}_user` };
    return {
      get token() { return localStorage.getItem(keys.token) || ''; },
      get user() {
        try { return JSON.parse(localStorage.getItem(keys.user) || 'null'); } catch (e) { return null; }
      },
      save(token, user) {
        localStorage.setItem(keys.token, token);
        localStorage.setItem(keys.user, JSON.stringify(user));
      },
      clear() {
        localStorage.removeItem(keys.token);
        localStorage.removeItem(keys.user);
      }
    };
  }

  // --- API calls ------------------------------------------------------------------
  // options: { method, body (object -> JSON), form (FormData), token, onUnauthorized }
  async function api(path, options = {}) {
    const headers = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body;
    if (options.form) body = options.form;                       // browser sets the multipart header
    else if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.body); }

    let response;
    try {
      response = await fetch(`${apiBase}${path}`, { method: options.method || (body ? 'POST' : 'GET'), headers, body });
    } catch (networkError) {
      throw new Error('Cannot reach the server. Is it running on port 3001?');
    }

    let data = {};
    try { data = await response.json(); } catch (e) { /* not JSON (e.g. a file) */ }

    if (response.status === 401 && options.onUnauthorized) options.onUnauthorized();
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status}).`);
    return data;
  }

  // Download a file from an authenticated endpoint (opens it in a new tab).
  async function download(path, token) {
    const response = await fetch(`${apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('File could not be downloaded.');
    const url = URL.createObjectURL(await response.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // --- Formatting -------------------------------------------------------------------
  // ALWAYS pass user-provided text through esc() before inserting it into HTML.
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const money = (value) => `Rwf ${Math.round(Number(value || 0)).toLocaleString('en-US')}`;
  const percent = (value, digits = 0) => `${(Number(value || 0) * 100).toFixed(digits)}%`;
  function date(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function dateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const label = (value) => esc(String(value || '').replace(/_/g, ' '));

  // Colour for each status word used in the platform.
  const PILL_COLOURS = {
    good: ['approved', 'paid', 'confirmed', 'active', 'matched', 'resolved', 'compliant', 'valid'],
    warn: ['pending', 'applied', 'invoiced', 'draft', 'pending_splits', 'open', 'held', 'invoice_unpaid', 'no_licence'],
    bad: ['rejected', 'unmatched', 'cancelled', 'revoked', 'unlicensed_use', 'invalid', 'retired']
  };
  function pill(status) {
    const s = String(status || '');
    let tone = 'neutral';
    if (PILL_COLOURS.good.includes(s)) tone = 'approved';
    else if (PILL_COLOURS.warn.includes(s)) tone = 'pending';
    else if (PILL_COLOURS.bad.includes(s)) tone = 'rejected';
    return `<span class="status-pill status-${tone}">${label(s)}</span>`;
  }

  // Render a table.
  // columns: [{ title, render: (row) => html, className? }]
  function table(container, columns, rows, emptyText = 'Nothing to show yet.') {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!rows || !rows.length) {
      el.innerHTML = `<p class="empty-state">${esc(emptyText)}</p>`;
      return;
    }
    el.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr>${columns.map((c) => `<th>${esc(c.title)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td class="${c.className || ''}">${c.render(row)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
  }

  // --- Notifications and modals -----------------------------------------------------
  function toast(message, isError = false) {
    let el = document.querySelector('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast hidden';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.remove('hidden');
    el.classList.toggle('toast-error', isError);
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), isError ? 5000 : 3200);
  }

  function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
  function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

  // Close a modal when its × / Cancel button (data-close="modalId") or the dark backdrop is clicked.
  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close]');
    if (closer) closeModal(closer.dataset.close);
    if (event.target.classList && event.target.classList.contains('modal')) event.target.classList.add('hidden');
  });

  // Sidebar navigation: buttons with data-view="x" show <section id="view-x">.
  function setupNav(onShow) {
    const buttons = document.querySelectorAll('.nav-item[data-view]');
    function show(view) {
      document.querySelectorAll('.view-section').forEach((s) => s.classList.toggle('hidden', s.id !== `view-${view}`));
      buttons.forEach((b) => {
        const active = b.dataset.view === view;
        b.classList.toggle('active', active);
        b.setAttribute('aria-current', active ? 'page' : 'false');
      });
      const title = document.querySelector('#pageTitle');
      const activeButton = [...buttons].find((b) => b.dataset.view === view);
      if (title && activeButton) title.textContent = activeButton.textContent.trim();
      if (onShow) onShow(view);
    }
    buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
    return show;
  }

  // Turn rows into a CSV download (used for statements and exports).
  function downloadCsv(filename, header, rows) {
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell === null || cell === undefined ? '' : cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  // Read a <form> into a plain object.
  const formData = (form) => Object.fromEntries(new FormData(form).entries());

  const initials = (name) => String(name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  window.UI = {
    apiBase, session, api, download, esc, money, percent, date, dateTime, label, pill, table,
    toast, openModal, closeModal, setupNav, downloadCsv, formData, initials
  };
})();
