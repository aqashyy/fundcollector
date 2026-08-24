/* =============================================
   FundTrack — app.js
   Full application logic with localStorage
   ============================================= */

'use strict';

// ============================================================
// UTILITIES
// ============================================================

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatCurrency(amount) {
  const n = Number(amount) || 0;
  return '₹' + n.toLocaleString('en-IN');
}

function toast(message, type = 'info', duration = 3000) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const id = 'toast-' + Date.now();
  const $el = $(`
    <div id="${id}" class="toast-item toast-${type}">
      <span>${icons[type] || icons.info}</span>
      <span>${message}</span>
    </div>
  `);
  $('#toast').append($el);
  setTimeout(() => {
    $el.css({ opacity: 0, transform: 'translateX(16px)', transition: 'all 0.3s ease' });
    setTimeout(() => $el.remove(), 300);
  }, duration);
}

// ============================================================
// STORAGE & CLOUD SYNC
// ============================================================

const STORAGE_KEY = 'fundtrack_v1';

function defaultData() {
  return {
    version: 1,
    adminPassword: 'admin123',
    activeEventId: null,
    events: [],
    members: []
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultData(), ...JSON.parse(raw) };
  } catch (e) { console.warn('loadData error', e); }
  return defaultData();
}

const Cloud = {
  db: null,
  isLive: false,
  _isPushing: false,

  getConfig() {
    if (typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL) {
      return FIREBASE_CONFIG;
    }
    return null;
  },

  init() {
    const config = this.getConfig();
    if (!config || !config.databaseURL || typeof firebase === 'undefined') {
      this.isLive = false;
      return;
    }

    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      this.db = firebase.database();
      this.isLive = true;

      // Sign in anonymously for write access if Auth is enabled
      if (firebase.auth && !firebase.auth().currentUser) {
        firebase.auth().signInAnonymously().catch(e => console.warn('Auth notice:', e?.message || e));
      }

      this.listen();
    } catch (err) {
      console.warn('Firebase init error:', err);
      this.isLive = false;
    }
  },

  listen() {
    if (!this.db || !this.isLive) return;
    this.db.ref('fundtrack').on('value', snapshot => {
      const val = snapshot.val();
      if (val && val.events) {
        const currentPassword = AppState.data.adminPassword;
        AppState.data = { ...defaultData(), ...val };
        if (!AppState.data.adminPassword) AppState.data.adminPassword = currentPassword;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(AppState.data)); } catch(e){}
        Render.all();
      }
    }, err => {
      console.warn('Firebase listen notice:', err?.message || err);
    });
  },

  push() {
    if (this.db && this.isLive && AppState.isAdmin && !this._isPushing) {
      this._isPushing = true;
      const payload = {
        version: AppState.data.version || 1,
        activeEventId: AppState.data.activeEventId || null,
        events: AppState.data.events || [],
        members: AppState.data.members || []
      };
      this.db.ref('fundtrack').set(payload)
        .catch(e => console.warn('Cloud sync write permission notice:', e?.message || e))
        .finally(() => { this._isPushing = false; });
    }
  }
};

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(AppState.data));
  } catch (e) {
    toast('Storage error — data may not be saved', 'error');
  }
  Cloud.push();
}

// ============================================================
// STATE
// ============================================================

const AppState = {
  data: loadData(),
  isAdmin: false,
  currentFilter: 'all',
  isSharedView: false,
  get currentEventId() { return this.data.activeEventId; },
  set currentEventId(id) { this.data.activeEventId = id; }
};

// ============================================================
// DATA LAYER
// ============================================================

const Data = {
  // --- Events ---
  getEvents() { return AppState.data.events || []; },
  getEvent(id) { return this.getEvents().find(e => e.id === id) || null; },
  getActiveEvent() {
    const id = AppState.currentEventId;
    const events = this.getEvents();
    if (id) {
      const found = this.getEvent(id);
      if (found) return found;
    }
    return events[0] || null;
  },
  setActiveEvent(id) {
    AppState.currentEventId = id;
    saveData();
  },
  createEvent(data) {
    const event = {
      id: uuid(),
      name: data.name || 'Untitled Event',
      defaultAmount: parseInt(data.defaultAmount) || 250,
      targetAmount: parseInt(data.targetAmount) || 0,
      upiNumber: (data.upiNumber || '').trim(),
      upiName: (data.upiName || '').trim(),
      upiId: (data.upiId || '').trim(),
      qrCode: data.qrCode || null,
      createdAt: Date.now()
    };
    AppState.data.events.unshift(event);
    if (!AppState.currentEventId) {
      this.setActiveEvent(event.id);
    }
    saveData();
    return event;
  },
  updateEvent(id, data) {
    const idx = AppState.data.events.findIndex(e => e.id === id);
    if (idx === -1) return false;
    AppState.data.events[idx] = { ...AppState.data.events[idx], ...data };
    saveData();
    return true;
  },
  deleteEvent(id) {
    AppState.data.events = AppState.data.events.filter(e => e.id !== id);
    AppState.data.members = AppState.data.members.filter(m => m.eventId !== id);
    if (AppState.currentEventId === id) {
      AppState.currentEventId = AppState.data.events[0]?.id || null;
    }
    saveData();
  },

  // --- Members ---
  getMembers(eventId) {
    return (AppState.data.members || [])
      .filter(m => m.eventId === eventId)
      .sort((a, b) => (a.serial || 0) - (b.serial || 0));
  },
  getMember(id) { return (AppState.data.members || []).find(m => m.id === id) || null; },
  createMember(data) {
    const members = this.getMembers(data.eventId);
    const maxSerial = members.length > 0 ? Math.max(...members.map(m => m.serial || 0)) : 0;
    const member = {
      id: uuid(),
      eventId: data.eventId,
      serial: data.serial != null ? parseInt(data.serial) : maxSerial + 1,
      name: (data.name || '').trim(),
      amount: data.paid ? (parseInt(data.amount) || 0) : 0,
      method: data.paid ? (data.method || null) : null,
      paid: data.paid || false,
      notes: (data.notes || '').trim()
    };
    AppState.data.members.push(member);
    saveData();
    return member;
  },
  updateMember(id, updates) {
    const idx = AppState.data.members.findIndex(m => m.id === id);
    if (idx === -1) return false;
    AppState.data.members[idx] = { ...AppState.data.members[idx], ...updates };
    saveData();
    return true;
  },
  deleteMember(id) {
    AppState.data.members = AppState.data.members.filter(m => m.id !== id);
    saveData();
  },

  // --- Stats ---
  getStats(eventId) {
    const event = this.getEvent(eventId);
    const members = this.getMembers(eventId);
    const paid = members.filter(m => m.paid);
    const pending = members.filter(m => !m.paid);
    const totalCollected = paid.reduce((s, m) => s + (m.amount || 0), 0);
    const totalExpected = members.reduce((s, m) => s + (m.amount || event?.defaultAmount || 0), 0);
    // treat legacy 'gpay' as 'online' for backward compat
    const isOnline = m => m.method === 'online' || m.method === 'gpay';
    const isCash   = m => m.method === 'cash';
    const onlineTotal = paid.filter(isOnline).reduce((s, m) => s + (m.amount || 0), 0);
    const cashTotal   = paid.filter(isCash).reduce((s, m) => s + (m.amount || 0), 0);
    return {
      total: members.length,
      paid: paid.length,
      pending: pending.length,
      totalCollected,
      totalExpected,
      onlineCount: paid.filter(isOnline).length,
      cashCount:   paid.filter(isCash).length,
      onlineTotal,
      cashTotal,
      percent: totalExpected > 0 ? Math.min(100, Math.round(totalCollected / totalExpected * 100)) : 0
    };
  }
};

// ============================================================
// MODAL SYSTEM
// ============================================================

const Modal = {
  open(htmlContent) {
    $('#modal-content').html(htmlContent);
    $('#modal-overlay').css('display', 'flex');
    setTimeout(() => $('#modal-box').addClass('modal-enter'), 10);
  },
  close() {
    $('#modal-overlay').fadeOut(150);
    setTimeout(() => {
      $('#modal-content').html('');
      $('#modal-box').removeClass('modal-enter');
    }, 150);
  }
};

// Close modal on overlay click
$(document).on('click', '#modal-overlay', function(e) {
  if ($(e.target).is('#modal-overlay')) Modal.close();
});
$(document).on('click', '#modal-close', () => Modal.close());

// ============================================================
// RENDER
// ============================================================

const Render = {
  all() {
    this.header();
    if (AppState.isAdmin) {
      this.adminView();
    } else {
      this.publicView();
    }
  },

  header() {
    const event = Data.getActiveEvent();
    const events = Data.getEvents();

    // Event switcher
    if (event && events.length > 0) {
      $('#active-event-name').text(event.name);
      $('#event-selector-btn').removeClass('hidden');
    } else {
      $('#event-selector-btn').addClass('hidden');
    }

    // Admin button state
    if (AppState.isAdmin) {
      $('#admin-btn-text').text('Exit');
      $('#admin-btn-icon').attr('class', 'fas fa-door-open text-orange-400 text-[10px]');
    } else {
      $('#admin-btn-text').text('Admin');
      $('#admin-btn-icon').attr('class', 'fas fa-shield-halved text-emerald-400 text-[10px]');
    }
  },

  publicView() {
    $('#admin-view').addClass('hidden');
    $('#public-view').removeClass('hidden');

    const event = Data.getActiveEvent();

    if (!event) {
      $('#event-hero, #stats-row, #progress-section, #share-section').hide();
      $('.mt-5').last().hide();
      $('#empty-state').removeClass('hidden');
      $('#member-list').html('');
      return;
    }

    $('#empty-state').addClass('hidden');
    $('#event-hero, #stats-row, #progress-section, #share-section').show();

    const stats = Data.getStats(event.id);
    const members = Data.getMembers(event.id);

    // --- Hero Card ---
    $('#event-hero').html(`
      <div class="glass-card rounded-2xl p-5 relative overflow-hidden">
        <div class="hero-blob w-40 h-40 bg-emerald-500/8 top-[-40px] right-[-40px]"></div>
        <div class="hero-blob w-24 h-24 bg-blue-500/5 bottom-[-20px] left-[10%]"></div>
        <div class="relative z-10">
          <div class="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.12em] mb-1.5">Active Fund</div>
          <h2 class="text-2xl font-black leading-tight">${escHtml(event.name)}</h2>
          ${event.defaultAmount ? `
            <div class="mt-3 inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1.5">
              <i class="fas fa-tag text-emerald-400 text-xs"></i>
              <span class="text-xs font-semibold text-emerald-300">${formatCurrency(event.defaultAmount)} per person</span>
            </div>` : ''}
        </div>
        <div class="absolute top-4 right-5 text-right z-10">
          <div class="text-3xl font-black text-emerald-400 leading-none">${stats.percent}%</div>
          <div class="text-[10px] text-gray-500 mt-0.5 font-medium">collected</div>
        </div>
      </div>
    `);

    // --- Payment Details Card ---
    const hasPaymentInfo = event.upiNumber || event.upiId || event.qrCode;
    if (hasPaymentInfo) {
      // Build UPI deep link — prefer upiId, fallback to number@upi
      const upiPa = event.upiId || (event.upiNumber ? event.upiNumber + '@upi' : '');
      const upiName = encodeURIComponent(event.upiName || 'Fund Collection');
      const upiAmt  = event.defaultAmount || 250;
      const upiNote = encodeURIComponent(event.name);
      const query   = `pa=${encodeURIComponent(upiPa)}&pn=${upiName}&am=${upiAmt}&cu=INR&tn=${upiNote}`;
      const upiLink = upiPa ? `upi://pay?${query}` : '';

      // App-specific deep links (exact payment intent paths with iOS/Android compatibility)
      const isAndroid      = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
      const gpayLink       = upiPa ? `gpay://upi/pay?${query}` : '';
      const phonepeLink    = upiPa ? `phonepe://pay?${query}` : '';
      const paytmLink      = upiPa ? `paytmmp://pay?${query}` : '';
      const supermoneyLink = upiPa
        ? (isAndroid
            ? `intent://pay?${query}#Intent;scheme=upi;package=com.supermoney.app;end`
            : `supermoney://pay?${query}`)
        : '';

      const payCard = `
        <div class="glass-card rounded-2xl p-4 mt-4">
          <div class="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-3">
            <i class="fas fa-bolt mr-1"></i> Pay Here
          </div>
          <div class="flex gap-4 items-start mb-4">
            ${event.qrCode ? `
              <div class="flex-shrink-0">
                <img src="${event.qrCode}" alt="Payment QR Code"
                  class="w-24 h-24 rounded-xl border border-white/10 object-cover bg-white">
              </div>` : ''}
            <div class="flex-1 min-w-0 space-y-2">
              ${event.upiNumber ? `
                <div class="flex items-center gap-2">
                  <div class="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                    <i class="fas fa-mobile-screen text-blue-400 text-xs"></i>
                  </div>
                  <div>
                    <div class="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">Phone / GPay</div>
                    <div class="font-bold text-sm text-white">${escHtml(event.upiNumber)}</div>
                  </div>
                </div>` : ''}
              ${event.upiId ? `
                <div class="flex items-center gap-2">
                  <div class="w-7 h-7 rounded-lg bg-purple-500/15 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                    <i class="fas fa-at text-purple-400 text-xs"></i>
                  </div>
                  <div>
                    <div class="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">UPI ID</div>
                    <div class="font-bold text-sm text-white font-mono">${escHtml(event.upiId)}</div>
                  </div>
                </div>` : ''}
              ${event.upiName ? `
                <div class="text-[11px] text-gray-500">Name: <span class="text-gray-300">${escHtml(event.upiName)}</span></div>` : ''}
            </div>
          </div>

          ${upiLink ? `
          <!-- Amount Input & Quick Chips -->
          <div class="pt-2 pb-3 border-t border-white/8">
            <div class="flex items-center justify-between mb-2">
              <label class="text-[11px] font-semibold text-gray-400">Contribution Amount</label>
              <span class="text-[10px] text-emerald-400 font-medium">Editable / Any Amount</span>
            </div>

            <div class="relative mb-2.5">
              <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">₹</span>
              <input type="number" id="pay-amount-input"
                class="form-input pl-8 pr-3 py-2 text-sm font-bold text-emerald-300 w-full"
                value="${upiAmt}" min="1" placeholder="Enter custom amount (or leave blank)"
                oninput="App.updatePayAmount(this.value)">
            </div>

            <!-- Quick Chips -->
            <div class="flex items-center gap-1.5 flex-wrap">
              <button type="button" class="amount-chip active-chip" data-amount="${upiAmt}" onclick="App.updatePayAmount(${upiAmt})">
                ₹${upiAmt}
              </button>
              ${upiAmt !== 300 ? `<button type="button" class="amount-chip" data-amount="300" onclick="App.updatePayAmount(300)">₹300</button>` : ''}
              ${upiAmt !== 500 ? `<button type="button" class="amount-chip" data-amount="500" onclick="App.updatePayAmount(500)">₹500</button>` : ''}
              <button type="button" class="amount-chip" data-amount="1000" onclick="App.updatePayAmount(1000)">₹1,000</button>
              <button type="button" class="amount-chip" data-amount="0" onclick="App.updatePayAmount(0)" title="Enter any amount freely in your UPI app">
                Any Amount ✍️
              </button>
            </div>
          </div>

          <!-- Big Pay Now Button -->
          <a href="${upiLink}" id="btn-pay-now" class="pay-now-btn flex items-center justify-center gap-2.5 w-full py-3.5 rounded-xl mb-3">
            <i class="fas fa-bolt text-lg"></i>
            <span id="btn-pay-now-text" class="font-black text-base">Pay ${formatCurrency(upiAmt)} Now</span>
          </a>

          <!-- App Shortcuts (2x2 grid) -->
          <div class="grid grid-cols-2 gap-2">
            <a href="${gpayLink}" id="btn-app-gpay" class="upi-app-btn flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 hover:bg-white/10 transition-all">
              <img src="img/gpay.svg" width="28" height="28" alt="Google Pay" class="rounded-lg">
              <span class="text-[12px] font-semibold text-gray-200">GPay</span>
            </a>
            <a href="${phonepeLink}" id="btn-app-phonepe" class="upi-app-btn flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 hover:bg-white/10 transition-all">
              <img src="img/phonepe.svg" width="28" height="28" alt="PhonePe" class="rounded-lg">
              <span class="text-[12px] font-semibold text-gray-200">PhonePe</span>
            </a>
            <a href="${paytmLink}" id="btn-app-paytm" class="upi-app-btn flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 hover:bg-white/10 transition-all">
              <img src="img/paytm.svg" width="28" height="28" alt="Paytm" class="rounded-lg">
              <span class="text-[12px] font-semibold text-gray-200">Paytm</span>
            </a>
            <a href="${supermoneyLink}" id="btn-app-supermoney" class="upi-app-btn flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/5 border border-white/8 hover:bg-white/10 transition-all">
              <img src="img/supermoney.svg" width="28" height="28" alt="SuperMoney" class="rounded-lg">
              <span class="text-[12px] font-semibold text-gray-200">SuperMoney</span>
            </a>
          </div>
          <p class="text-[10px] text-gray-600 text-center mt-2.5">
            <i class="fas fa-mobile-screen mr-1"></i>Tap to open payment app on your phone
          </p>
          ` : ''}
        </div>
      `;
      $('#event-hero').append(payCard);
    }

    // --- Stats Row ---
    $('#stats-row').html(`
      <div class="stat-card">
        <div class="text-lg font-black text-emerald-400 leading-tight">${formatCurrency(stats.totalCollected)}</div>
        <div class="text-[10px] text-gray-500 mt-1 font-medium">COLLECTED</div>
      </div>
      <div class="stat-card">
        <div class="text-lg font-black text-white leading-tight">${stats.paid}</div>
        <div class="text-[10px] text-gray-500 mt-1 font-medium">PAID ✅</div>
      </div>
      <div class="stat-card">
        <div class="text-lg font-black text-orange-400 leading-tight">${stats.pending}</div>
        <div class="text-[10px] text-gray-500 mt-1 font-medium">PENDING ⏳</div>
      </div>
    `);

    // --- Progress ---
    const safePercent = Math.max(0, Math.min(100, stats.percent));
    $('#progress-section').html(`
      <div class="glass-card rounded-2xl p-4">
        <div class="flex items-center justify-between mb-2.5">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Progress</span>
          <span class="text-xs font-bold">
            <span class="text-emerald-400">${formatCurrency(stats.totalCollected)}</span>
            <span class="text-gray-600"> / ${formatCurrency(stats.totalExpected)}</span>
          </span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="prog-fill" style="width:0%"></div>
        </div>
        <div class="flex items-center justify-between mt-3">
          <span class="text-[11px] text-gray-500">
            <i class="fas fa-wifi text-blue-400 mr-1"></i>
            Online: ${formatCurrency(stats.onlineTotal)}
          </span>
          <span class="text-[11px] text-gray-500">
            <i class="fas fa-money-bill text-yellow-400 mr-1"></i>
            Cash: ${formatCurrency(stats.cashTotal)}
          </span>
          <span class="text-[11px] text-gray-500">${stats.paid}/${stats.total} members</span>
        </div>
      </div>
    `);

    // Animate progress bar after render
    setTimeout(() => $('#prog-fill').css('width', safePercent + '%'), 80);

    // --- Member List ---
    this.memberList(members, event);
  },

  memberList(members, event) {
    const filter = AppState.currentFilter;

    // Leaderboard sort: paid by amount desc, pending at bottom
    const paidSorted    = members.filter(m => m.paid).sort((a, b) => (b.amount || 0) - (a.amount || 0));
    const pendingSorted = members.filter(m => !m.paid);
    const ranked        = [...paidSorted, ...pendingSorted];

    let filtered = ranked;
    if (filter === 'paid')    filtered = ranked.filter(m => m.paid);
    if (filter === 'pending') filtered = ranked.filter(m => !m.paid);

    if (filtered.length === 0) {
      $('#member-list').html(`
        <div class="text-center py-10 text-gray-600 text-sm">
          <i class="fas fa-inbox text-2xl mb-3 block"></i>
          ${filter === 'paid' ? 'No paid members yet' : filter === 'pending' ? 'No pending members 🎉' : 'No members added'}
        </div>
      `);
      return;
    }

    // Assign rank (by amount, paid only)
    const rankMap = {};
    paidSorted.forEach((m, i) => { rankMap[m.id] = i + 1; });

    const html = filtered.map((m, i) => {
      const rank = rankMap[m.id] || null;

      let rankBadge;
      if (!m.paid) {
        rankBadge = `<div class="serial-badge" style="opacity:0.35">${m.serial}</div>`;
      } else if (rank === 1) {
        rankBadge = `<div class="serial-badge rank-gold">&#x1F451;</div>`;
      } else if (rank === 2) {
        rankBadge = `<div class="serial-badge rank-silver">&#x1F948;</div>`;
      } else if (rank === 3) {
        rankBadge = `<div class="serial-badge rank-bronze">&#x1F949;</div>`;
      } else {
        rankBadge = `<div class="serial-badge rank-normal">#${rank}</div>`;
      }

      const extraClass = rank === 1 ? 'rank-1-card' : rank === 2 ? 'rank-2-card' : rank === 3 ? 'rank-3-card' : '';

      const isOnline = m.method === 'online' || m.method === 'gpay';
      const methodBadge = isOnline
        ? `<span class="badge badge-online"><i class="fas fa-wifi"></i> Online</span>`
        : m.method === 'cash'
        ? `<span class="badge badge-cash"><i class="fas fa-money-bill"></i> Cash</span>`
        : '';

      const statusBadge = m.paid
        ? `<span class="badge badge-paid">&#x2705; Paid</span>`
        : `<span class="badge badge-pending">&#x23F3; Pending</span>`;

      const amountColor = rank === 1 ? 'text-yellow-400' : rank === 2 ? 'text-slate-300' : rank === 3 ? 'text-orange-400' : 'text-emerald-400';
      const amountDisplay = m.paid
        ? `<div class="text-sm font-black ${amountColor}">${formatCurrency(m.amount)}</div>`
        : `<div class="text-xs text-gray-600 font-medium">${formatCurrency(event?.defaultAmount || 0)}</div>`;

      return `
        <div class="member-card ${m.paid ? 'paid' : 'pending'} ${extraClass}" style="animation-delay:${Math.min(i * 25, 400)}ms">
          ${rankBadge}
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm leading-snug">${escHtml(m.name)}</div>
            <div class="flex items-center gap-1.5 mt-1 flex-wrap">
              ${statusBadge}
              ${methodBadge}
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            ${amountDisplay}
          </div>
        </div>
      `;
    }).join('');

    $('#member-list').html(html);
  },

  adminView() {
    $('#public-view').addClass('hidden');
    $('#admin-view').removeClass('hidden');
    this.adminStats();
    this.eventsList();
    this.adminMemberList();
  },

  adminStats() {
    const event = Data.getActiveEvent();
    if (!event) { $('#admin-stats').html(''); return; }
    const stats = Data.getStats(event.id);
    const bar = Math.max(0, Math.min(100, stats.percent));
    $('#admin-stats').html(`
      <div class="glass-card rounded-2xl p-4">
        <div class="text-[10px] font-bold text-emerald-400 uppercase tracking-widest mb-3">
          ${escHtml(event.name)} — Overview
        </div>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="rounded-xl p-3 bg-emerald-500/10 border border-emerald-500/20">
            <div class="text-xl font-black text-emerald-400">${formatCurrency(stats.totalCollected)}</div>
            <div class="text-[10px] text-gray-500 mt-0.5">Total Collected</div>
          </div>
          <div class="rounded-xl p-3 bg-white/5 border border-white/8">
            <div class="text-xl font-black text-white">${stats.paid}<span class="text-gray-500 font-normal text-sm">/${stats.total}</span></div>
            <div class="text-[10px] text-gray-500 mt-0.5">Members Paid</div>
          </div>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width:${bar}%"></div>
        </div>
        <div class="flex justify-between mt-2 text-[11px] text-gray-600">
          <span>Online ${stats.onlineCount} · ${formatCurrency(stats.onlineTotal)}</span>
          <span>Cash ${stats.cashCount} · ${formatCurrency(stats.cashTotal)}</span>
        </div>
      </div>
    `);
  },

  eventsList() {
    const events = Data.getEvents();
    const activeId = Data.getActiveEvent()?.id;

    if (events.length === 0) {
      $('#events-list').html(`
        <div class="no-event-placeholder py-6">
          <i class="fas fa-calendar-plus text-3xl mb-3 block text-gray-700"></i>
          No events yet — create your first one!
        </div>
      `);
      return;
    }

    const html = events.map(event => {
      const isActive = event.id === activeId;
      const stats = Data.getStats(event.id);
      return `
        <div class="event-item ${isActive ? 'active-event' : ''}">
          <div class="flex items-center gap-3 flex-1 min-w-0" onclick="App.setActiveEvent('${event.id}')">
            <button class="w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all cursor-pointer
              ${isActive ? 'border-emerald-400 bg-emerald-400' : 'border-gray-600 hover:border-gray-400'}">
              ${isActive ? `<i class="fas fa-check text-[8px] text-white"></i>` : ''}
            </button>
            <div class="min-w-0 cursor-pointer">
              <div class="font-semibold text-sm truncate">${escHtml(event.name)}</div>
              <div class="text-[11px] text-gray-500 mt-0.5">
                ${stats.paid}/${stats.total} paid · ${formatCurrency(stats.totalCollected)}
              </div>
            </div>
          </div>
          <div class="flex gap-1.5 flex-shrink-0">
            <button onclick="App.openEditEvent('${event.id}')"
              class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/12 flex items-center justify-center transition-colors">
              <i class="fas fa-pen text-[10px] text-gray-400"></i>
            </button>
            <button onclick="App.deleteEvent('${event.id}')"
              class="w-8 h-8 rounded-lg bg-red-500/8 hover:bg-red-500/20 flex items-center justify-center transition-colors">
              <i class="fas fa-trash text-[10px] text-red-400"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    $('#events-list').html(html);
  },

  adminMemberList() {
    const event = Data.getActiveEvent();
    if (!event) { $('#admin-members-section').addClass('hidden'); return; }

    $('#admin-members-section').removeClass('hidden');
    const members = Data.getMembers(event.id);
    $('#admin-members-count').text(`(${members.length})`);

    if (members.length === 0) {
      $('#admin-member-list').html(`
        <div class="no-event-placeholder py-6">
          <i class="fas fa-user-plus text-3xl mb-3 block text-gray-700"></i>
          No members yet — add your first one!
        </div>
      `);
      return;
    }

    const html = members.map(m => {
      const methodBadge = m.method === 'gpay'
        ? `<span class="badge badge-gpay" style="font-size:9px;padding:1px 6px">GPay</span>`
        : m.method === 'cash'
        ? `<span class="badge badge-cash" style="font-size:9px;padding:1px 6px">Cash</span>`
        : '';
      const isOnlineMember = m.method === 'online' || m.method === 'gpay';
      const adminMethodBadge = isOnlineMember
        ? `<span class="badge badge-online" style="font-size:9px;padding:1px 6px">Online</span>`
        : methodBadge;

      return `
        <div class="admin-member-row">
          <span class="text-[11px] text-gray-600 w-5 flex-shrink-0 font-bold">${m.serial}</span>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold truncate">${escHtml(m.name)}</div>
            <div class="flex items-center gap-1.5 mt-0.5">
              ${m.paid
                ? `<span class="text-[11px] text-emerald-400 font-bold">${formatCurrency(m.amount)}</span>`
                : `<span class="text-[11px] text-gray-600">Pending</span>`}
              ${adminMethodBadge}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <label class="toggle-switch" title="${m.paid ? 'Mark pending' : 'Mark paid'}">
              <input type="checkbox" ${m.paid ? 'checked' : ''}
                onchange="App.togglePaid('${m.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button onclick="App.openEditMember('${m.id}')"
              class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/12 flex items-center justify-center transition-colors">
              <i class="fas fa-pen text-[10px] text-gray-400"></i>
            </button>
            <button onclick="App.deleteMember('${m.id}')"
              class="w-8 h-8 rounded-lg bg-red-500/8 hover:bg-red-500/20 flex items-center justify-center transition-colors">
              <i class="fas fa-trash text-[10px] text-red-400"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    $('#admin-member-list').html(html);
  }
};

// ============================================================
// MAIN APP
// ============================================================

const App = {

  init() {
    // Check for shared data in URL hash
    const hash = window.location.hash;
    if (hash.startsWith('#share=')) {
      try {
        const encoded = hash.slice(7);
        const shared = JSON.parse(atob(encoded));
        this._loadSharedView(shared);
        return;
      } catch (e) {
        console.warn('Invalid share data in URL');
      }
    }

    // Seed data if first run
    seedData();

    // Initialize Cloud Sync (Firebase)
    Cloud.init();

    // Render
    Render.all();
  },

  _loadSharedView(shared) {
    // Read-only view using URL-embedded data
    AppState.data = shared;
    AppState.currentEventId = shared.activeEventId;
    AppState.isAdmin = false;
    AppState.isSharedView = true;
    $('#shared-banner').removeClass('hidden');
    $('#admin-btn').hide();
    Render.publicView();
    Render.header();
  },

  // ---- Dynamic UPI Amount ----
  updatePayAmount(val) {
    const event = Data.getActiveEvent();
    if (!event) return;
    const upiPa = event.upiId || (event.upiNumber ? event.upiNumber + '@upi' : '');
    if (!upiPa) return;
    const upiName = encodeURIComponent(event.upiName || 'Fund Collection');
    const upiNote = encodeURIComponent(event.name);

    const num = parseInt(val);
    const hasAmt = !isNaN(num) && num > 0;
    const buttonText = hasAmt ? `Pay ${formatCurrency(num)} Now` : 'Pay Any Amount Now ✍️';

    if (!hasAmt) {
      $('#pay-amount-input').val('');
    } else {
      $('#pay-amount-input').val(num);
    }

    const query = `pa=${encodeURIComponent(upiPa)}&pn=${upiName}${hasAmt ? `&am=${num}` : ''}&cu=INR&tn=${upiNote}`;
    const isAndroid      = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
    const upiLink        = `upi://pay?${query}`;
    const gpayLink       = `gpay://upi/pay?${query}`;
    const phonepeLink    = `phonepe://pay?${query}`;
    const paytmLink      = `paytmmp://pay?${query}`;
    const supermoneyLink = isAndroid
      ? `intent://pay?${query}#Intent;scheme=upi;package=com.supermoney.app;end`
      : `supermoney://pay?${query}`;

    $('#btn-pay-now').attr('href', upiLink);
    $('#btn-pay-now-text').text(buttonText);
    $('#btn-app-gpay').attr('href', gpayLink);
    $('#btn-app-phonepe').attr('href', phonepeLink);
    $('#btn-app-paytm').attr('href', paytmLink);
    $('#btn-app-supermoney').attr('href', supermoneyLink);

    // Update active chip highlight
    $('.amount-chip').removeClass('active-chip');
    if (isNaN(num) || num <= 0) {
      $('.amount-chip[data-amount="0"]').addClass('active-chip');
    } else {
      $(`.amount-chip[data-amount="${num}"]`).addClass('active-chip');
    }
  },

  // ---- Auth ----
  toggleAdmin() {
    if (AppState.isAdmin) {
      this.logout();
    } else {
      this.openLogin();
    }
  },

  openLogin() {
    Modal.open(`
      <div class="text-center mb-5">
        <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-400 to-green-600 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/30">
          <i class="fas fa-shield-halved text-white text-xl"></i>
        </div>
        <h3 class="text-xl font-black">Admin Login</h3>
        <p class="text-gray-500 text-sm mt-1">Enter your admin password</p>
      </div>
      <div class="space-y-3">
        <div>
          <label class="form-label">Password</label>
          <input type="password" id="login-pw" class="form-input"
            placeholder="Enter password…" autocomplete="current-password">
        </div>
        <button onclick="App.login()" class="btn-primary w-full py-3 text-sm">
          <i class="fas fa-unlock-alt mr-2"></i> Login
        </button>
      </div>
    `);
    setTimeout(() => $('#login-pw').focus(), 150);
    $('#login-pw').on('keypress', e => { if (e.key === 'Enter') App.login(); });
  },

  login() {
    const pw = $('#login-pw').val();
    if (pw === AppState.data.adminPassword) {
      AppState.isAdmin = true;
      if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
        try { firebase.auth().signInAnonymously().catch(e => console.warn('Auth error', e)); } catch(e){}
      }
      Modal.close();
      toast('Welcome, Admin! 👋', 'success');
      Render.all();
    } else {
      $('#login-pw').addClass('error').val('');
      toast('Wrong password!', 'error');
      setTimeout(() => $('#login-pw').removeClass('error'), 1500);
    }
  },

  logout() {
    AppState.isAdmin = false;
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
      try {
        if (firebase.auth().currentUser) {
          firebase.auth().signOut().catch(e => console.warn('Signout error', e));
        }
      } catch(e){}
    }
    toast('Logged out', 'info');
    Render.all();
  },

  // ---- Event Switcher ----
  openEventSwitcher() {
    const events = Data.getEvents();
    const activeId = Data.getActiveEvent()?.id;
    if (events.length === 0) return;

    Modal.open(`
      <h3 class="text-lg font-black mb-4">Switch Event</h3>
      <div class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1">
        ${events.map(e => {
          const s = Data.getStats(e.id);
          const isActive = e.id === activeId;
          return `
            <button onclick="App.switchEvent('${e.id}')"
              class="flex items-center gap-3 p-3 rounded-xl text-left w-full transition-all
                ${isActive
                  ? 'bg-emerald-500/12 border border-emerald-500/30'
                  : 'bg-white/4 border border-white/8 hover:bg-white/8'}">
              <div class="w-9 h-9 rounded-xl ${isActive ? 'bg-emerald-500/20' : 'bg-white/8'} flex items-center justify-center flex-shrink-0">
                <i class="fas fa-calendar-alt ${isActive ? 'text-emerald-400' : 'text-gray-500'} text-sm"></i>
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-bold text-sm truncate">${escHtml(e.name)}</div>
                <div class="text-[11px] text-gray-500 mt-0.5">${s.paid}/${s.total} paid · ${formatCurrency(s.totalCollected)}</div>
              </div>
              ${isActive ? `<i class="fas fa-check text-emerald-400 text-xs flex-shrink-0"></i>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    `);
  },

  switchEvent(id) {
    Data.setActiveEvent(id);
    Modal.close();
    Render.all();
    toast('Event switched', 'info');
  },

  setActiveEvent(id) {
    Data.setActiveEvent(id);
    Render.all();
  },

  // ---- Filter ----
  setFilter(filter) {
    AppState.currentFilter = filter;
    $('.filter-pill').removeClass('active');
    $(`#filter-${filter}`).addClass('active');
    const event = Data.getActiveEvent();
    if (event) Render.memberList(Data.getMembers(event.id), event);
  },

  // ---- Event CRUD ----
  openAddEvent() {
    Modal.open(`
      <h3 class="text-lg font-black mb-4">
        <i class="fas fa-calendar-plus text-emerald-400 mr-2"></i>New Event
      </h3>
      <div class="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <label class="form-label">Event Name *</label>
          <input type="text" id="ev-name" class="form-input" placeholder="e.g. Nabidinam 2026, Iftar 2026…">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Amount/Person (₹)</label>
            <input type="number" id="ev-amount" class="form-input" placeholder="250" value="250" min="0">
          </div>
          <div>
            <label class="form-label">Target Amount (₹)</label>
            <input type="number" id="ev-target" class="form-input" placeholder="Optional" min="0">
          </div>
        </div>
        <div class="pt-1">
          <div class="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-2">💳 Payment Details</div>
          <div class="space-y-2.5">
            <div>
              <label class="form-label">Phone / GPay Number</label>
              <input type="tel" id="ev-upi-number" class="form-input" placeholder="7994363996">
            </div>
            <div>
              <label class="form-label">UPI ID</label>
              <input type="text" id="ev-upi-id" class="form-input" placeholder="name@ybl, name@paytm…">
            </div>
            <div>
              <label class="form-label">Account Name</label>
              <input type="text" id="ev-upi-name" class="form-input" placeholder="Your name">
            </div>
            <div>
              <label class="form-label">QR Code Image</label>
              <div class="flex items-center gap-3">
                <label class="flex-1 cursor-pointer flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 border border-dashed border-white/15 hover:bg-white/8 hover:border-white/25 transition-all">
                  <i class="fas fa-qrcode text-blue-400"></i>
                  <span class="text-sm text-gray-400" id="ev-qr-label">Upload QR Code</span>
                  <input type="file" id="ev-qr-file" accept="image/*" class="hidden" onchange="App._previewQR('ev-qr-preview', 'ev-qr-label', this)">
                </label>
                <img id="ev-qr-preview" src="" class="hidden w-16 h-16 rounded-xl border border-white/10 object-cover bg-white">
              </div>
            </div>
          </div>
        </div>
        <button onclick="App.createEvent()" class="btn-primary w-full py-3 text-sm mt-1">
          <i class="fas fa-plus mr-2"></i>Create Event
        </button>
      </div>
    `);
    setTimeout(() => $('#ev-name').focus(), 150);
  },

  createEvent() {
    const name = $('#ev-name').val().trim();
    if (!name) { toast('Event name is required', 'error'); $('#ev-name').addClass('error'); return; }
    const qr = App._pendingQR || null;
    App._pendingQR = null;
    const event = Data.createEvent({
      name,
      defaultAmount: $('#ev-amount').val(),
      targetAmount: $('#ev-target').val(),
      upiNumber: $('#ev-upi-number').val(),
      upiId: $('#ev-upi-id').val(),
      upiName: $('#ev-upi-name').val(),
      qrCode: qr,
    });
    AppState.currentEventId = event.id;
    Modal.close();
    toast('Event created! ✨', 'success');
    Render.all();
  },

  openEditEvent(id) {
    const ev = Data.getEvent(id);
    if (!ev) return;
    App._pendingQR = ev.qrCode || null; // carry existing QR
    Modal.open(`
      <h3 class="text-lg font-black mb-4">
        <i class="fas fa-pen text-emerald-400 mr-2"></i>Edit Event
      </h3>
      <div class="space-y-3 max-h-[75vh] overflow-y-auto pr-1">
        <div>
          <label class="form-label">Event Name *</label>
          <input type="text" id="ev-name" class="form-input" value="${escHtml(ev.name)}">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Amount/Person (₹)</label>
            <input type="number" id="ev-amount" class="form-input" value="${ev.defaultAmount || 250}" min="0">
          </div>
          <div>
            <label class="form-label">Target Amount (₹)</label>
            <input type="number" id="ev-target" class="form-input" value="${ev.targetAmount || ''}" min="0">
          </div>
        </div>
        <div class="pt-1">
          <div class="text-[10px] font-bold text-blue-400 uppercase tracking-widest mb-2">💳 Payment Details</div>
          <div class="space-y-2.5">
            <div>
              <label class="form-label">Phone / GPay Number</label>
              <input type="tel" id="ev-upi-number" class="form-input" value="${escHtml(ev.upiNumber || ev.gpayNumber || '')}">
            </div>
            <div>
              <label class="form-label">UPI ID</label>
              <input type="text" id="ev-upi-id" class="form-input" value="${escHtml(ev.upiId || '')}" placeholder="name@ybl, name@paytm…">
            </div>
            <div>
              <label class="form-label">Account Name</label>
              <input type="text" id="ev-upi-name" class="form-input" value="${escHtml(ev.upiName || ev.gpayName || '')}">
            </div>
            <div>
              <label class="form-label">QR Code Image</label>
              <div class="flex items-center gap-3">
                <label class="flex-1 cursor-pointer flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 border border-dashed border-white/15 hover:bg-white/8 hover:border-white/25 transition-all">
                  <i class="fas fa-qrcode text-blue-400"></i>
                  <span class="text-sm text-gray-400" id="ev-qr-label">${ev.qrCode ? 'Change QR Code' : 'Upload QR Code'}</span>
                  <input type="file" id="ev-qr-file" accept="image/*" class="hidden" onchange="App._previewQR('ev-qr-preview', 'ev-qr-label', this)">
                </label>
                <img id="ev-qr-preview" src="${ev.qrCode || ''}" class="${ev.qrCode ? '' : 'hidden'} w-16 h-16 rounded-xl border border-white/10 object-cover bg-white">
              </div>
              ${ev.qrCode ? `<button onclick="App._clearQR()" class="text-[11px] text-red-400 hover:text-red-300 mt-1"><i class="fas fa-trash mr-1"></i>Remove QR</button>` : ''}
            </div>
          </div>
        </div>
        <button onclick="App.updateEvent('${id}')" class="btn-primary w-full py-3 text-sm mt-1">
          <i class="fas fa-save mr-2"></i>Save Changes
        </button>
      </div>
    `);
    setTimeout(() => $('#ev-name').focus(), 150);
  },

  updateEvent(id) {
    const name = $('#ev-name').val().trim();
    if (!name) { toast('Name required', 'error'); return; }
    const qr = App._pendingQR !== undefined ? App._pendingQR : Data.getEvent(id)?.qrCode || null;
    App._pendingQR = undefined;
    Data.updateEvent(id, {
      name,
      defaultAmount: parseInt($('#ev-amount').val()) || 250,
      targetAmount: parseInt($('#ev-target').val()) || 0,
      upiNumber: $('#ev-upi-number').val().trim(),
      upiId: $('#ev-upi-id').val().trim(),
      upiName: $('#ev-upi-name').val().trim(),
      qrCode: qr,
    });
    Modal.close();
    toast('Event updated!', 'success');
    Render.all();
  },

  // QR code helpers
  _pendingQR: undefined,
  _previewQR(previewId, labelId, input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Compress to max 400x400 JPEG for ultra-fast cloud sync (~25KB)
        const canvas = document.createElement('canvas');
        const maxDim = 400;
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
        App._pendingQR = compressedBase64;
        $(`#${previewId}`).attr('src', compressedBase64).removeClass('hidden');
        $(`#${labelId}`).text('QR Code selected ✅');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },
  _clearQR() {
    App._pendingQR = null;
    $('#ev-qr-preview').addClass('hidden').attr('src', '');
    $('#ev-qr-label').text('Upload QR Code');
    toast('QR code removed', 'info');
  },

  deleteEvent(id) {
    const ev = Data.getEvent(id);
    if (!ev) return;
    const memberCount = Data.getMembers(id).length;
    Modal.open(`
      <div class="text-center">
        <div class="w-14 h-14 rounded-full bg-red-500/12 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-trash text-red-400 text-xl"></i>
        </div>
        <h3 class="text-lg font-black mb-2">Delete Event?</h3>
        <p class="text-gray-400 text-sm mb-1">
          "<strong>${escHtml(ev.name)}</strong>"
        </p>
        ${memberCount > 0 ? `<p class="text-red-400 text-xs mb-4">⚠️ This will also delete ${memberCount} member(s)!</p>` : '<p class="text-gray-600 text-xs mb-4">This cannot be undone.</p>'}
        <div class="flex gap-3 mt-2">
          <button onclick="Modal.close()" class="flex-1 btn-secondary py-2.5 text-sm">Cancel</button>
          <button onclick="App._confirmDeleteEvent('${id}')"
            class="flex-1 bg-red-500/80 hover:bg-red-500 text-white rounded-xl py-2.5 text-sm font-bold transition-colors">
            Delete
          </button>
        </div>
      </div>
    `);
  },

  _confirmDeleteEvent(id) {
    Data.deleteEvent(id);
    Modal.close();
    toast('Event deleted', 'info');
    Render.all();
  },

  // ---- Member CRUD ----
  openAddMember() {
    const event = Data.getActiveEvent();
    if (!event) return;

    Modal.open(`
      <h3 class="text-lg font-black mb-4">
        <i class="fas fa-user-plus text-emerald-400 mr-2"></i>Add Member
      </h3>
      <div class="space-y-3">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2">
            <label class="form-label">Name *</label>
            <input type="text" id="m-name" class="form-input" placeholder="Member name">
          </div>
          <div>
            <label class="form-label">Serial</label>
            <input type="number" id="m-serial" class="form-input" placeholder="Auto" min="1">
          </div>
        </div>
        <div>
          <label class="form-label">Payment Status</label>
          <select id="m-paid" class="form-select" onchange="App._toggleMethodField()">
            <option value="0">⏳ Pending</option>
            <option value="1">✅ Paid</option>
          </select>
        </div>
        <div id="m-paid-fields" class="space-y-3" style="display:none">
          <div>
            <label class="form-label">Amount (₹)</label>
            <input type="number" id="m-amount" class="form-input" value="${event.defaultAmount || 250}" min="0">
          </div>
          <div>
            <label class="form-label">Payment Method</label>
            <div class="grid grid-cols-2 gap-3">
              <button type="button" id="method-online" onclick="App._selectMethod('online')"
                class="method-btn py-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all text-center">
                <i class="fas fa-wifi text-blue-400 text-xl block mb-1"></i>
                <span class="text-sm font-bold text-blue-300">Online</span>
              </button>
              <button type="button" id="method-cash" onclick="App._selectMethod('cash')"
                class="method-btn py-3.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20 transition-all text-center">
                <i class="fas fa-money-bill text-yellow-400 text-xl block mb-1"></i>
                <span class="text-sm font-bold text-yellow-300">Cash</span>
              </button>
            </div>
            <input type="hidden" id="m-method" value="">
          </div>
        </div>
        <button onclick="App.createMember()" class="btn-primary w-full py-3 text-sm mt-1">
          <i class="fas fa-plus mr-2"></i>Add Member
        </button>
      </div>
    `);
    setTimeout(() => $('#m-name').focus(), 150);
  },

  _toggleMethodField() {
    const paid = $('#m-paid').val() === '1';
    if (paid) $('#m-paid-fields').show();
    else $('#m-paid-fields').hide();
  },

  _selectMethod(method) {
    $('#m-method').val(method);
    $('.method-btn').removeClass('ring-2 ring-emerald-400');
    $(`#method-${method}`).addClass('ring-2 ring-emerald-400');
  },

  createMember() {
    const name = $('#m-name').val().trim();
    if (!name) { toast('Name is required', 'error'); $('#m-name').addClass('error'); return; }
    const event = Data.getActiveEvent();
    const paid = $('#m-paid').val() === '1';
    const method = paid ? ($('#m-method').val() || null) : null;
    if (paid && !method) { toast('Please select Online or Cash', 'warning'); return; }
    const serialVal = $('#m-serial').val().trim();

    Data.createMember({
      eventId: event.id,
      name,
      amount: paid ? (parseInt($('#m-amount').val()) || event.defaultAmount || 0) : 0,
      paid,
      method,
      serial: serialVal ? parseInt(serialVal) : undefined,
    });
    Modal.close();
    toast(`${name} added! ✅`, 'success');
    Render.adminView();
  },

  openEditMember(id) {
    const m = Data.getMember(id);
    const event = Data.getActiveEvent();
    if (!m) return;

    Modal.open(`
      <h3 class="text-lg font-black mb-4">
        <i class="fas fa-pen text-emerald-400 mr-2"></i>Edit Member
      </h3>
      <div class="space-y-3">
        <div class="grid grid-cols-3 gap-3">
          <div class="col-span-2">
            <label class="form-label">Name *</label>
            <input type="text" id="m-name" class="form-input" value="${escHtml(m.name)}">
          </div>
          <div>
            <label class="form-label">Serial</label>
            <input type="number" id="m-serial" class="form-input" value="${m.serial}" min="1">
          </div>
        </div>
        <div>
          <label class="form-label">Payment Status</label>
          <select id="m-paid" class="form-select" onchange="App._toggleMethodField()">
            <option value="0" ${!m.paid ? 'selected' : ''}>⏳ Pending</option>
            <option value="1" ${m.paid ? 'selected' : ''}>✅ Paid</option>
          </select>
        </div>
        <div id="m-paid-fields" class="space-y-3" ${!m.paid ? 'style="display:none"' : ''}>
          <div>
            <label class="form-label">Amount (₹)</label>
            <input type="number" id="m-amount" class="form-input" value="${m.amount || event?.defaultAmount || 250}" min="0">
          </div>
          <div>
            <label class="form-label">Payment Method</label>
            <div class="grid grid-cols-2 gap-3">
              <button type="button" id="method-online" onclick="App._selectMethod('online')"
                class="method-btn py-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all text-center
                  ${(m.method === 'online' || m.method === 'gpay') ? 'ring-2 ring-emerald-400' : ''}">
                <i class="fas fa-wifi text-blue-400 text-xl block mb-1"></i>
                <span class="text-sm font-bold text-blue-300">Online</span>
              </button>
              <button type="button" id="method-cash" onclick="App._selectMethod('cash')"
                class="method-btn py-3.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20 transition-all text-center
                  ${m.method === 'cash' ? 'ring-2 ring-emerald-400' : ''}">
                <i class="fas fa-money-bill text-yellow-400 text-xl block mb-1"></i>
                <span class="text-sm font-bold text-yellow-300">Cash</span>
              </button>
            </div>
            <input type="hidden" id="m-method" value="${(m.method === 'gpay' ? 'online' : m.method) || ''}">
          </div>
        </div>
        <button onclick="App.updateMember('${id}')" class="btn-primary w-full py-3 text-sm mt-1">
          <i class="fas fa-save mr-2"></i>Save Changes
        </button>
      </div>
    `);
    setTimeout(() => $('#m-name').focus(), 150);
  },

  updateMember(id) {
    const name = $('#m-name').val().trim();
    if (!name) { toast('Name required', 'error'); return; }
    const paid = $('#m-paid').val() === '1';
    const method = paid ? ($('#m-method').val() || null) : null;
    if (paid && !method) { toast('Please select Online or Cash', 'warning'); return; }

    Data.updateMember(id, {
      name,
      serial: parseInt($('#m-serial').val()) || 1,
      amount: paid ? (parseInt($('#m-amount').val()) || 0) : 0,
      paid,
      method,
    });
    Modal.close();
    toast('Member updated!', 'success');
    Render.adminView();
  },

  togglePaid(id, paid) {
    const m = Data.getMember(id);
    if (!m) return;

    if (paid) {
      const event = Data.getActiveEvent();
      const defaultAmt = m.amount || event?.defaultAmount || 250;

      Modal.open(`
        <h3 class="text-lg font-black mb-1">
          <i class="fas fa-check-circle text-emerald-400 mr-2"></i>Mark as Paid
        </h3>
        <p class="text-gray-500 text-sm mb-4">Confirm payment from <strong class="text-white">${escHtml(m.name)}</strong></p>
        <div class="space-y-3">
          <div>
            <label class="form-label">Amount Received (₹)</label>
            <input type="number" id="tp-amount" class="form-input" value="${defaultAmt}" min="0">
          </div>
          <div>
            <label class="form-label">Payment Method</label>
            <div class="grid grid-cols-2 gap-3">
              <button onclick="App._confirmPaid('${id}', 'online')"
                class="py-5 rounded-xl bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all text-center">
                <i class="fas fa-wifi text-blue-400 text-2xl block mb-1.5"></i>
                <span class="text-sm font-bold text-blue-300">Online</span>
              </button>
              <button onclick="App._confirmPaid('${id}', 'cash')"
                class="py-5 rounded-xl bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20 transition-all text-center">
                <i class="fas fa-money-bill text-yellow-400 text-2xl block mb-1.5"></i>
                <span class="text-sm font-bold text-yellow-300">Cash</span>
              </button>
            </div>
          </div>
        </div>
      `);
    } else {
      Data.updateMember(id, { paid: false, method: null, amount: 0 });
      toast(`${m.name} → pending`, 'info');
      Render.adminView();
    }
  },

  _confirmPaid(id, method) {
    const amount = parseInt($('#tp-amount').val()) || 0;
    Data.updateMember(id, { paid: true, method, amount });
    Modal.close();
    const m = Data.getMember(id);
    toast(`${m?.name} paid ${formatCurrency(amount)} ✅`, 'success');
    Render.adminView();
  },

  deleteMember(id) {
    const m = Data.getMember(id);
    if (!m) return;
    Modal.open(`
      <div class="text-center">
        <div class="w-14 h-14 rounded-full bg-red-500/12 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-user-times text-red-400 text-xl"></i>
        </div>
        <h3 class="text-lg font-black mb-2">Remove Member?</h3>
        <p class="text-gray-400 text-sm mb-4">Remove <strong class="text-white">${escHtml(m.name)}</strong>?</p>
        <div class="flex gap-3">
          <button onclick="Modal.close()" class="flex-1 btn-secondary py-2.5 text-sm">Cancel</button>
          <button onclick="App._confirmDeleteMember('${id}')"
            class="flex-1 bg-red-500/80 hover:bg-red-500 text-white rounded-xl py-2.5 text-sm font-bold transition-colors">
            Remove
          </button>
        </div>
      </div>
    `);
  },

  _confirmDeleteMember(id) {
    const m = Data.getMember(id);
    Data.deleteMember(id);
    Modal.close();
    toast(`${m?.name || 'Member'} removed`, 'info');
    Render.adminView();
  },

  // ---- Bulk Add ----
  openBulkAdd() {
    const event = Data.getActiveEvent();
    if (!event) return;
    Modal.open(`
      <h3 class="text-lg font-black mb-1">
        <i class="fas fa-list text-emerald-400 mr-2"></i>Bulk Add Members
      </h3>
      <p class="text-gray-500 text-xs mb-4">One name per line. Members will be added as Pending.</p>
      <div class="space-y-3">
        <div>
          <label class="form-label">Names (one per line)</label>
          <textarea id="bulk-names" class="form-textarea" rows="8"
            placeholder="Ashiq&#10;Sulaim&#10;Ali&#10;Ameer&#10;..."></textarea>
        </div>
        <div>
          <label class="form-label">Default Amount (₹)</label>
          <input type="number" id="bulk-amount" class="form-input" value="${event.defaultAmount || 250}" min="0">
        </div>
        <button onclick="App.createBulkMembers()" class="btn-primary w-full py-3 text-sm">
          <i class="fas fa-users mr-2"></i>Add All Members
        </button>
      </div>
    `);
    setTimeout(() => $('#bulk-names').focus(), 150);
  },

  createBulkMembers() {
    const event = Data.getActiveEvent();
    if (!event) return;
    const rawText = $('#bulk-names').val();
    const amount = parseInt($('#bulk-amount').val()) || event.defaultAmount || 250;
    const names = rawText.split('\n').map(n => n.trim()).filter(n => n.length > 0);
    if (names.length === 0) { toast('No names found', 'error'); return; }

    const existingMembers = Data.getMembers(event.id);
    let maxSerial = existingMembers.length > 0 ? Math.max(...existingMembers.map(m => m.serial || 0)) : 0;

    names.forEach(name => {
      maxSerial++;
      Data.createMember({ eventId: event.id, name, amount, paid: false, method: null, serial: maxSerial });
    });

    Modal.close();
    toast(`${names.length} members added! ✅`, 'success');
    Render.adminView();
  },

  // ---- Settings ----
  openChangePassword() {
    Modal.open(`
      <h3 class="text-lg font-black mb-4">
        <i class="fas fa-key text-yellow-400 mr-2"></i>Change Password
      </h3>
      <div class="space-y-3">
        <div>
          <label class="form-label">Current Password</label>
          <input type="password" id="pw-old" class="form-input" placeholder="Current password">
        </div>
        <div>
          <label class="form-label">New Password</label>
          <input type="password" id="pw-new" class="form-input" placeholder="New password (min 4 chars)">
        </div>
        <div>
          <label class="form-label">Confirm New Password</label>
          <input type="password" id="pw-confirm" class="form-input" placeholder="Repeat new password">
        </div>
        <button onclick="App.changePassword()" class="btn-primary w-full py-3 text-sm mt-1">
          <i class="fas fa-save mr-2"></i>Update Password
        </button>
      </div>
    `);
    setTimeout(() => $('#pw-old').focus(), 150);
  },

  changePassword() {
    const old = $('#pw-old').val();
    const nw = $('#pw-new').val();
    const conf = $('#pw-confirm').val();
    if (old !== AppState.data.adminPassword) { toast('Wrong current password', 'error'); return; }
    if (!nw || nw.length < 4) { toast('New password must be ≥ 4 characters', 'error'); return; }
    if (nw !== conf) { toast('Passwords do not match', 'error'); return; }
    AppState.data.adminPassword = nw;
    saveData();
    Modal.close();
    toast('Password updated! 🔐', 'success');
  },

  exportData() {
    const json = JSON.stringify(AppState.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fundtrack-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Backup exported! 💾', 'success');
  },

  importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed.events || !parsed.members) throw new Error('Invalid format');
        AppState.data = { ...defaultData(), ...parsed };
        saveData();
        toast('Data imported! ✅', 'success');
        Render.all();
      } catch (err) {
        toast('Invalid file format', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  },

  openClearData() {
    Modal.open(`
      <div class="text-center">
        <div class="w-14 h-14 rounded-full bg-red-500/12 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-triangle-exclamation text-red-400 text-2xl"></i>
        </div>
        <h3 class="text-lg font-black mb-2">Clear All Data?</h3>
        <p class="text-gray-400 text-sm mb-1">This will permanently delete <strong>all events and members</strong>.</p>
        <p class="text-red-400 text-xs mb-5">⚠️ This action CANNOT be undone!</p>
        <div class="flex gap-3">
          <button onclick="Modal.close()" class="flex-1 btn-secondary py-2.5 text-sm">Cancel</button>
          <button onclick="App._confirmClearData()"
            class="flex-1 bg-red-500/80 hover:bg-red-500 text-white rounded-xl py-2.5 text-sm font-bold transition-colors">
            Clear Everything
          </button>
        </div>
      </div>
    `);
  },

  _confirmClearData() {
    AppState.data = defaultData();
    saveData();
    Modal.close();
    toast('All data cleared', 'warning');
    Render.all();
  },

  // ---- Share ----
  shareWhatsApp() {
    const event = Data.getActiveEvent();
    if (!event) { toast('No active event', 'error'); return; }

    const members = Data.getMembers(event.id);
    const stats = Data.getStats(event.id);

    let text = `*${event.name}*\n\n`;
    const upiNum = event.upiNumber || event.gpayNumber;
    if (upiNum) {
      text += `${event.defaultAmount || 250}rs Online - ${upiNum}`;
      if (event.upiId) text += ` | UPI: ${event.upiId}`;
      const name = event.upiName || event.gpayName;
      if (name) text += ` (${name})`;
      text += '\n\n';
    }

    members.forEach(m => {
      if (m.paid) {
        const isOnline = m.method === 'online' || m.method === 'gpay';
        const method = isOnline ? '(online)' : m.method === 'cash' ? '(Cash)' : '';
        text += `${m.serial}. ${m.name} ${m.amount}✅${method}\n`;
      } else {
        text += `${m.serial}. ${m.name}\n`;
      }
    });

    text += `\n💰 *Total: ${formatCurrency(stats.totalCollected)}*`;
    text += ` | ✅ ${stats.paid}/${stats.total} paid`;
    if (stats.pending > 0) text += ` | ⏳ ${stats.pending} pending`;

    this._copyText(text, 'WhatsApp text copied! 📋');
  },

  shareLink() {
    const event = Data.getActiveEvent();
    if (!event) { toast('No active event', 'error'); return; }

    const shareData = {
      version: AppState.data.version,
      adminPassword: 'readonly',
      activeEventId: event.id,
      events: [event],
      members: Data.getMembers(event.id),
    };

    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
      const url = `${window.location.origin}${window.location.pathname}#share=${encoded}`;
      this._copyText(url, 'Share link copied! 🔗 Send to group members');
    } catch(e) {
      toast('Error generating link', 'error');
    }
  },

  _copyText(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast(successMsg, 'success'))
        .catch(() => this._fallbackCopy(text, successMsg));
    } else {
      this._fallbackCopy(text, successMsg);
    }
  },

  _fallbackCopy(text, successMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toast(successMsg, 'success');
    } catch (e) {
      toast('Could not copy — please copy manually', 'error');
    }
    document.body.removeChild(ta);
  }
};

// ============================================================
// SEED DATA (pre-loads Nabidinam 2026 on first launch)
// ============================================================

function seedData() {
  if (AppState.data.events.length > 0) return; // already has data

  const event = Data.createEvent({
    name: 'Nabidinam 2026',
    defaultAmount: 250,
    targetAmount: 7750,
    upiNumber: '7994363996',
    upiName: 'Ashiq muhammed EP',
    upiId: '',
    qrCode: null,
  });

  const MEMBERS = [
    { serial: 1,  name: 'Ashiq',          amount: 250, paid: true,  method: 'online' },
    { serial: 2,  name: 'Sulaim',          amount: 250, paid: true,  method: 'cash'   },
    { serial: 3,  name: 'Ali',             amount: 250, paid: true,  method: 'online' },
    { serial: 4,  name: 'Ameer',           amount: 500, paid: true,  method: 'cash'   },
    { serial: 5,  name: 'Raza',            amount: 250, paid: true,  method: 'online' },
    { serial: 6,  name: 'Shameem',         amount: 250, paid: true,  method: 'online' },
    { serial: 7,  name: 'Yasir',           amount: 250, paid: false, method: null     },
    { serial: 8,  name: 'Gafoor',          amount: 250, paid: true,  method: 'online' },
    { serial: 9,  name: 'Aslu',            amount: 250, paid: true,  method: 'online' },
    { serial: 10, name: 'Rasheed',         amount: 250, paid: true,  method: 'online' },
    { serial: 11, name: 'Sulthan',         amount: 250, paid: false, method: null     },
    { serial: 12, name: 'Safu',            amount: 250, paid: true,  method: 'online' },
    { serial: 13, name: 'Munaver',         amount: 250, paid: true,  method: 'online' },
    { serial: 14, name: 'Shamsu',          amount: 250, paid: true,  method: 'online' },
    { serial: 15, name: 'Nihal Madhu',     amount: 200, paid: true,  method: 'online' },
    { serial: 16, name: 'Mohammed',        amount: 250, paid: true,  method: 'online' },
    { serial: 17, name: 'Shidil',          amount: 250, paid: true,  method: 'cash'   },
    { serial: 18, name: 'Shafnad',         amount: 250, paid: true,  method: 'online' },
    { serial: 19, name: 'Noufal',          amount: 250, paid: true,  method: 'online' },
    { serial: 20, name: 'Maharoof',        amount: 250, paid: true,  method: 'online' },
    { serial: 21, name: 'Swalih',          amount: 300, paid: true,  method: 'online' },
    { serial: 22, name: 'Mufeed Zoophee',  amount: 500, paid: true,  method: 'online' },
    { serial: 23, name: 'Nazim',           amount: 250, paid: true,  method: 'online' },
    { serial: 24, name: 'Hassan',          amount: 300, paid: true,  method: 'online' },
    { serial: 25, name: 'Musthafaa',       amount: 250, paid: true,  method: 'online' },
    { serial: 26, name: 'Faheem',          amount: 300, paid: true,  method: 'online' },
    { serial: 27, name: 'Fayis',           amount: 250, paid: true,  method: 'cash'   },
    { serial: 28, name: 'Salman Min',      amount: 500, paid: true,  method: 'online' },
    { serial: 29, name: 'Jasir KP',        amount: 250, paid: true,  method: 'cash'   },
    { serial: 30, name: 'Jaseel Daas',     amount: 250, paid: true,  method: 'cash'   },
  ];

  MEMBERS.forEach(m => Data.createMember({ ...m, eventId: event.id }));
}

// ============================================================
// BOOTSTRAP
// ============================================================

$(document).ready(() => {
  App.init();
});
