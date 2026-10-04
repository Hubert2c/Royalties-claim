"use strict";

var state = {
  token: localStorage.getItem('royalty_token') || '',
  user: JSON.parse(localStorage.getItem('royalty_user') || 'null'),
  claims: []
};
var elements = {
  authView: document.querySelector('#authView'),
  appView: document.querySelector('#appView'),
  loginForm: document.querySelector('#loginForm'),
  userName: document.querySelector('#userName'),
  userRole: document.querySelector('#userRole'),
  userAvatar: document.querySelector('#userAvatar'),
  totalClaims: document.querySelector('#totalClaims'),
  pendingClaims: document.querySelector('#pendingClaims'),
  approvedClaims: document.querySelector('#approvedClaims'),
  rejectedClaims: document.querySelector('#rejectedClaims'),
  claimsTableBody: document.querySelector('#claimsTableBody'),
  statusFilter: document.querySelector('#statusFilter'),
  claimModal: document.querySelector('#claimModal'),
  newClaimBtn: document.querySelector('#newClaimBtn'),
  closeModalBtn: document.querySelector('#closeModalBtn'),
  cancelModalBtn: document.querySelector('#cancelModalBtn'),
  claimForm: document.querySelector('#claimForm'),
  logoutBtn: document.querySelector('#logoutBtn')
};

function setAuthView() {
  var isLoggedIn = Boolean(state.token && state.user);
  elements.authView.classList.toggle('hidden', isLoggedIn);
  elements.appView.classList.toggle('hidden', !isLoggedIn);

  if (isLoggedIn) {
    var initials = state.user.name.split(' ').map(function (part) {
      return part[0];
    }).slice(0, 2).join('').toUpperCase();
    elements.userAvatar.textContent = initials;
    elements.userName.textContent = state.user.name;
    elements.userRole.textContent = "".concat(state.user.role.charAt(0).toUpperCase()).concat(state.user.role.slice(1));
  }
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(Number(value || 0));
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

function renderMetrics() {
  var pending = state.claims.filter(function (claim) {
    return claim.status === 'Pending';
  }).length;
  var approved = state.claims.filter(function (claim) {
    return claim.status === 'Approved';
  }).length;
  var rejected = state.claims.filter(function (claim) {
    return claim.status === 'Rejected';
  }).length;
  elements.totalClaims.textContent = state.claims.length;
  elements.pendingClaims.textContent = pending;
  elements.approvedClaims.textContent = approved;
  elements.rejectedClaims.textContent = rejected;
}

function renderClaims() {
  var filter = elements.statusFilter.value;
  var visibleClaims = filter === 'all' ? state.claims : state.claims.filter(function (claim) {
    return claim.status === filter;
  });
  elements.claimsTableBody.innerHTML = visibleClaims.map(function (claim) {
    var canReview = ['admin', 'reviewer'].includes(state.user.role);
    return "\n        <tr>\n          <td>".concat(claim.id, "</td>\n          <td>").concat(claim.artist, "</td>\n          <td>").concat(claim.track, "</td>\n          <td>").concat(formatCurrency(claim.amount), "</td>\n          <td><span class=\"status-pill ").concat(statusClass(claim.status), "\">").concat(claim.status, "</span></td>\n          <td>").concat(claim.submitted_date || claim.submittedDate, "</td>\n          <td>\n            ").concat(canReview ? "\n              <button class=\"action-btn approve\" data-action=\"approve\" data-id=\"".concat(claim.id, "\">Approve</button>\n              <button class=\"action-btn reject\" data-action=\"reject\" data-id=\"").concat(claim.id, "\">Reject</button>\n            ") : '<span class="muted-label">View only</span>', "\n          </td>\n        </tr>\n      ");
  }).join('');
}

function fetchClaims() {
  var response, data;
  return regeneratorRuntime.async(function fetchClaims$(_context) {
    while (1) {
      switch (_context.prev = _context.next) {
        case 0:
          if (state.token) {
            _context.next = 2;
            break;
          }

          return _context.abrupt("return");

        case 2:
          _context.prev = 2;
          _context.next = 5;
          return regeneratorRuntime.awrap(fetch('http://localhost:3001/api/claims', {
            headers: {
              Authorization: "Bearer ".concat(state.token)
            }
          }));

        case 5:
          response = _context.sent;

          if (response.ok) {
            _context.next = 8;
            break;
          }

          throw new Error('Failed to load claims');

        case 8:
          _context.next = 10;
          return regeneratorRuntime.awrap(response.json());

        case 10:
          data = _context.sent;
          state.claims = data.claims || [];
          renderMetrics();
          renderClaims();
          _context.next = 20;
          break;

        case 16:
          _context.prev = 16;
          _context.t0 = _context["catch"](2);
          console.error(_context.t0);
          alert('Unable to load claims. Please try again.');

        case 20:
        case "end":
          return _context.stop();
      }
    }
  }, null, null, [[2, 16]]);
}

function loginUser(email, password) {
  var response, data;
  return regeneratorRuntime.async(function loginUser$(_context2) {
    while (1) {
      switch (_context2.prev = _context2.next) {
        case 0:
          _context2.next = 2;
          return regeneratorRuntime.awrap(fetch('http://localhost:3001/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              email: email,
              password: password
            })
          }));

        case 2:
          response = _context2.sent;
          _context2.next = 5;
          return regeneratorRuntime.awrap(response.json());

        case 5:
          data = _context2.sent;

          if (response.ok) {
            _context2.next = 8;
            break;
          }

          throw new Error(data.message || 'Login failed.');

        case 8:
          state.token = data.token;
          state.user = data.user;
          localStorage.setItem('royalty_token', state.token);
          localStorage.setItem('royalty_user', JSON.stringify(state.user));
          setAuthView();
          fetchClaims();

        case 14:
        case "end":
          return _context2.stop();
      }
    }
  });
}

function logout() {
  state.token = '';
  state.user = null;
  state.claims = [];
  localStorage.removeItem('royalty_token');
  localStorage.removeItem('royalty_user');
  setAuthView();
  renderClaims();
}

function handleStatusUpdate(id, status) {
  var response, data;
  return regeneratorRuntime.async(function handleStatusUpdate$(_context3) {
    while (1) {
      switch (_context3.prev = _context3.next) {
        case 0:
          _context3.next = 2;
          return regeneratorRuntime.awrap(fetch("http://localhost:3001/api/claims/".concat(id, "/status"), {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: "Bearer ".concat(state.token)
            },
            body: JSON.stringify({
              status: status
            })
          }));

        case 2:
          response = _context3.sent;
          _context3.next = 5;
          return regeneratorRuntime.awrap(response.json());

        case 5:
          data = _context3.sent;

          if (response.ok) {
            _context3.next = 8;
            break;
          }

          throw new Error(data.message || 'Unable to update claim status.');

        case 8:
          _context3.next = 10;
          return regeneratorRuntime.awrap(fetchClaims());

        case 10:
        case "end":
          return _context3.stop();
      }
    }
  });
}

function submitNewClaim(event) {
  var formData, payload, requestData, file, response, data;
  return regeneratorRuntime.async(function submitNewClaim$(_context4) {
    while (1) {
      switch (_context4.prev = _context4.next) {
        case 0:
          event.preventDefault();
          formData = new FormData(elements.claimForm);
          payload = {
            artist: formData.get('artist'),
            track: formData.get('track'),
            amount: formData.get('amount'),
            submittedDate: formData.get('submittedDate'),
            notes: formData.get('notes')
          };

          if (!(!payload.artist || !payload.track || !payload.amount || !payload.submittedDate)) {
            _context4.next = 6;
            break;
          }

          alert('Please complete all required claim fields.');
          return _context4.abrupt("return");

        case 6:
          requestData = new FormData();
          requestData.append('artist', payload.artist);
          requestData.append('track', payload.track);
          requestData.append('amount', payload.amount);
          requestData.append('submittedDate', payload.submittedDate);
          requestData.append('notes', payload.notes || '');
          file = formData.get('file');

          if (file && file.name) {
            requestData.append('file', file);
          }

          _context4.prev = 14;
          _context4.next = 17;
          return regeneratorRuntime.awrap(fetch('http://localhost:3001/api/claims', {
            method: 'POST',
            headers: {
              Authorization: "Bearer ".concat(state.token)
            },
            body: requestData
          }));

        case 17:
          response = _context4.sent;
          _context4.next = 20;
          return regeneratorRuntime.awrap(response.json());

        case 20:
          data = _context4.sent;

          if (response.ok) {
            _context4.next = 23;
            break;
          }

          throw new Error(data.message || 'Claim could not be submitted.');

        case 23:
          elements.claimForm.reset();
          elements.claimModal.classList.add('hidden');
          _context4.next = 27;
          return regeneratorRuntime.awrap(fetchClaims());

        case 27:
          _context4.next = 32;
          break;

        case 29:
          _context4.prev = 29;
          _context4.t0 = _context4["catch"](14);
          alert(_context4.t0.message);

        case 32:
        case "end":
          return _context4.stop();
      }
    }
  }, null, null, [[14, 29]]);
}

elements.loginForm.addEventListener('submit', function _callee(event) {
  var email, password;
  return regeneratorRuntime.async(function _callee$(_context5) {
    while (1) {
      switch (_context5.prev = _context5.next) {
        case 0:
          event.preventDefault();
          email = document.querySelector('#loginEmail').value.trim();
          password = document.querySelector('#loginPassword').value;
          _context5.prev = 3;
          _context5.next = 6;
          return regeneratorRuntime.awrap(loginUser(email, password));

        case 6:
          _context5.next = 11;
          break;

        case 8:
          _context5.prev = 8;
          _context5.t0 = _context5["catch"](3);
          alert(_context5.t0.message);

        case 11:
        case "end":
          return _context5.stop();
      }
    }
  }, null, null, [[3, 8]]);
});
elements.statusFilter.addEventListener('change', renderClaims);
elements.newClaimBtn.addEventListener('click', function () {
  elements.claimModal.classList.remove('hidden');
});
elements.closeModalBtn.addEventListener('click', function () {
  elements.claimModal.classList.add('hidden');
});
elements.cancelModalBtn.addEventListener('click', function () {
  elements.claimModal.classList.add('hidden');
});
elements.claimModal.addEventListener('click', function (event) {
  if (event.target === elements.claimModal) {
    elements.claimModal.classList.add('hidden');
  }
});
elements.claimForm.addEventListener('submit', submitNewClaim);
document.addEventListener('click', function _callee2(event) {
  var actionButton, id, action;
  return regeneratorRuntime.async(function _callee2$(_context6) {
    while (1) {
      switch (_context6.prev = _context6.next) {
        case 0:
          actionButton = event.target.closest('[data-action]');

          if (actionButton) {
            _context6.next = 3;
            break;
          }

          return _context6.abrupt("return");

        case 3:
          id = actionButton.dataset.id;
          action = actionButton.dataset.action;
          _context6.prev = 5;
          _context6.next = 8;
          return regeneratorRuntime.awrap(handleStatusUpdate(id, action === 'approve' ? 'Approved' : 'Rejected'));

        case 8:
          _context6.next = 13;
          break;

        case 10:
          _context6.prev = 10;
          _context6.t0 = _context6["catch"](5);
          alert(_context6.t0.message);

        case 13:
        case "end":
          return _context6.stop();
      }
    }
  }, null, null, [[5, 10]]);
});
elements.logoutBtn.addEventListener('click', logout);

if (state.token && state.user) {
  setAuthView();
  fetchClaims();
} else {
  setAuthView();
}
//# sourceMappingURL=app.dev.js.map
