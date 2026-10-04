const state = {
  token: localStorage.getItem('royalty_token') || '',
  user: JSON.parse(localStorage.getItem('royalty_user') || 'null'),
  claims: []
};

const elements = {
  authView: document.querySelector('#authView'),
  appView: document.querySelector('#appView'),
  loginForm: document.querySelector('#loginForm'),
  adminLoginForm: document.querySelector('#adminLoginForm'),
  registerForm: document.querySelector('#registerForm'),
  authTabs: document.querySelectorAll('.auth-tab'),
  loginPanel: document.querySelector('#loginPanel'),
  registerPanel: document.querySelector('#registerPanel'),
  userName: document.querySelector('#userName'),
  userRole: document.querySelector('#userRole'),
  userAvatar: document.querySelector('#userAvatar'),
  totalClaims: document.querySelector('#totalClaims'),
  pendingClaims: document.querySelector('#pendingClaims'),
  approvedClaims: document.querySelector('#approvedClaims'),
  rejectedClaims: document.querySelector('#rejectedClaims'),
  avgClaimValue: document.querySelector('#avgClaimValue'),
  topClaimValue: document.querySelector('#topClaimValue'),
  approvalRateValue: document.querySelector('#approvalRateValue'),
  claimsTableBody: document.querySelector('#claimsTableBody'),
  statusFilter: document.querySelector('#statusFilter'),
  searchInput: document.querySelector('#searchInput'),
  sortFilter: document.querySelector('#sortFilter'),
  claimModal: document.querySelector('#claimModal'),
  detailModal: document.querySelector('#detailModal'),
  claimDetailContent: document.querySelector('#claimDetailContent'),
  closeDetailBtn: document.querySelector('#closeDetailBtn'),
  newClaimBtn: document.querySelector('#newClaimBtn'),
  closeModalBtn: document.querySelector('#closeModalBtn'),
  cancelModalBtn: document.querySelector('#cancelModalBtn'),
  claimForm: document.querySelector('#claimForm'),
  logoutBtn: document.querySelector('#logoutBtn'),
  exportBtn: document.querySelector('#exportBtn'),
  toast: document.querySelector('#toast'),
  navItems: document.querySelectorAll('.nav-item'),
  activityFeed: document.querySelector('#activityFeed'),
  views: {
    dashboard: document.querySelector('#dashboardView'),
    claims: document.querySelector('#claimsView'),
    payments: document.querySelector('#paymentsView'),
    reports: document.querySelector('#reportsView'),
    settings: document.querySelector('#settingsView')
  },
  newClaimBtnSecondary: document.querySelector('#newClaimBtnSecondary')
};

function showView(viewName) {
  Object.entries(elements.views).forEach(([key, section]) => {
    if (!section) return;
    section.classList.toggle('hidden', key !== viewName);
  });

  elements.navItems.forEach((button) => {
    const isActive = button.dataset.view === viewName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-current', isActive ? 'page' : 'false');
  });
}

function showAuthPanel(panelType) {
  const isLogin = panelType === 'login';
  if (elements.loginPanel) {
    elements.loginPanel.classList.toggle('hidden', !isLogin);
  }
  if (elements.registerPanel) {
    elements.registerPanel.classList.toggle('hidden', isLogin);
  }

  elements.authTabs.forEach((tab) => {
    const isActive = tab.dataset.authPanel === panelType;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-pressed', String(isActive));
  });
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  elements.toast.style.borderLeft = isError ? '4px solid #e74c3c' : '4px solid #22c55e';
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 2800);
}

function setAuthView() {
  const isLoggedIn = Boolean(state.token && state.user);
  elements.authView.classList.toggle('hidden', isLoggedIn);
  elements.appView.classList.toggle('hidden', !isLoggedIn);

  if (isLoggedIn) {
    const initials = state.user.name
      .split(' ')
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();

    elements.userAvatar.textContent = initials;
    elements.userName.textContent = state.user.name;
    elements.userRole.textContent = `${state.user.role.charAt(0).toUpperCase()}${state.user.role.slice(1)}`;
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function statusClass(status) {
  switch (status) {
    case 'Approved':
      return 'status-approved';
    case 'Rejected':
      return 'status-rejected';
    default:
      return 'status-pending';
  }
}

function getVisibleClaims() {
  const selectedStatus = elements.statusFilter.value;
  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const sortMode = elements.sortFilter.value;

  let filtered = [...state.claims];

  if (selectedStatus !== 'all') {
    filtered = filtered.filter((claim) => claim.status === selectedStatus);
  }

  if (searchTerm) {
    filtered = filtered.filter((claim) => {
      const haystack = [
        claim.id,
        claim.artist,
        claim.track,
        claim.status,
        claim.notes || ''
      ].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    });
  }

  switch (sortMode) {
    case 'oldest':
      filtered.sort((a, b) => new Date(a.created_at || a.submitted_date) - new Date(b.created_at || b.submitted_date));
      break;
    case 'highest':
      filtered.sort((a, b) => Number(b.amount) - Number(a.amount));
      break;
    case 'lowest':
      filtered.sort((a, b) => Number(a.amount) - Number(b.amount));
      break;
    case 'newest':
    default:
      filtered.sort((a, b) => new Date(b.created_at || b.submitted_date) - new Date(a.created_at || a.submitted_date));
      break;
  }

  return filtered;
}

function renderMetrics() {
  const pending = state.claims.filter((claim) => claim.status === 'Pending').length;
  const approved = state.claims.filter((claim) => claim.status === 'Approved').length;
  const rejected = state.claims.filter((claim) => claim.status === 'Rejected').length;
  const total = state.claims.length;
  const amounts = state.claims.map((claim) => Number(claim.amount || 0));
  const average = amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length : 0;
  const largest = amounts.length ? Math.max(...amounts) : 0;
  const approvalRate = total ? (approved / total) * 100 : 0;

  elements.totalClaims.textContent = total;
  elements.pendingClaims.textContent = pending;
  elements.approvedClaims.textContent = approved;
  elements.rejectedClaims.textContent = rejected;
  elements.avgClaimValue.textContent = formatCurrency(average);
  elements.topClaimValue.textContent = formatCurrency(largest);
  elements.approvalRateValue.textContent = `${approvalRate.toFixed(0)}%`;

  const openCases = state.claims.filter((claim) => claim.status === 'Pending').length;
  const reviewedThisWeek = state.claims.filter((claim) => claim.status !== 'Pending').length;
  const reviewValueTotal = state.claims
    .filter((claim) => claim.status === 'Pending')
    .reduce((sum, claim) => sum + Number(claim.amount || 0), 0);

  const openCasesValue = document.querySelector('#openCasesValue');
  const reviewedWeekValue = document.querySelector('#reviewedWeekValue');
  const reviewValueTotalEl = document.querySelector('#reviewValueTotal');

  if (openCasesValue) openCasesValue.textContent = openCases;
  if (reviewedWeekValue) reviewedWeekValue.textContent = reviewedThisWeek;
  if (reviewValueTotalEl) reviewValueTotalEl.textContent = formatCurrency(reviewValueTotal);

  renderActivityFeed();
}

function renderActivityFeed() {
  if (!elements.activityFeed) return;

  const latest = [...state.claims]
    .sort((a, b) => new Date(b.created_at || b.submitted_date) - new Date(a.created_at || a.submitted_date))
    .slice(0, 4);

  elements.activityFeed.innerHTML = latest
    .map((claim) => `
      <div class="activity-item">
        <div class="activity-meta">
          <span class="activity-dot" aria-hidden="true"></span>
          <div>
            <strong>${claim.artist}</strong><br />
            <small>${claim.track} • ${claim.status}</small>
          </div>
        </div>
        <small>${formatDate(claim.submitted_date || claim.created_at)}</small>
      </div>
    `)
    .join('');
}

function renderClaims() {
  const visibleClaims = getVisibleClaims();
  const canReview = ['admin', 'reviewer'].includes(state.user?.role);

  if (!visibleClaims.length) {
    elements.claimsTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">No claims match the current filters.</td>
      </tr>
    `;
    return;
  }

  elements.claimsTableBody.innerHTML = visibleClaims
    .map((claim) => {
      return `
        <tr>
          <td><button class="table-link" type="button" data-detail-id="${claim.id}">${claim.id}</button></td>
          <td>${claim.artist}</td>
          <td>${claim.track}</td>
          <td>${formatCurrency(claim.amount)}</td>
          <td><span class="status-pill ${statusClass(claim.status)}">${claim.status}</span></td>
          <td>${formatDate(claim.submitted_date || claim.submittedDate || claim.created_at)}</td>
          <td>
            <button class="action-btn secondary" type="button" data-detail-id="${claim.id}">View</button>
            ${canReview ? `
              <button class="action-btn approve" data-action="approve" data-id="${claim.id}">Approve</button>
              <button class="action-btn reject" data-action="reject" data-id="${claim.id}">Reject</button>
            ` : ''}
          </td>
        </tr>
      `;
    })
    .join('');
}

async function fetchClaims() {
  if (!state.token) return;

  try {
    const response = await fetch('http://localhost:3001/api/claims', {
      headers: {
        Authorization: `Bearer ${state.token}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to load claims');
    }

    const data = await response.json();
    state.claims = data.claims || [];
    renderMetrics();
    renderClaims();
  } catch (error) {
    console.error(error);
    showToast('Unable to load claims. Please try again.', true);
  }
}

async function loginUser(email, password) {
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '');

  if (!trimmedEmail || !trimmedPassword) {
    throw new Error('Email and password are required.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    throw new Error('Please enter a valid email address.');
  }

  if (trimmedPassword.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const response = await fetch('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'Login failed.');
  }

  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('royalty_token', state.token);
  localStorage.setItem('royalty_user', JSON.stringify(state.user));
  setAuthView();
  showView('dashboard');
  await fetchClaims();
  showToast('Login successful.');
}

async function registerUser(name, email, password, role = 'claimant') {
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '');

  if (!trimmedName) {
    throw new Error('Please enter your full name.');
  }

  if (!trimmedEmail || !trimmedPassword) {
    throw new Error('Email and password are required.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    throw new Error('Please enter a valid email address.');
  }

  if (trimmedPassword.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const response = await fetch('http://localhost:3001/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: trimmedName,
      email: trimmedEmail,
      password: trimmedPassword,
      role
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'Registration failed.');
  }

  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('royalty_token', state.token);
  localStorage.setItem('royalty_user', JSON.stringify(state.user));
  setAuthView();
  showView('dashboard');
  await fetchClaims();
  showToast('Artist account created successfully.');
}

function logout() {
  state.token = '';
  state.user = null;
  state.claims = [];
  localStorage.removeItem('royalty_token');
  localStorage.removeItem('royalty_user');
  setAuthView();
  renderClaims();
  showToast('You have been logged out.');
}

function exportClaims() {
  const rows = [...state.claims].map((claim) => [
    claim.id,
    claim.artist,
    claim.track,
    claim.amount,
    claim.status,
    claim.submitted_date || claim.created_at
  ]);

  const csv = [
    ['Claim ID', 'Artist', 'Track', 'Amount', 'Status', 'Submitted'],
    ...rows
  ]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'royalty-claims-export.csv';
  link.click();
  URL.revokeObjectURL(url);
  showToast('Claim export downloaded.');
}

async function handleStatusUpdate(id, status) {
  const response = await fetch(`http://localhost:3001/api/claims/${id}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`
    },
    body: JSON.stringify({ status })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'Unable to update claim status.');
  }

  showToast(`Claim marked as ${status}.`);
  await fetchClaims();
}

async function openClaimDetail(claimId) {
  const claim = state.claims.find((item) => item.id === claimId);
  if (!claim) {
    showToast('Claim details are not available right now.', true);
    return;
  }

  const fileLink = claim.file_name
    ? `<p><strong>Attachment:</strong> <a href="http://localhost:3001/uploads/${encodeURIComponent(claim.file_name)}" target="_blank" rel="noreferrer">Open file</a></p>`
    : '<p><strong>Attachment:</strong> No supporting document uploaded.</p>';

  elements.claimDetailContent.innerHTML = `
    <div class="claim-summary">
      <div class="detail-box">
        <h4>Claim summary</h4>
        <p><strong>ID:</strong> ${claim.id}</p>
        <p><strong>Artist:</strong> ${claim.artist}</p>
        <p><strong>Track:</strong> ${claim.track}</p>
        <p><strong>Amount:</strong> ${formatCurrency(claim.amount)}</p>
      </div>
      <div class="detail-box">
        <h4>Status</h4>
        <p><span class="status-pill ${statusClass(claim.status)}">${claim.status}</span></p>
        <p><strong>Submitted:</strong> ${formatDate(claim.submitted_date || claim.created_at)}</p>
        <p><strong>Created:</strong> ${formatDate(claim.created_at)}</p>
      </div>
    </div>

    <div class="detail-box">
      <h4>Claim notes</h4>
      <p>${claim.notes ? claim.notes : 'No additional notes were provided.'}</p>
    </div>

    <div class="detail-box">
      <h4>Supporting documentation</h4>
      ${fileLink}
    </div>
  `;

  elements.detailModal.classList.remove('hidden');
}

async function submitNewClaim(event) {
  event.preventDefault();

  const formData = new FormData(elements.claimForm);
  const payload = {
    artist: formData.get('artist')?.toString().trim(),
    track: formData.get('track')?.toString().trim(),
    amount: Number(formData.get('amount')),
    submittedDate: formData.get('submittedDate')?.toString(),
    notes: formData.get('notes')?.toString().trim() || ''
  };

  if (!payload.artist || !payload.track || !payload.submittedDate) {
    showToast('Please complete all required claim fields.', true);
    return;
  }

  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    showToast('Claim amount must be greater than zero.', true);
    return;
  }

  const submittedDate = new Date(payload.submittedDate);
  const today = new Date();
  if (submittedDate > today) {
    showToast('Submission date cannot be in the future.', true);
    return;
  }

  const requestData = new FormData();
  requestData.append('artist', payload.artist);
  requestData.append('track', payload.track);
  requestData.append('amount', String(payload.amount));
  requestData.append('submittedDate', payload.submittedDate);
  requestData.append('notes', payload.notes);

  const file = formData.get('file');
  if (file && file.name) {
    requestData.append('file', file);
  }

  try {
    const response = await fetch('http://localhost:3001/api/claims', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`
      },
      body: requestData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || 'Claim could not be submitted.');
    }

    elements.claimForm.reset();
    elements.claimModal.classList.add('hidden');
    await fetchClaims();
    showToast('Claim submitted successfully.');
  } catch (error) {
    showToast(error.message || 'Claim could not be submitted.', true);
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.querySelector('#loginEmail').value;
  const password = document.querySelector('#loginPassword').value;

  try {
    await loginUser(email, password);
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.adminLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.querySelector('#adminLoginEmail').value;
  const password = document.querySelector('#adminLoginPassword').value;

  try {
    await loginUser(email, password);
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#registerName').value;
  const email = document.querySelector('#registerEmail').value;
  const password = document.querySelector('#registerPassword').value;
  const role = document.querySelector('#registerRole').value;

  try {
    await registerUser(name, email, password, role);
    elements.registerForm.reset();
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.authTabs.forEach((tab) => {
  tab.addEventListener('click', () => showAuthPanel(tab.dataset.authPanel));
});

elements.statusFilter.addEventListener('change', renderClaims);
elements.searchInput.addEventListener('input', renderClaims);
elements.sortFilter.addEventListener('change', renderClaims);

elements.navItems.forEach((button) => {
  button.addEventListener('click', () => {
    showView(button.dataset.view);
  });
});

elements.newClaimBtn.addEventListener('click', () => {
  elements.claimModal.classList.remove('hidden');
});

elements.exportBtn.addEventListener('click', exportClaims);

elements.newClaimBtnSecondary.addEventListener('click', () => {
  elements.claimModal.classList.remove('hidden');
});

elements.closeModalBtn.addEventListener('click', () => {
  elements.claimModal.classList.add('hidden');
});

elements.cancelModalBtn.addEventListener('click', () => {
  elements.claimModal.classList.add('hidden');
});

elements.closeDetailBtn.addEventListener('click', () => {
  elements.detailModal.classList.add('hidden');
});

elements.claimModal.addEventListener('click', (event) => {
  if (event.target === elements.claimModal) {
    elements.claimModal.classList.add('hidden');
  }
});

elements.detailModal.addEventListener('click', (event) => {
  if (event.target === elements.detailModal) {
    elements.detailModal.classList.add('hidden');
  }
});

elements.claimForm.addEventListener('submit', submitNewClaim);

document.addEventListener('click', async (event) => {
  const detailButton = event.target.closest('[data-detail-id]');
  if (detailButton) {
    openClaimDetail(detailButton.dataset.detailId);
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;

  const id = actionButton.dataset.id;
  const action = actionButton.dataset.action;

  try {
    await handleStatusUpdate(id, action === 'approve' ? 'Approved' : 'Rejected');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.logoutBtn.addEventListener('click', logout);

if (state.token && state.user) {
  setAuthView();
  showView('dashboard');
  fetchClaims();
} else {
  setAuthView();
  showView('dashboard');
}
