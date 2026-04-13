(function () {
  let cachedProducts = [];
  let cachedCustomers = [];
  let allFetchedBills = [];
  let scanBuffer = '';
  let scanLastInputAt = 0;
  let scanClearTimer = null;
  let scannerListenerBound = false;
  let dashboardRevenueChart = null;
  let cameraScanner = null;
  let cameraScannerRunning = false;
  let cameraScannerInitializing = false;
  let cameraScanCooldown = false;
  let cameraScanCooldownTimer = null;
  let cameraLibraryLoadPromise = null;

  const SCAN_CHAR_MAX_GAP_MS = 90;
  const SCAN_BUFFER_TIMEOUT_MS = 300;
  const SCAN_MIN_LENGTH = 3;
  const CAMERA_SUCCESS_CLEAR_DELAY_MS = 500;
  const CAMERA_LIBRARY_URLS = [
    'https://unpkg.com/html5-qrcode/html5-qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
  ];

  function getSelectedProduct(productId) {
    return cachedProducts.find((item) => String(item._id) === String(productId));
  }

  function getProductByBarcode(barcode) {
    const normalized = String(barcode || '').trim();
    if (!normalized) return null;

    return (
      cachedProducts.find((item) => String(item.barcode || '').trim() === normalized) || null
    );
  }

  function clearScanBuffer() {
    scanBuffer = '';
    scanLastInputAt = 0;
    if (scanClearTimer) {
      clearTimeout(scanClearTimer);
      scanClearTimer = null;
    }
  }

  function scheduleScanBufferClear() {
    if (scanClearTimer) {
      clearTimeout(scanClearTimer);
    }

    scanClearTimer = setTimeout(clearScanBuffer, SCAN_BUFFER_TIMEOUT_MS);
  }

  function buildProductOptions(selectedId = '') {
    return cachedProducts
      .map(
        (product) =>
          `<option value="${product._id}" ${String(product._id) === String(selectedId) ? 'selected' : ''}>${product.name} (Stock: ${product.stockQuantity}, Price: ${product.sellingPrice})</option>`
      )
      .join('');
  }

  function recalcCheckoutTotal() {
    const rows = document.querySelectorAll('.item-row');
    let total = 0;

    rows.forEach((row) => {
      const productId = row.querySelector('.product-select').value;
      const qty = Number(row.querySelector('.qty-input').value || 0);
      const product = getSelectedProduct(productId);
      const price = Number(product ? product.sellingPrice : 0);
      const line = price * qty;
      total += line;
      row.querySelector('.line-total').textContent = App.asCurrency(line);
    });

    const totalEl = document.getElementById('checkoutTotal');
    if (totalEl) {
      totalEl.textContent = App.asCurrency(total);
    }

    return total;
  }

  function getAvailableStock(product) {
    const stock = Number(product ? product.stockQuantity : 0);
    if (!Number.isFinite(stock)) {
      return 0;
    }
    return Math.max(0, Math.floor(stock));
  }

  function updateRowQuantityLimit(row, showOutOfStockMessage = false) {
    if (!row) return;

    const productSelect = row.querySelector('.product-select');
    const qtyInput = row.querySelector('.qty-input');
    if (!productSelect || !qtyInput) return;

    const product = getSelectedProduct(productSelect.value);
    if (!product) {
      qtyInput.removeAttribute('max');
      return;
    }

    const availableStock = getAvailableStock(product);
    qtyInput.setAttribute('max', String(availableStock));

    const currentQty = Number(qtyInput.value || 0);
    if (availableStock > 0 && Number.isFinite(currentQty) && currentQty > availableStock) {
      qtyInput.value = String(availableStock);
    }

    if (showOutOfStockMessage && availableStock <= 0) {
      App.showMessage('checkoutMessage', `${product.name} is out of stock.`, 'error');
    }
  }

  function addItemRow(defaultProductId = '') {
    const container = document.getElementById('checkoutItems');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <div class="form-grid cols-2">
        <div class="form-row">
          <label>Product</label>
          <select class="product-select" required>
            <option value="">Select product</option>
            ${buildProductOptions(defaultProductId)}
          </select>
        </div>
        <div class="form-row">
          <label>Quantity</label>
          <input class="qty-input" type="number" min="1" step="1" value="1" required />
        </div>
      </div>
      <div class="inline" style="margin-top:10px; justify-content:space-between;">
        <div class="small">Line Total: <strong class="line-total">Rs 0.00</strong></div>
        <button type="button" class="btn-danger remove-item-btn">Remove</button>
      </div>
    `;

    container.appendChild(row);

    row.querySelector('.remove-item-btn').addEventListener('click', function () {
      row.remove();
      recalcCheckoutTotal();
    });

    row.querySelector('.product-select').addEventListener('change', function () {
      updateRowQuantityLimit(row, true);
      recalcCheckoutTotal();
    });
    row.querySelector('.qty-input').addEventListener('input', function () {
      updateRowQuantityLimit(row);
      recalcCheckoutTotal();
    });

    updateRowQuantityLimit(row);

    recalcCheckoutTotal();
    return row;
  }

  function addOrIncrementCartProduct(product) {
    const checkoutItems = document.getElementById('checkoutItems');
    if (!checkoutItems || !product) return false;

    const availableStock = getAvailableStock(product);
    if (availableStock <= 0) {
      App.showMessage('checkoutMessage', `${product.name} is out of stock.`, 'error');
      return false;
    }

    const existingRow = Array.from(checkoutItems.querySelectorAll('.item-row')).find((row) => {
      const productSelect = row.querySelector('.product-select');
      return String(productSelect ? productSelect.value : '') === String(product._id);
    });

    if (existingRow) {
      const qtyInput = existingRow.querySelector('.qty-input');
      const currentQty = Number(qtyInput ? qtyInput.value : 0) || 0;
      if (currentQty >= availableStock) {
        App.showMessage('checkoutMessage', `Only ${availableStock} units available for ${product.name}.`, 'error');
        updateRowQuantityLimit(existingRow);
        recalcCheckoutTotal();
        return false;
      }

      if (qtyInput) {
        qtyInput.value = String(currentQty + 1);
      }
      updateRowQuantityLimit(existingRow);
      recalcCheckoutTotal();
      return true;
    }

    const newRow = addItemRow(product._id);
    updateRowQuantityLimit(newRow, true);
    return true;
  }

  function handleBarcodeScan(barcode) {
    const product = getProductByBarcode(barcode);
    if (!product) {
      return false;
    }

    return addOrIncrementCartProduct(product);
  }

  function handleScannerKeydown(event) {
    const form = document.getElementById('checkoutForm');
    if (!form) return;

    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const now = Date.now();
    const key = event.key;

    if (key === 'Enter') {
      const barcode = scanBuffer.trim();
      const isValidScan = barcode.length >= SCAN_MIN_LENGTH && handleBarcodeScan(barcode);

      clearScanBuffer();

      if (isValidScan) {
        event.preventDefault();
      }
      return;
    }

    if (key.length !== 1) {
      return;
    }

    if (scanLastInputAt && now - scanLastInputAt > SCAN_CHAR_MAX_GAP_MS) {
      scanBuffer = '';
    }

    scanBuffer += key;
    scanLastInputAt = now;
    scheduleScanBufferClear();
  }

  function setupScannerListener() {
    if (scannerListenerBound) {
      return;
    }

    document.addEventListener('keydown', handleScannerKeydown);
    scannerListenerBound = true;
  }

  function resetCameraScanCooldownTimers() {
    cameraScanCooldown = false;

    if (cameraScanCooldownTimer) {
      clearTimeout(cameraScanCooldownTimer);
      cameraScanCooldownTimer = null;
    }
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[data-camera-lib-src="${src}"]`);
      if (existingScript) {
        if (typeof window.Html5QrcodeScanner !== 'undefined') {
          resolve(true);
          return;
        }

        existingScript.addEventListener('load', () => resolve(true), { once: true });
        existingScript.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
          once: true,
        });
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      script.dataset.cameraLibSrc = src;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureCameraScannerLibrary() {
    if (typeof window.Html5QrcodeScanner !== 'undefined') {
      return true;
    }

    if (cameraLibraryLoadPromise) {
      return cameraLibraryLoadPromise;
    }

    cameraLibraryLoadPromise = (async () => {
      for (const src of CAMERA_LIBRARY_URLS) {
        try {
          await loadScriptOnce(src);
          if (typeof window.Html5QrcodeScanner !== 'undefined') {
            return true;
          }
        } catch (_error) {
          // Try next CDN URL.
        }
      }
      return false;
    })();

    const loaded = await cameraLibraryLoadPromise;
    if (!loaded) {
      cameraLibraryLoadPromise = null;
    }
    return loaded;
  }

  function onCameraScanFailure(error) {
    // Ignore background frame noise.
  }

  function onCameraScanSuccess(decodedText, decodedResult) {
    if (cameraScanCooldown) {
      return;
    }

    const product = getProductByBarcode(decodedText);
    if (!product) {
      return;
    }

    const wasAdded = addOrIncrementCartProduct(product);
    if (!wasAdded) {
      return;
    }

    recalcCheckoutTotal();
    App.showMessage('checkoutMessage', `Scanned: ${product.name}`, 'success');

    cameraScanCooldown = true;
    cameraScanCooldownTimer = setTimeout(function () {
      stopCameraScanner();
    }, CAMERA_SUCCESS_CLEAR_DELAY_MS);
  }

  async function stopCameraScanner() {
    const reader = document.getElementById('reader');
    const startCameraBtn = document.getElementById('startCameraBtn');

    resetCameraScanCooldownTimers();

    if (cameraScanner && typeof cameraScanner.clear === 'function') {
      try {
        await cameraScanner.clear();
      } catch (_error) {
        // Ignore clear errors from scanner teardown.
      }
    }

    cameraScanner = null;
    cameraScannerRunning = false;
    cameraScannerInitializing = false;

    if (reader) {
      reader.style.display = 'none';
    }

    if (startCameraBtn) {
      startCameraBtn.textContent = 'Start Camera Scanner';
    }
  }

  async function startCameraScanner() {
    const reader = document.getElementById('reader');
    const startCameraBtn = document.getElementById('startCameraBtn');

    if (!reader || !startCameraBtn || cameraScannerRunning || cameraScannerInitializing) {
      return;
    }

    cameraScannerInitializing = true;

    const isLibraryReady = await ensureCameraScannerLibrary();
    if (!cameraScannerInitializing) {
      return;
    }

    if (!isLibraryReady || typeof window.Html5QrcodeScanner === 'undefined') {
      App.showMessage('checkoutMessage', 'Camera scanner library failed to load. Check internet and retry.', 'error');
      cameraScannerInitializing = false;
      return;
    }

    reader.style.display = 'block';
    startCameraBtn.textContent = 'Stop Camera Scanner';

    try {
      cameraScanner = new window.Html5QrcodeScanner(
        'reader',
        {
          fps: 10,
          qrbox: { width: 250, height: 120 },
          rememberLastUsedCamera: true,
        },
        false
      );

      cameraScanner.render(onCameraScanSuccess, onCameraScanFailure);
      cameraScannerRunning = true;
    } catch (error) {
      reader.style.display = 'none';
      startCameraBtn.textContent = 'Start Camera Scanner';
      cameraScanner = null;
      App.showMessage('checkoutMessage', error.message || 'Unable to start camera scanner.', 'error');
    } finally {
      cameraScannerInitializing = false;
    }
  }

  function bindCameraScannerControls() {
    const startCameraBtn = document.getElementById('startCameraBtn');
    if (!startCameraBtn) return;

    startCameraBtn.addEventListener('click', function () {
      if (cameraScannerRunning || cameraScannerInitializing) {
        stopCameraScanner();
        return;
      }

      startCameraScanner();
    });
  }

  function renderCustomerOptions() {
    const select = document.getElementById('checkoutCustomer');
    if (!select) return;

    select.innerHTML = `
      <option value="">Walk-in customer</option>
      ${cachedCustomers
        .map((customer) => `<option value="${customer._id}">${customer.name} (${customer.phone})</option>`)
        .join('')}
    `;
  }

  async function loadCheckoutDependencies() {
    const productsResponse = await App.apiFetch('/api/products?page=1&limit=1000');
    cachedProducts = Array.isArray(productsResponse?.data)
      ? productsResponse.data
      : Array.isArray(productsResponse)
        ? productsResponse
        : [];

    const customersResponse = await App.apiFetch('/api/customers?page=1&limit=1000');
    cachedCustomers = Array.isArray(customersResponse?.data)
      ? customersResponse.data
      : Array.isArray(customersResponse)
        ? customersResponse
        : [];

    renderCustomerOptions();
  }

  function collectCartItems() {
    const rows = document.querySelectorAll('.item-row');
    const cartItems = [];

    for (const row of rows) {
      const productId = row.querySelector('.product-select').value;
      const quantity = Number(row.querySelector('.qty-input').value || 0);
      const product = getSelectedProduct(productId);
      const availableStock = getAvailableStock(product);

      if (!productId || !product) {
        App.showMessage('checkoutMessage', 'Select a valid product for each cart row.', 'error');
        return null;
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        App.showMessage('checkoutMessage', `Enter a valid quantity for ${product.name}.`, 'error');
        return null;
      }

      if (quantity > availableStock) {
        App.showMessage(
          'checkoutMessage',
          `Quantity for ${product.name} exceeds available stock (${availableStock}).`,
          'error'
        );
        return null;
      }

      cartItems.push({
        productId,
        name: product.name,
        quantity,
        price: Number(product.sellingPrice),
      });
    }

    return cartItems;
  }

  async function handleCheckoutSubmit(event) {
    event.preventDefault();
    App.clearMessage('checkoutMessage');

    const paymentMode = document.getElementById('paymentMode').value;
    const customerId = document.getElementById('checkoutCustomer').value;
    const cartItems = collectCartItems();
    if (!cartItems) {
      return;
    }

    if (!cartItems.length) {
      App.showMessage('checkoutMessage', 'Add at least one valid item.', 'error');
      return;
    }

    if (paymentMode === 'Credit' && !customerId) {
      App.showMessage('checkoutMessage', 'Customer is required for credit checkout.', 'error');
      return;
    }

    try {
      await App.apiFetch('/api/checkout', {
        method: 'POST',
        body: {
          cartItems,
          paymentMode,
          customerId: customerId || null,
        },
      });

      App.showMessage('checkoutMessage', 'Checkout successful and bill generated.', 'success');
      document.getElementById('checkoutItems').innerHTML = '';
      await loadCheckoutDependencies();
      addItemRow();
      document.getElementById('paymentMode').value = 'Cash';
      document.getElementById('checkoutCustomer').value = '';
      recalcCheckoutTotal();
    } catch (error) {
      App.showMessage('checkoutMessage', error.message, 'error');
    }
  }

  function printBillReceipt(billId) {
    const sourceCard = document.querySelector(`.bill-card[data-bill-id="${billId}"]`);
    if (!sourceCard) {
      App.showMessage('billsMessage', 'Unable to print this receipt.', 'error');
      return;
    }

    const printableCard = sourceCard.cloneNode(true);
    printableCard.querySelectorAll('.no-print').forEach((node) => node.remove());

    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.style.visibility = 'hidden';
    document.body.appendChild(frame);

    const cleanup = () => {
      if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    };

    frame.onload = function () {
      setTimeout(function () {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      }, 120);
    };

    frame.contentWindow.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 10000);

    const printDoc = frame.contentWindow.document;
    const stylesheetUrl = new URL('css/style.css', window.location.href).href;

    printDoc.open();
    printDoc.write(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Receipt</title>
          <link rel="stylesheet" href="${stylesheetUrl}" />
        </head>
        <body class="thermal-print-sheet">
          <main class="page">
            <section id="billsContainer">
              ${printableCard.outerHTML}
            </section>
          </main>
        </body>
      </html>
    `);
    printDoc.close();
  }

  function renderBills(bills) {
    const container = document.getElementById('billsContainer');
    if (!container) return;

    if (!Array.isArray(bills) || bills.length === 0) {
      container.innerHTML = '<div class="card"><p>No bills generated yet.</p></div>';
      return;
    }

    container.innerHTML = bills
      .map((bill) => {
        const itemRows = (bill.items || [])
          .map(
            (item) => `
            <tr>
              <td>${item.name || '-'}</td>
              <td>${item.quantity || 0}</td>
              <td>${App.asCurrency(item.price)}</td>
              <td>${App.asCurrency((item.price || 0) * (item.quantity || 0))}</td>
            </tr>
          `
          )
          .join('');

        return `
          <div class="card bill-card thermal-receipt" data-bill-id="${bill._id}" style="margin-bottom:14px;">
            <div class="inline" style="justify-content:space-between; margin-bottom:10px;">
              <div class="inline">
                <strong>Bill #${bill._id.slice(-6).toUpperCase()}</strong>
                ${bill.isVoided ? '<span class="badge bad">VOIDED</span>' : ''}
              </div>
              <span class="small">${App.formatDateTime(bill.date)}</span>
            </div>
            <div class="inline" style="justify-content:space-between; margin-bottom:10px;">
              <span class="small">Payment: <strong>${bill.paymentMode}</strong></span>
              <span class="small">Customer: <strong>${bill.customerId ? bill.customerId.name : 'Walk-in'}</strong></span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRows}
                </tbody>
              </table>
            </div>
            <div style="margin-top:10px; text-align:right; font-weight:700; color:#0b5f58;">
              Total: ${App.asCurrency(bill.totalAmount)}
            </div>
            <div class="inline no-print" style="justify-content:flex-end; margin-top:12px;">
              ${
                bill.isVoided
                  ? '<span class="badge bad">VOIDED</span>'
                  : `<button type="button" class="btn-danger void-bill-btn" data-bill-id="${bill._id}">Void Bill</button>`
              }
              <button type="button" class="btn-ghost print-receipt-btn" data-bill-id="${bill._id}">
                Print Receipt
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function applyBillFilter() {
    const filterEl = document.getElementById('billFilter');
    const filterValue = filterEl ? filterEl.value : 'active';
    const sourceBills = Array.isArray(allFetchedBills) ? allFetchedBills : [];

    let filteredBills = sourceBills;

    if (filterValue === 'active') {
      filteredBills = sourceBills.filter((bill) => !bill.isVoided);
    } else if (filterValue === 'voided') {
      filteredBills = sourceBills.filter((bill) => Boolean(bill.isVoided));
    }

    renderBills(filteredBills);
  }

  async function loadBills() {
    try {
      const bills = await App.apiFetch('/api/bills');
      allFetchedBills = Array.isArray(bills) ? bills : [];
      applyBillFilter();
    } catch (error) {
      App.showMessage('billsMessage', error.message, 'error');
    }
  }

  async function voidBill(billId) {
    App.clearMessage('billsMessage');

    try {
      await App.apiFetch(`/api/bills/${billId}/void`, {
        method: 'POST',
      });
      App.showMessage('billsMessage', 'Bill voided and stock restored.', 'success');
      await loadBills();
    } catch (error) {
      App.showMessage('billsMessage', error.message, 'error');
    }
  }

  function formatDashboardDateLabel(dateKey) {
    const [year, month, day] = String(dateKey || '').split('-').map(Number);
    if (!year || !month || !day) return String(dateKey || '');

    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return String(dateKey || '');

    return date.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
    });
  }

  function renderRevenueChart(last7DaysRevenue) {
    const canvas = document.getElementById('revenue7DayChart');
    if (!canvas || typeof window.Chart === 'undefined') {
      return;
    }

    const rows = Array.isArray(last7DaysRevenue) ? last7DaysRevenue : [];
    const labels = rows.map((row) => formatDashboardDateLabel(row.date));
    const data = rows.map((row) => Number(row.revenue || 0));

    if (dashboardRevenueChart) {
      dashboardRevenueChart.destroy();
    }

    dashboardRevenueChart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Revenue (Rs)',
            data,
            backgroundColor: '#0f766e',
            borderColor: '#0b5f58',
            borderWidth: 1,
            borderRadius: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function (value) {
                return `Rs ${value}`;
              },
            },
          },
        },
      },
    });
  }

  function renderCriticalAlerts(lowStockAlerts, expiryAlerts) {
    const container = document.getElementById('criticalAlerts');
    if (!container) return;

    const lowStock = Array.isArray(lowStockAlerts) ? lowStockAlerts : [];
    const expiringSoon = Array.isArray(expiryAlerts) ? expiryAlerts : [];

    if (lowStock.length === 0 && expiringSoon.length === 0) {
      container.innerHTML = `
        <div class="alert-banner info">
          <strong>No critical alerts right now.</strong>
          <p>Stock and expiry levels are currently within safe limits.</p>
        </div>
      `;
      return;
    }

    const lowStockHtml = lowStock.map((item) => `
      <div class="alert-banner danger">
        <strong>Low Stock: ${item.name || '-'}</strong>
        <p>Only ${Number(item.stockQuantity || 0)} units left (Barcode: ${item.barcode || '-'})</p>
      </div>
    `);

    const expiryHtml = expiringSoon.map((item) => `
      <div class="alert-banner">
        <strong>Expiring Soon: ${item.name || '-'}</strong>
        <p>Expiry: ${App.formatDate(item.expiryDate)} | Stock: ${Number(item.stockQuantity || 0)}</p>
      </div>
    `);

    container.innerHTML = [...lowStockHtml, ...expiryHtml].join('');
  }

  async function loadDashboard() {
    const productsKpi = document.getElementById('kpiProducts');
    const customersKpi = document.getElementById('kpiCustomers');
    const billsKpi = document.getElementById('kpiBills');
    const revenueKpi = document.getElementById('kpiRevenue');

    if (!productsKpi || !customersKpi || !billsKpi || !revenueKpi) {
      return;
    }

    try {
      const dashboard = await App.apiFetch('/api/analytics/dashboard');
      const kpi = dashboard.kpi || {};

      productsKpi.textContent = String(Number(kpi.totalProducts || 0));
      customersKpi.textContent = String(Number(kpi.totalCustomers || 0));
      billsKpi.textContent = String(Number(kpi.totalBills || 0));
      revenueKpi.textContent = App.asCurrency(dashboard.todayRevenue || 0);

      renderRevenueChart(dashboard.last7DaysRevenue);
      renderCriticalAlerts(dashboard.lowStockAlerts, dashboard.expiryAlerts);
    } catch (error) {
      App.showMessage('dashboardMessage', error.message, 'error');
    }
  }

  function initCheckoutPage() {
    const form = document.getElementById('checkoutForm');
    if (!form) return;
    setupScannerListener();
    bindCameraScannerControls();

    loadCheckoutDependencies()
      .then(function () {
        addItemRow();
      })
      .catch(function (error) {
        App.showMessage('checkoutMessage', error.message, 'error');
      });

    const addItemBtn = document.getElementById('addItemBtn');
    addItemBtn.addEventListener('click', function () {
      addItemRow();
    });

    form.addEventListener('submit', handleCheckoutSubmit);
  }

  function initBillsPage() {
    const container = document.getElementById('billsContainer');
    if (!container) return;

    loadBills();

    container.addEventListener('click', function (event) {
      const voidTrigger = event.target.closest('.void-bill-btn');
      if (voidTrigger) {
        const billId = voidTrigger.getAttribute('data-bill-id');
        if (!billId) return;

        const shouldVoid = window.confirm('Void this bill? Stock will be restored and credit adjusted.');
        if (!shouldVoid) return;

        voidBill(billId);
        return;
      }

      const trigger = event.target.closest('.print-receipt-btn');
      if (!trigger) return;

      const billId = trigger.getAttribute('data-bill-id');
      if (!billId) return;

      printBillReceipt(billId);
    });

    const refreshBtn = document.getElementById('refreshBillsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadBills);
    }

    const billFilter = document.getElementById('billFilter');
    if (billFilter) {
      billFilter.addEventListener('change', applyBillFilter);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCheckoutPage();
    initBillsPage();
    loadDashboard();
  });
})();
