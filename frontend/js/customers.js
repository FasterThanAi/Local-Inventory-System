(function () {
  const CUSTOMERS_PAGE_LIMIT = 50;
  let currentCustomersPage = 1;
  let customersTotalPages = 1;
  let customersSearch = '';

  function buildCustomersQuery(page) {
    const params = new URLSearchParams({
      page: String(page || 1),
      limit: String(CUSTOMERS_PAGE_LIMIT),
    });

    if (customersSearch) {
      params.set('search', customersSearch);
    }

    return params.toString();
  }

  async function fetchCustomers(page = currentCustomersPage) {
    return App.apiFetch(`/api/customers?${buildCustomersQuery(page)}`);
  }

  function normalizeWhatsappPhone(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  function openWhatsappReminder(customer) {
    const phone = normalizeWhatsappPhone(customer.phone);
    if (!phone) {
      App.showMessage('customersMessage', 'Customer phone number is not valid for WhatsApp.', 'error');
      return;
    }

    const balance = Number(customer.udhaarBalance || 0).toFixed(2);
    const message = `Hello ${customer.name || 'Customer'}, this is a gentle reminder from ${App.getShopName()} regarding your pending balance of Rs ${balance}. Please arrange the payment at your earliest convenience.`;
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  }

  function renderCustomers(customers) {
    const tbody = document.getElementById('customersTableBody');
    if (!tbody) return;

    if (!customers || customers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6">No customers found.</td></tr>';
      return;
    }

    tbody.innerHTML = customers
      .map(
        (customer) => `
        <tr>
          <td>${customer.name || '-'}</td>
          <td>${customer.phone || '-'}</td>
          <td>${App.asCurrency(customer.udhaarBalance)}</td>
          <td>
            <input
              id="payAmount-${customer._id}"
              type="number"
              min="1"
              max="${Math.max(0, Number(customer.udhaarBalance || 0))}"
              step="0.01"
              placeholder="Amount"
            />
          </td>
          <td>
            <button class="btn-outline" data-pay-customer-id="${customer._id}">Pay</button>
            <button class="btn-danger" data-delete-customer-id="${customer._id}">Delete</button>
          </td>
          <td>
            ${Number(customer.udhaarBalance || 0) > 0
              ? `<button class="btn-ghost" data-reminder-customer-id="${customer._id}">WhatsApp Reminder</button>`
              : '-'}
          </td>
        </tr>
      `
      )
      .join('');

    tbody.querySelectorAll('button[data-pay-customer-id]').forEach((button) => {
      button.addEventListener('click', async function () {
        const customerId = button.dataset.payCustomerId;
        const input = document.getElementById(`payAmount-${customerId}`);
        const amountPaid = Number(input.value);
        const customer = customers.find((item) => String(item._id) === String(customerId));
        const pendingBalance = Math.max(0, Number(customer ? customer.udhaarBalance : 0));

        if (!amountPaid || amountPaid <= 0) {
          App.showMessage('customersMessage', 'Enter a valid payment amount.', 'error');
          return;
        }

        if (!customer) {
          App.showMessage('customersMessage', 'Customer not found.', 'error');
          return;
        }

        if (pendingBalance <= 0) {
          App.showMessage('customersMessage', 'No pending udhaar balance for this customer.', 'error');
          return;
        }

        if (amountPaid > pendingBalance) {
          App.showMessage('customersMessage', 'Payment exceeds pending udhaar balance.', 'error');
          return;
        }

        try {
          await App.apiFetch('/api/customers/pay', {
            method: 'POST',
            body: { customerId, amountPaid },
          });

          App.showMessage('customersMessage', 'Payment updated successfully.', 'success');
          await loadCustomers();
        } catch (error) {
          App.showMessage('customersMessage', error.message, 'error');
        }
      });
    });

    tbody.querySelectorAll('button[data-reminder-customer-id]').forEach((button) => {
      button.addEventListener('click', function () {
        const customerId = button.dataset.reminderCustomerId;
        const customer = customers.find((item) => String(item._id) === String(customerId));
        if (!customer || Number(customer.udhaarBalance || 0) <= 0) {
          return;
        }

        openWhatsappReminder(customer);
      });
    });

    tbody.querySelectorAll('button[data-delete-customer-id]').forEach((button) => {
      button.addEventListener('click', async function () {
        const customerId = button.dataset.deleteCustomerId;
        const shouldDelete = window.confirm('Are you sure you want to delete this customer?');

        if (!shouldDelete) {
          return;
        }

        try {
          await App.apiFetch(`/api/customers/${customerId}`, {
            method: 'DELETE',
          });
          App.showMessage('customersMessage', 'Customer deleted successfully.', 'success');
          await loadCustomers();
        } catch (error) {
          App.showMessage('customersMessage', error.message, 'error');
        }
      });
    });
  }

  function renderCustomersPagination() {
    const info = document.getElementById('customersPageInfo');
    const prevBtn = document.getElementById('customersPrevBtn');
    const nextBtn = document.getElementById('customersNextBtn');

    if (info) {
      info.textContent = `Page ${currentCustomersPage} of ${customersTotalPages}`;
    }

    if (prevBtn) {
      prevBtn.disabled = currentCustomersPage <= 1;
    }

    if (nextBtn) {
      nextBtn.disabled = currentCustomersPage >= customersTotalPages;
    }
  }

  async function loadCustomers(page = currentCustomersPage) {
    try {
      const response = await fetchCustomers(page);
      const customers = Array.isArray(response?.data) ? response.data : [];

      currentCustomersPage = Number(response?.currentPage || 1);
      customersTotalPages = Math.max(1, Number(response?.totalPages || 1));

      renderCustomers(customers);
      renderCustomersPagination();
    } catch (error) {
      App.showMessage('customersMessage', error.message, 'error');
    }
  }

  async function handleAddCustomer(event) {
    event.preventDefault();
    App.clearMessage('addCustomerMessage');

    const payload = {
      name: document.getElementById('customerName').value.trim(),
      phone: document.getElementById('customerPhone').value.trim(),
      udhaarBalance: Number(document.getElementById('udhaarBalance').value || 0),
    };

    try {
      await App.apiFetch('/api/customers', {
        method: 'POST',
        body: payload,
      });

      App.showMessage('addCustomerMessage', 'Customer added successfully.', 'success');
      document.getElementById('addCustomerForm').reset();
    } catch (error) {
      App.showMessage('addCustomerMessage', error.message, 'error');
    }
  }

  function initCustomersPage() {
    const table = document.getElementById('customersTableBody');
    if (!table) return;

    let searchTimer = null;
    loadCustomers();

    const searchInput = document.getElementById('customersSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const value = searchInput.value.trim();
        if (searchTimer) {
          clearTimeout(searchTimer);
        }

        searchTimer = setTimeout(function () {
          customersSearch = value;
          currentCustomersPage = 1;
          loadCustomers(1);
        }, 250);
      });
    }

    const prevBtn = document.getElementById('customersPrevBtn');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (currentCustomersPage > 1) {
          loadCustomers(currentCustomersPage - 1);
        }
      });
    }

    const nextBtn = document.getElementById('customersNextBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (currentCustomersPage < customersTotalPages) {
          loadCustomers(currentCustomersPage + 1);
        }
      });
    }

    const refreshBtn = document.getElementById('refreshCustomersBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadCustomers(currentCustomersPage);
      });
    }
  }

  function initAddCustomerPage() {
    const form = document.getElementById('addCustomerForm');
    if (!form) return;

    form.addEventListener('submit', handleAddCustomer);
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCustomersPage();
    initAddCustomerPage();
  });
})();
