(function () {
  const TOKEN_KEY = 'inventoryToken';
  const SHOP_KEY = 'shopName';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SHOP_KEY);
  }

  function setShopName(name) {
    if (name) {
      localStorage.setItem(SHOP_KEY, name);
    }
  }

  function getShopName() {
    return localStorage.getItem(SHOP_KEY) || 'Inventory';
  }

  function isAuthPage() {
    const page = window.location.pathname.split('/').pop();
    return ['login.html', 'register.html', 'verify-otp.html'].includes(page);
  }

  function showMessage(targetId, message, type) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.textContent = message;
    el.className = `msg show ${type}`;
  }

  function clearMessage(targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.className = 'msg';
    el.textContent = '';
  }

  async function apiFetch(path, options = {}) {
    const {
      method = 'GET',
      body,
      auth = true,
      headers = {},
    } = options;

    const finalHeaders = { ...headers };

    if (auth) {
      const token = getToken();
      if (!token) {
        if (!isAuthPage()) {
          window.location.href = 'login.html';
        }
        throw new Error('Please login first.');
      }
      finalHeaders.Authorization = `Bearer ${token}`;
    }

    if (body !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(path, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }

    if (!response.ok) {
      if (response.status === 401 && auth) {
        clearToken();
        if (!isAuthPage()) {
          window.location.href = 'login.html';
        }
      }
      const errorMsg = (data && (data.error || data.message)) || `Request failed (${response.status})`;
      throw new Error(errorMsg);
    }

    return data;
  }

  function requireAuth() {
    if (!getToken()) {
      window.location.href = 'login.html';
    }
  }

  function renderNavbar() {
    const container = document.getElementById('navbar');
    if (!container) return;

    const current = document.body.dataset.page || 'dashboard';

    const links = [
      { key: 'dashboard', label: 'Dashboard', href: 'index.html' },
      { key: 'products', label: 'Products', href: 'products.html' },
      { key: 'customers', label: 'Customers', href: 'customers.html' },
      { key: 'checkout', label: 'Checkout', href: 'checkout.html' },
      { key: 'bills', label: 'Bills', href: 'bills.html' },
    ];

    const shop = getShopName();

    container.innerHTML = `
      <nav class="navbar">
        <div class="brand">${shop}</div>
        <div class="nav-links">
          ${links
            .map(
              (link) =>
                `<a class="nav-link ${current === link.key ? 'active' : ''}" href="${link.href}">${link.label}</a>`
            )
            .join('')}
          <div class="nav-bell-wrapper" id="navBellWrapper">
            <button class="nav-bell-btn" id="notificationBellBtn" type="button" aria-label="Notifications">&#128276;</button>
            <span class="notification-badge" id="notificationBadge" style="display:none;">0</span>
            <div class="notification-dropdown" id="notificationDropdown">
              <div class="notification-empty">Loading alerts...</div>
            </div>
          </div>
          <button class="nav-logout" id="logoutBtn" type="button">Logout</button>
        </div>
      </nav>
    `;

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        clearToken();
        window.location.href = 'login.html';
      });
    }

    const bellBtn = document.getElementById('notificationBellBtn');
    const dropdown = document.getElementById('notificationDropdown');
    const wrapper = document.getElementById('navBellWrapper');

    if (bellBtn && dropdown && wrapper) {
      bellBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        dropdown.classList.toggle('show');
      });

      document.addEventListener('click', function (event) {
        if (!wrapper.contains(event.target)) {
          dropdown.classList.remove('show');
        }
      });
    }
  }

  async function fetchNotifications() {
    const badge = document.getElementById('notificationBadge');
    const dropdown = document.getElementById('notificationDropdown');

    if (!badge || !dropdown || !getToken()) {
      return;
    }

    try {
      const response = await apiFetch('/api/notifications');
      const unreadCount = Number(response?.unreadCount || 0);
      const alerts = Array.isArray(response?.alerts) ? response.alerts : [];

      if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.style.display = 'inline-flex';
      } else {
        badge.textContent = '';
        badge.style.display = 'none';
      }

      if (alerts.length === 0) {
        dropdown.innerHTML = '<div class="notification-empty">No new alerts.</div>';
        return;
      }

      dropdown.innerHTML = alerts
        .map(
          (alert) => `
            <div class="notification-item">
              <strong>${alert.type || 'Alert'}</strong>
              <span>${alert.message || 'Notification available.'}</span>
            </div>
          `
        )
        .join('');
    } catch (error) {
      badge.textContent = '';
      badge.style.display = 'none';
      dropdown.innerHTML = '<div class="notification-empty">Unable to load alerts.</div>';
    }
  }

  function formatDate(input) {
    if (!input) return '-';
    const dt = new Date(input);
    if (Number.isNaN(dt.getTime())) return '-';
    return dt.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  function formatDateTime(input) {
    if (!input) return '-';
    const dt = new Date(input);
    if (Number.isNaN(dt.getTime())) return '-';
    return dt.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function asCurrency(value) {
    return `Rs ${Number(value || 0).toFixed(2)}`;
  }

  window.App = {
    apiFetch,
    getToken,
    setToken,
    clearToken,
    requireAuth,
    setShopName,
    getShopName,
    showMessage,
    clearMessage,
    formatDate,
    formatDateTime,
    asCurrency,
    renderNavbar,
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.dataset.protected === 'true') {
      requireAuth();
    }

    renderNavbar();
    fetchNotifications();

    const yearEl = document.getElementById('year');
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }
  });
})();
