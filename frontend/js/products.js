(function () {
  const PRODUCTS_PAGE_LIMIT = 50;
  let currentProductsPage = 1;
  let productsTotalPages = 1;
  let productsSearch = '';
  let cachedProducts = [];
  let editingProductId = '';
  let productCameraScanner = null;
  let productCameraScannerRunning = false;
  let productCameraScannerInitializing = false;
  let productCameraLibraryLoadPromise = null;
  let productScannerCleanupBound = false;

  const PRODUCT_CAMERA_LIBRARY_URLS = [
    'https://unpkg.com/html5-qrcode/html5-qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
  ];
  const PRODUCT_BARCODE_FORMAT_KEYS = ['EAN_13', 'UPC_A', 'CODE_128'];

  function stockBadge(quantity) {
    const qty = Number(quantity || 0);
    if (qty <= 5) return '<span class="badge bad">Low</span>';
    if (qty <= 20) return '<span class="badge warn">Medium</span>';
    return '<span class="badge good">Good</span>';
  }

  function buildProductsQuery(page) {
    const params = new URLSearchParams({
      page: String(page || 1),
      limit: String(PRODUCTS_PAGE_LIMIT),
    });

    if (productsSearch) {
      params.set('search', productsSearch);
    }

    return params.toString();
  }

  function renderProducts(products) {
    const tbody = document.getElementById('productsTableBody');
    if (!tbody) return;

    cachedProducts = Array.isArray(products) ? products : [];

    if (cachedProducts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8">No products found.</td></tr>';
      return;
    }

    tbody.innerHTML = cachedProducts
      .map(
        (item) => `
        <tr>
          <td>${item.barcode || '-'}</td>
          <td>${item.name || '-'}</td>
          <td>${App.asCurrency(item.mrp)}</td>
          <td>${App.asCurrency(item.sellingPrice)}</td>
          <td>${item.stockQuantity ?? '-'}</td>
          <td>${App.formatDate(item.expiryDate)}</td>
          <td>${stockBadge(item.stockQuantity)}</td>
          <td>
            <div class="inline">
              <button class="btn-outline product-edit-btn" type="button" data-id="${item._id}">Edit</button>
              <button class="btn-danger product-delete-btn" type="button" data-id="${item._id}">Delete</button>
            </div>
          </td>
        </tr>
      `
      )
      .join('');
  }

  function getCachedProductById(productId) {
    return cachedProducts.find((item) => String(item._id) === String(productId));
  }

  function toDateInputValue(rawDate) {
    const dt = new Date(rawDate);
    if (Number.isNaN(dt.getTime())) {
      return '';
    }

    const shifted = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 10);
  }

  function openEditProductModal(product) {
    const modal = document.getElementById('editProductModal');
    const form = document.getElementById('editProductForm');
    if (!modal || !form || !product) return;

    editingProductId = String(product._id);
    document.getElementById('editBarcode').value = product.barcode || '';
    document.getElementById('editProductName').value = product.name || '';
    document.getElementById('editMrp').value = Number(product.mrp || 0);
    document.getElementById('editSellingPrice').value = Number(product.sellingPrice || 0);
    document.getElementById('editStockQuantity').value = Number(product.stockQuantity || 0);
    document.getElementById('editExpiryDate').value = toDateInputValue(product.expiryDate);

    modal.classList.add('show');
  }

  function closeEditProductModal() {
    const modal = document.getElementById('editProductModal');
    const form = document.getElementById('editProductForm');

    editingProductId = '';
    if (form) {
      form.reset();
    }

    if (modal) {
      modal.classList.remove('show');
    }
  }

  async function handleProductDelete(productId) {
    const product = getCachedProductById(productId);
    const productName = product ? product.name : 'this product';
    const shouldDelete = window.confirm(`Delete ${productName}?`);
    if (!shouldDelete) return;

    App.clearMessage('productsMessage');

    try {
      await App.apiFetch(`/api/products/${productId}`, {
        method: 'DELETE',
      });

      App.showMessage('productsMessage', 'Product deleted successfully.', 'success');
      await loadProducts(currentProductsPage);
    } catch (error) {
      App.showMessage('productsMessage', error.message, 'error');
    }
  }

  async function handleEditProductSubmit(event) {
    event.preventDefault();
    App.clearMessage('productsMessage');

    if (!editingProductId) {
      App.showMessage('productsMessage', 'No product selected for editing.', 'error');
      return;
    }

    const payload = {
      barcode: document.getElementById('editBarcode').value.trim(),
      name: document.getElementById('editProductName').value.trim(),
      mrp: Number(document.getElementById('editMrp').value),
      sellingPrice: Number(document.getElementById('editSellingPrice').value),
      stockQuantity: Number(document.getElementById('editStockQuantity').value),
      expiryDate: document.getElementById('editExpiryDate').value,
    };

    try {
      await App.apiFetch(`/api/products/${editingProductId}`, {
        method: 'PUT',
        body: payload,
      });

      closeEditProductModal();
      App.showMessage('productsMessage', 'Product updated successfully.', 'success');
      await loadProducts(currentProductsPage);
    } catch (error) {
      App.showMessage('productsMessage', error.message, 'error');
    }
  }

  function renderProductsPagination() {
    const info = document.getElementById('productsPageInfo');
    const prevBtn = document.getElementById('productsPrevBtn');
    const nextBtn = document.getElementById('productsNextBtn');

    if (info) {
      info.textContent = `Page ${currentProductsPage} of ${productsTotalPages}`;
    }

    if (prevBtn) {
      prevBtn.disabled = currentProductsPage <= 1;
    }

    if (nextBtn) {
      nextBtn.disabled = currentProductsPage >= productsTotalPages;
    }
  }

  async function loadProducts(page = currentProductsPage) {
    try {
      const query = buildProductsQuery(page);
      const response = await App.apiFetch(`/api/products?${query}`);

      const data = Array.isArray(response?.data) ? response.data : [];
      currentProductsPage = Number(response?.currentPage || 1);
      productsTotalPages = Math.max(1, Number(response?.totalPages || 1));

      renderProducts(data);
      renderProductsPagination();
    } catch (error) {
      App.showMessage('productsMessage', error.message, 'error');
    }
  }

  async function handleAddProduct(event) {
    event.preventDefault();
    App.clearMessage('addProductMessage');

    const payload = {
      barcode: document.getElementById('barcode').value.trim(),
      name: document.getElementById('productName').value.trim(),
      mrp: Number(document.getElementById('mrp').value),
      sellingPrice: Number(document.getElementById('sellingPrice').value),
      stockQuantity: Number(document.getElementById('stockQuantity').value),
      expiryDate: document.getElementById('expiryDate').value,
    };

    try {
      await App.apiFetch('/api/products', {
        method: 'POST',
        body: payload,
      });

      App.showMessage('addProductMessage', 'Product added successfully.', 'success');
      document.getElementById('addProductForm').reset();
    } catch (error) {
      App.showMessage('addProductMessage', error.message, 'error');
    }
  }

  function loadProductScannerScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[data-product-scanner-src="${src}"]`);
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
      script.dataset.productScannerSrc = src;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureProductScannerLibrary() {
    if (typeof window.Html5QrcodeScanner !== 'undefined') {
      return true;
    }

    if (productCameraLibraryLoadPromise) {
      return productCameraLibraryLoadPromise;
    }

    productCameraLibraryLoadPromise = (async () => {
      for (const src of PRODUCT_CAMERA_LIBRARY_URLS) {
        try {
          await loadProductScannerScriptOnce(src);
          if (typeof window.Html5QrcodeScanner !== 'undefined') {
            return true;
          }
        } catch (_error) {
          // Try the next CDN URL.
        }
      }
      return false;
    })();

    const loaded = await productCameraLibraryLoadPromise;
    if (!loaded) {
      productCameraLibraryLoadPromise = null;
    }

    return loaded;
  }

  function getProductScannerFormats() {
    const supportedFormats = window.Html5QrcodeSupportedFormats;
    if (!supportedFormats) {
      return [];
    }

    return PRODUCT_BARCODE_FORMAT_KEYS
      .map((key) => supportedFormats[key])
      .filter((format) => format !== undefined && format !== null);
  }

  function onProductScanFailure(_error) {
    // Ignore frame parsing noise while scanning.
  }

  async function stopProductCameraScanner() {
    const reader = document.getElementById('productReader');
    const button = document.getElementById('startProductCameraBtn');

    productCameraScannerInitializing = false;

    if (productCameraScanner && typeof productCameraScanner.clear === 'function') {
      try {
        await productCameraScanner.clear();
      } catch (_error) {
        // Ignore teardown errors from the scanner instance.
      }
    }

    productCameraScanner = null;
    productCameraScannerRunning = false;

    if (reader) {
      reader.style.display = 'none';
    }

    if (button) {
      button.textContent = 'Scan Barcode';
    }
  }

  function onProductScanSuccess(decodedText) {
    const barcodeInput = document.getElementById('barcode');
    if (!barcodeInput) {
      stopProductCameraScanner();
      return;
    }

    barcodeInput.value = String(decodedText || '').trim();
    barcodeInput.dispatchEvent(new Event('input', { bubbles: true }));

    App.showMessage('addProductMessage', 'Barcode scanned successfully!', 'success');
    stopProductCameraScanner();
  }

  async function startProductCameraScanner() {
    const reader = document.getElementById('productReader');
    const button = document.getElementById('startProductCameraBtn');

    if (!reader || !button || productCameraScannerRunning || productCameraScannerInitializing) {
      return;
    }

    productCameraScannerInitializing = true;

    const isLibraryReady = await ensureProductScannerLibrary();
    if (!productCameraScannerInitializing) {
      return;
    }

    if (!isLibraryReady || typeof window.Html5QrcodeScanner === 'undefined') {
      App.showMessage(
        'addProductMessage',
        'Camera scanner library failed to load. Check internet and retry.',
        'error'
      );
      productCameraScannerInitializing = false;
      return;
    }

    reader.style.display = 'block';
    button.textContent = 'Close Scanner';

    try {
      const formats = getProductScannerFormats();
      const scannerConfig = {
        fps: 10,
        qrbox: { width: 320, height: 140 },
        rememberLastUsedCamera: true,
      };

      if (formats.length > 0) {
        scannerConfig.formatsToSupport = formats;
      }

      productCameraScanner = new window.Html5QrcodeScanner('productReader', scannerConfig, false);
      productCameraScanner.render(onProductScanSuccess, onProductScanFailure);
      productCameraScannerRunning = true;
    } catch (error) {
      reader.style.display = 'none';
      button.textContent = 'Scan Barcode';
      productCameraScanner = null;
      App.showMessage('addProductMessage', error.message || 'Unable to start camera scanner.', 'error');
    } finally {
      productCameraScannerInitializing = false;
    }
  }

  function bindProductScannerCleanup() {
    if (productScannerCleanupBound) {
      return;
    }

    window.addEventListener('pagehide', function () {
      stopProductCameraScanner();
    });

    window.addEventListener('beforeunload', function () {
      stopProductCameraScanner();
    });

    productScannerCleanupBound = true;
  }

  function initProductsPage() {
    const table = document.getElementById('productsTableBody');
    if (!table) return;

    let searchTimer = null;
    loadProducts();

    const searchInput = document.getElementById('productsSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const value = searchInput.value.trim();
        if (searchTimer) {
          clearTimeout(searchTimer);
        }

        searchTimer = setTimeout(function () {
          productsSearch = value;
          currentProductsPage = 1;
          loadProducts(1);
        }, 250);
      });
    }

    const prevBtn = document.getElementById('productsPrevBtn');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (currentProductsPage > 1) {
          loadProducts(currentProductsPage - 1);
        }
      });
    }

    const nextBtn = document.getElementById('productsNextBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (currentProductsPage < productsTotalPages) {
          loadProducts(currentProductsPage + 1);
        }
      });
    }

    const refreshBtn = document.getElementById('refreshProductsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadProducts(currentProductsPage);
      });
    }

    table.addEventListener('click', function (event) {
      const editTrigger = event.target.closest('.product-edit-btn');
      if (editTrigger) {
        const productId = editTrigger.getAttribute('data-id');
        const product = getCachedProductById(productId);
        if (!product) {
          App.showMessage('productsMessage', 'Unable to find selected product.', 'error');
          return;
        }

        openEditProductModal(product);
        return;
      }

      const deleteTrigger = event.target.closest('.product-delete-btn');
      if (deleteTrigger) {
        const productId = deleteTrigger.getAttribute('data-id');
        if (!productId) {
          App.showMessage('productsMessage', 'Invalid product selection.', 'error');
          return;
        }

        handleProductDelete(productId);
      }
    });

    const editForm = document.getElementById('editProductForm');
    if (editForm) {
      editForm.addEventListener('submit', handleEditProductSubmit);
    }

    const cancelEditBtn = document.getElementById('cancelEditProductBtn');
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', closeEditProductModal);
    }

    const editModal = document.getElementById('editProductModal');
    if (editModal) {
      editModal.addEventListener('click', function (event) {
        if (event.target === editModal) {
          closeEditProductModal();
        }
      });
    }
  }

  function initAddProductPage() {
    const form = document.getElementById('addProductForm');
    if (!form) return;

    const startScannerBtn = document.getElementById('startProductCameraBtn');
    if (startScannerBtn) {
      startScannerBtn.addEventListener('click', function () {
        if (productCameraScannerRunning || productCameraScannerInitializing) {
          stopProductCameraScanner();
          return;
        }

        startProductCameraScanner();
      });
    }

    bindProductScannerCleanup();
    form.addEventListener('submit', handleAddProduct);
  }

  document.addEventListener('DOMContentLoaded', function () {
    initProductsPage();
    initAddProductPage();
  });
})();
