const state = {
  token: localStorage.getItem('royalty_token') || '',
  user: JSON.parse(localStorage.getItem('royalty_user') || 'null'),
  claims: []
};

const elements = {
  authView: document.querySelector('#authView'),
  dashboardView: document.querySelector('#dashboardView'),
  loginForm: document.querySelector('#loginForm'),
  registerForm: document.querySelector('#registerForm'),
  claimForm: document.querySelector('#claimForm'),
  totalClaims: document.querySelector('#totalClaims'),
  pendingClaims: document.querySelector('#pendingClaims'),
  approvedClaims: document.querySelector('#approvedClaims'),
  welcomeName: document.querySelector('#welcomeName'),
  claimsList: document.querySelector('#claimsList'),
  logoutBtn: document.querySelector('#logoutBtn'),
  toast: document.querySelector('#toast'),
  tabs: document.querySelectorAll('.tab'),
  loginSection: document.querySelector('#loginSection'),
  registerSection: document.querySelector('#registerSection')
};

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  elements.toast.style.background = isError ? '#991b1b' : '#111827';
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 2600);
}

function setView() {
  const isLoggedIn = Boolean(state.token && state.user);
  elements.authView.classList.toggle('hidden', isLoggedIn);
  elements.dashboardView.classList.toggle('hidden', !isLoggedIn);
  elements.logoutBtn.classList.toggle('hidden', !isLoggedIn);

  if (isLoggedIn) {
    elements.welcomeName.textContent = `Welcome, ${state.user.name}`;
    fetchClaims();
  }
}

function showAuthPanel(panel) {
  const isLogin = panel === 'login';
  elements.loginSection.classList.toggle('hidden', !isLogin);
  elements.registerSection.classList.toggle('hidden', isLogin);
  elements.tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === panel);
  });
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
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function statusClass(status) {
  if (status === 'Approved') return 'status-approved';
  if (status === 'Rejected') return 'status-rejected';
  return 'status-pending';
}

async function loginUser(email, password) {
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '');

  if (!trimmedEmail || !trimmedPassword) {
    throw new Error('Email and password are required.');
  }

  const response = await fetch('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  setView();
  showToast('Login successful.');
}

async function registerUser(name, email, password) {
  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim();
  const trimmedPassword = String(password || '');

  if (!trimmedName || !trimmedEmail || !trimmedPassword) {
    throw new Error('Please complete all registration fields.');
  }

  const response = await fetch('http://localhost:3001/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: trimmedName,
      email: trimmedEmail,
      password: trimmedPassword,
      role: 'claimant'
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
  setView();
  showToast('Artist account created.');
}

async function fetchClaims() {
  if (!state.token) return;

  try {
    const response = await fetch('http://localhost:3001/api/claims', {
      headers: { Authorization: `Bearer ${state.token}` }
    });

    if (!response.ok) {
      throw new Error('Unable to load claims.');
    }

    const data = await response.json();
    state.claims = data.claims || [];
    renderStats();
    renderList();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderStats() {
  const total = state.claims.length;
  const pending = state.claims.filter((claim) => claim.status === 'Pending').length;
  const approved = state.claims.filter((claim) => claim.status === 'Approved').length;

  elements.totalClaims.textContent = total;
  elements.pendingClaims.textContent = pending;
  elements.approvedClaims.textContent = approved;
}

function renderList() {
  if (!state.claims.length) {
    elements.claimsList.innerHTML = '<li><div class="claim-meta">You have not submitted any claims yet.</div></li>';
    return;
  }

  elements.claimsList.innerHTML = state.claims
    .map((claim) => `
      <li>
        <div class="claim-top">
          <strong>${claim.track}</strong>
          <span class="status-pill ${statusClass(claim.status)}">${claim.status}</span>
        </div>
        <div class="claim-meta">${claim.artist} • ${formatCurrency(claim.amount)}</div>
        <div class="claim-meta">Submitted ${formatDate(claim.submitted_date || claim.created_at)}</div>
      </li>
    `)
    .join('');
}

async function submitClaim(event) {
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
    showToast('Please fill in all required claim details.', true);
    return;
  }

  const requestData = new FormData();
  requestData.append('artist', payload.artist);
  requestData.append('track', payload.track);
  requestData.append('amount', String(payload.amount));
  requestData.append('submittedDate', payload.submittedDate);
  requestData.append('notes', payload.notes);

  const file = formData.get('file');
  if (file && file.name) requestData.append('file', file);

  try {
    const response = await fetch('http://localhost:3001/api/claims', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: requestData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || 'Unable to submit claim.');
    }

    elements.claimForm.reset();
    await fetchClaims();
    showToast('Claim submitted successfully.');
  } catch (error) {
    showToast(error.message, true);
  }
}

function logout() {
  state.token = '';
  state.user = null;
  state.claims = [];
  localStorage.removeItem('royalty_token');
  localStorage.removeItem('royalty_user');
  setView();
  showToast('You have been logged out.');
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

elements.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#registerName').value;
  const email = document.querySelector('#registerEmail').value;
  const password = document.querySelector('#registerPassword').value;

  try {
    await registerUser(name, email, password);
    elements.registerForm.reset();
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.claimForm.addEventListener('submit', submitClaim);
elements.logoutBtn.addEventListener('click', logout);
elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => showAuthPanel(tab.dataset.panel));
});

showAuthPanel('login');
setView();
