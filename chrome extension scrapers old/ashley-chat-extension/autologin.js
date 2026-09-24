// Ashley LivePerson Chat Scraper - Auto Login Script
(function () {
  'use strict';

  function log(msg) { console.log('[LP AutoLogin]', msg); }

  function typeIntoField(field, value) {
    return new Promise(resolve => {
      field.focus();
      field.dispatchEvent(new Event('focus', { bubbles: true }));

      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (nativeSetter && nativeSetter.set) nativeSetter.set.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));

      let i = 0;
      function typeNext() {
        if (i >= value.length) {
          field.dispatchEvent(new Event('change', { bubbles: true }));
          resolve();
          return;
        }
        const char = value[i];
        const currentVal = value.slice(0, i + 1);
        field.dispatchEvent(new KeyboardEvent('keydown',  { key: char, keyCode: char.charCodeAt(0), which: char.charCodeAt(0), bubbles: true, cancelable: true }));
        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(field, currentVal);
        field.dispatchEvent(new KeyboardEvent('keypress', { key: char, charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0), bubbles: true, cancelable: true }));
        field.dispatchEvent(new InputEvent('input',       { data: char, inputType: 'insertText', bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keyup',    { key: char, keyCode: char.charCodeAt(0), which: char.charCodeAt(0), bubbles: true, cancelable: true }));
        i++;
        setTimeout(typeNext, 18);
      }
      typeNext();
    });
  }

  function pressKey(field, key, keyCode) {
    field.focus();
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      field.dispatchEvent(new KeyboardEvent(type, {
        key, code: key, keyCode, which: keyCode,
        bubbles: true, cancelable: true
      }));
    });
    log(key + ' fired on: ' + (field.id || field.name || field.type));
  }

  function pressEnter(field) { pressKey(field, 'Enter', 13); }
  function pressTab(field)  { pressKey(field, 'Tab',   9);  }

  function getFieldValue(field) {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    return d && d.get ? d.get.call(field) : field.value;
  }

  function isAutofilled(field) {
    try { return field.matches(':-webkit-autofill') || field.matches(':autofill'); }
    catch (e) { return false; }
  }

  // ── Credential overlay ────────────────────────────────────────────────
  function injectCredentialUI(usernameField, passwordField) {
    if (document.getElementById('lp-cred-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'lp-cred-overlay';
    overlay.innerHTML = `
      <div id="lp-cred-box">
        <div id="lp-cred-title">💾 Ashley Scraper — Save Credentials</div>
        <input id="lp-cred-user" type="email" placeholder="LivePerson email" autocomplete="username" />
        <input id="lp-cred-pass" type="password" placeholder="Password" autocomplete="current-password" />
        <div id="lp-cred-buttons">
          <button id="lp-cred-save">Save &amp; Login</button>
          <button id="lp-cred-dismiss">✕</button>
        </div>
        <div id="lp-cred-status"></div>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      #lp-cred-overlay { position:fixed; bottom:24px; right:24px; z-index:999999; font-family:'Segoe UI',Arial,sans-serif; }
      #lp-cred-box { background:#0d1117; border:1px solid #3b82f6; border-radius:10px; padding:14px 16px; width:260px; box-shadow:0 4px 24px rgba(59,130,246,0.25); }
      #lp-cred-title { font-size:12px; font-weight:700; color:#60a5fa; margin-bottom:10px; }
      #lp-cred-box input { width:100%; box-sizing:border-box; background:#111827; border:1px solid #1f2937; border-radius:6px; color:#e0e0e0; padding:7px 9px; font-size:12px; margin-bottom:7px; outline:none; }
      #lp-cred-box input:focus { border-color:#3b82f6; }
      #lp-cred-buttons { display:flex; gap:6px; }
      #lp-cred-save { flex:1; background:linear-gradient(135deg,#1e3a8a,#3b82f6); color:#fff; border:none; border-radius:6px; padding:7px 10px; font-size:12px; font-weight:600; cursor:pointer; }
      #lp-cred-dismiss { background:#1f2937; color:#9ca3af; border:none; border-radius:6px; padding:7px 10px; font-size:12px; cursor:pointer; }
      #lp-cred-status { font-size:10px; margin-top:7px; min-height:14px; text-align:center; }`;
    document.head.appendChild(style);
    document.body.appendChild(overlay);

    chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS' }, (res) => {
      if (res && res.username) {
        document.getElementById('lp-cred-user').value = res.username;
        document.getElementById('lp-cred-pass').value = res.password || '';
        setStatus('✅ Using saved credentials', '#22c55e');
      }
    });

    function setStatus(msg, color) {
      const el = document.getElementById('lp-cred-status');
      if (el) { el.textContent = msg; el.style.color = color; }
    }
    document.getElementById('lp-cred-save').onclick = () => {
      const username = document.getElementById('lp-cred-user').value.trim();
      const password = document.getElementById('lp-cred-pass').value;
      if (!username || !password) { setStatus('⚠️ Enter both fields', '#f59e0b'); return; }
      chrome.runtime.sendMessage({ type: 'SAVE_CREDENTIALS', username, password }, () => {
        setStatus('✅ Saved! Logging in...', '#22c55e');
        setTimeout(() => { overlay.remove(); doCredentialLogin(usernameField, passwordField, username, password); }, 600);
      });
    };
    document.getElementById('lp-cred-dismiss').onclick = () => overlay.remove();
  }

  // ── Type username → Tab → type password → Enter ───────────────────────
  async function doCredentialLogin(usernameField, passwordField, username, password) {
    log('Typing username...');
    await typeIntoField(usernameField, username);
    await new Promise(r => setTimeout(r, 200));

    // Tab from username to password — simulates natural user flow
    log('Tabbing to password field...');
    pressTab(usernameField);
    await new Promise(r => setTimeout(r, 300));

    log('Typing password...');
    await typeIntoField(passwordField, password);
    await new Promise(r => setTimeout(r, 400));

    // Click the submit button directly — more reliable than Enter for this form
    const submitBtn =
      document.querySelector('button[data-action-button-primary="true"]') ||
      document.querySelector('button[type="submit"]') ||
      document.querySelector('.submitButton');
    if (submitBtn) {
      log('Clicking submit button: ' + (submitBtn.textContent.trim() || submitBtn.className));
      submitBtn.click();
    } else {
      log('Submit button not found — pressing Enter on password field...');
      pressEnter(passwordField);
    }
  }

  // ── Screen 1: Account Number — DO NOT TOUCH ───────────────────────────
  function handleAccountScreen() {
    log('Handling Account Number screen...');

    function tryFind() {
      const accountField =
        document.querySelector('#siteNumber') ||
        document.querySelector('input[name="siteNumber"]') ||
        document.querySelector('input[type="text"]') ||
        document.querySelector('input[type="number"]');

      if (!accountField) { setTimeout(tryFind, 500); return; }

      log('Account field found. Value: "' + getFieldValue(accountField) + '"');

      const val = getFieldValue(accountField);
      if (val && val.trim()) {
        setTimeout(() => pressEnter(accountField), 800);
        return;
      }

      let attempts = 0;
      const interval = setInterval(() => {
        const v = getFieldValue(accountField);
        if ((v && v.trim()) || isAutofilled(accountField)) {
          clearInterval(interval);
          log('Account value ready: ' + v);
          setTimeout(() => pressEnter(accountField), 800);
        }
        if (++attempts > 60) { clearInterval(interval); log('Gave up on account field'); }
      }, 300);
    }

    tryFind();
  }

  // ── Screen 2: Credentials ─────────────────────────────────────────────
  function handleCredentialScreen() {
    log('Handling Credentials screen...');
    function tryFind() {
      const passwordField =
        document.querySelector('#password') ||
        document.querySelector('input[type="password"]');
      // Prefer #proxy-username (the visible field) over #username (hidden shadow field)
      const usernameField =
        document.querySelector('#proxy-username') ||
        document.querySelector('input[autocomplete="username"]:not([style*="display"])') ||
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[name="username"]:not([style*="display"])') ||
        [...document.querySelectorAll('input[type="text"]')].find(el => el.offsetParent !== null) ||
        document.querySelector('#username');
      if (!passwordField || !usernameField) { setTimeout(tryFind, 500); return; }

      log('Both fields found — checking stored credentials...');
      chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS' }, (res) => {
        if (res && res.username && res.password) {
          log('Stored credentials found — logging in...');
          doCredentialLogin(usernameField, passwordField, res.username, res.password);
        } else {
          log('No stored credentials — showing UI...');
          injectCredentialUI(usernameField, passwordField);
        }
      });
    }
    tryFind();
  }

  // ── Route ─────────────────────────────────────────────────────────────
  function init() {
    log('Page: ' + location.href);

    // Check pause flag first — if paused from the popup, do nothing at all
    chrome.storage.local.get('lp_autologin_paused', res => {
      if (res.lp_autologin_paused) {
        log('Auto-login is PAUSED via popup — skipping. Re-enable in the extension popup.');
        return;
      }

      const isAccountScreen =
        new URLSearchParams(location.search).has('accountId') ||
        location.hostname === 'authentication.liveperson.net' ||
        !!document.querySelector('#siteNumber') ||
        !!document.querySelector('input[name="siteNumber"]');
      if (isAccountScreen) handleAccountScreen();
      else handleCredentialScreen();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();