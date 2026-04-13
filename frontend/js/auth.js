(function () {
  function redirectIfLoggedIn() {
    if (App.getToken()) {
      window.location.href = 'index.html';
    }
  }

  async function handleRegisterSubmit(event) {
    event.preventDefault();
    App.clearMessage('registerMessage');

    const email = document.getElementById('registerEmail').value.trim();
    const shopName = document.getElementById('shopName').value.trim();

    try {
      await App.apiFetch('/api/auth/register', {
        method: 'POST',
        auth: false,
        body: { email, shopName },
      });

      localStorage.setItem('pendingEmail', email);
      localStorage.setItem('otpMode', 'register');
      App.showMessage('registerMessage', 'OTP sent. Redirecting to verification page...', 'success');

      setTimeout(function () {
        window.location.href = `verify-otp.html?email=${encodeURIComponent(email)}&mode=register`;
      }, 700);
    } catch (error) {
      App.showMessage('registerMessage', error.message, 'error');
    }
  }

  async function sendLoginOtp(email) {
    await App.apiFetch('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: { email },
    });
  }

  async function verifyOtp(email, otp, messageId) {
    const data = await App.apiFetch('/api/auth/verify-otp', {
      method: 'POST',
      auth: false,
      body: { email, otp },
    });

    App.setToken(data.token);
    App.setShopName(data.shopName || 'Inventory');
    App.showMessage(messageId, 'Login successful. Redirecting...', 'success');

    setTimeout(function () {
      window.location.href = 'index.html';
    }, 700);
  }

  async function handleLoginRequest(event) {
    event.preventDefault();
    App.clearMessage('loginMessage');

    const email = document.getElementById('loginEmail').value.trim();
    const otpSection = document.getElementById('loginOtpSection');

    try {
      await sendLoginOtp(email);
      localStorage.setItem('pendingEmail', email);
      localStorage.setItem('otpMode', 'login');

      App.showMessage('loginMessage', 'OTP sent. Enter OTP to continue.', 'success');
      otpSection.style.display = 'block';
      document.getElementById('loginOtp').focus();
    } catch (error) {
      App.showMessage('loginMessage', error.message, 'error');
    }
  }

  async function handleLoginVerify(event) {
    event.preventDefault();
    App.clearMessage('loginMessage');

    const email = document.getElementById('loginEmail').value.trim();
    const otp = document.getElementById('loginOtp').value.trim();

    try {
      await verifyOtp(email, otp, 'loginMessage');
    } catch (error) {
      App.showMessage('loginMessage', error.message, 'error');
    }
  }

  async function handleVerifyPageSubmit(event) {
    event.preventDefault();
    App.clearMessage('verifyMessage');

    const email = document.getElementById('verifyEmail').value.trim();
    const otp = document.getElementById('verifyOtp').value.trim();

    try {
      await verifyOtp(email, otp, 'verifyMessage');
    } catch (error) {
      App.showMessage('verifyMessage', error.message, 'error');
    }
  }

  async function handleResendOtp() {
    App.clearMessage('verifyMessage');

    const email = document.getElementById('verifyEmail').value.trim();
    const mode = document.getElementById('otpMode').value;

    try {
      if (mode === 'login') {
        await sendLoginOtp(email);
      } else {
        const fallbackShopName = localStorage.getItem('pendingShopName') || 'My Shop';
        await App.apiFetch('/api/auth/register', {
          method: 'POST',
          auth: false,
          body: { email, shopName: fallbackShopName },
        });
      }

      App.showMessage('verifyMessage', 'OTP resent successfully.', 'success');
    } catch (error) {
      App.showMessage('verifyMessage', error.message, 'error');
    }
  }

  function initRegisterPage() {
    const form = document.getElementById('registerForm');
    if (!form) return;

    redirectIfLoggedIn();

    const shopNameInput = document.getElementById('shopName');
    form.addEventListener('submit', function (event) {
      localStorage.setItem('pendingShopName', shopNameInput.value.trim());
      handleRegisterSubmit(event);
    });
  }

  function initLoginPage() {
    const requestForm = document.getElementById('loginRequestForm');
    const verifyForm = document.getElementById('loginVerifyForm');
    if (!requestForm || !verifyForm) return;

    redirectIfLoggedIn();

    requestForm.addEventListener('submit', handleLoginRequest);
    verifyForm.addEventListener('submit', handleLoginVerify);

    const resendBtn = document.getElementById('resendLoginOtpBtn');
    if (resendBtn) {
      resendBtn.addEventListener('click', async function () {
        const email = document.getElementById('loginEmail').value.trim();
        if (!email) {
          App.showMessage('loginMessage', 'Enter email first.', 'error');
          return;
        }

        try {
          await sendLoginOtp(email);
          App.showMessage('loginMessage', 'A fresh OTP has been sent.', 'success');
        } catch (error) {
          App.showMessage('loginMessage', error.message, 'error');
        }
      });
    }
  }

  function initVerifyPage() {
    const form = document.getElementById('verifyOtpForm');
    if (!form) return;

    redirectIfLoggedIn();

    const params = new URLSearchParams(window.location.search);
    const email = params.get('email') || localStorage.getItem('pendingEmail') || '';
    const mode = params.get('mode') || localStorage.getItem('otpMode') || 'register';

    document.getElementById('verifyEmail').value = email;
    document.getElementById('otpMode').value = mode;

    const hint = document.getElementById('verifyHint');
    if (hint) {
      hint.textContent = mode === 'login' ? 'Enter login OTP for your account.' : 'Enter registration OTP to verify your account.';
    }

    form.addEventListener('submit', handleVerifyPageSubmit);

    const resendBtn = document.getElementById('resendOtpBtn');
    if (resendBtn) {
      resendBtn.addEventListener('click', handleResendOtp);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initRegisterPage();
    initLoginPage();
    initVerifyPage();
  });
})();
