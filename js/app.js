(function () {
  'use strict';

  var SETTINGS_KEY = 'customizable-exam-timer:settings';
  var SESSION_KEY = 'customizable-exam-timer:session';
  // A reminder whose time passed less than this long ago still fires, so a
  // briefly throttled tab or a late entry into exam mode doesn't skip it.
  var FIRE_GRACE_MS = 65 * 1000;
  var IDLE_MS = 3000;
  var MINUTE = 60 * 1000;

  var SOUND_KEYS = { chime: 'soundChime', bell: 'soundBell', none: 'soundNone', custom: 'soundCustom' };
  // The reminder list is fixed: these five rows, in this order. The two
  // leaving rules live at the top level of the settings because the status
  // line and progress bar use them too; the rest live in settings.reminders.
  var RULES = ['leaveStart', 'leaveEnd'];
  var REMINDER_ORDER = ['start', 'leaveStart', 'leaveEnd', 'beforeEnd', 'end'];
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1"/></svg>',
    dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
  };

  var settings;
  var session;
  var media = { logo: null, audio: {} }; // object URLs
  var fired = new Set();
  var display;   // the full-screen exam screen
  var preview;   // the miniature copy beside the settings
  var previewState = 'running';
  var expanded = new Set(); // reminder rows showing their message and sound
  var idleTimer = null;
  var wakeLock = null;
  var audioTarget = null;

  function $(sel) { return document.querySelector(sel); }
  function pad(n) { return String(n).padStart(2, '0'); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Settings ----

  function defaults() {
    return {
      lang: /^zh/i.test(navigator.language || '') ? 'zh' : 'en',
      schoolName: '',
      examTitle: '',
      notice: '',
      mode: 'clock',
      date: todayStr(),
      startTime: '09:00',
      endTime: '11:00',
      duration: 120,
      leaveStart: { id: 'leaveStart', when: 'afterStart', on: true, min: 30, remind: true, text: '', sound: 'none' },
      leaveEnd: { id: 'leaveEnd', when: 'beforeEnd', on: true, min: 15, remind: true, text: '', sound: 'none' },
      reminders: {
        start: { id: 'start', when: 'start', on: true, min: 0, text: '', sound: 'none' },
        beforeEnd: { id: 'beforeEnd', when: 'beforeEnd', on: true, min: 30, text: '', sound: 'none' },
        end: { id: 'end', when: 'end', on: true, min: 0, text: '', sound: 'none' }
      },
      theme: 'dark',
      showClock: true,
      showProgress: true,
      bannerSeconds: 10
    };
  }

  function merge(saved) {
    var base = defaults();
    if (!saved || typeof saved !== 'object') return base;
    // Copy saved values over a reminder without letting them change which
    // reminder it is.
    function mergeReminder(target, from) {
      if (from && typeof from === 'object') Object.assign(target, from, { id: target.id, when: target.when });
    }
    Object.keys(base).forEach(function (k) {
      if (!(k in saved)) return;
      if (RULES.indexOf(k) >= 0) mergeReminder(base[k], saved[k]);
      else if (k === 'reminders') {
        // Older versions kept an editable array here; only the fixed set is kept now.
        var from = saved.reminders && !Array.isArray(saved.reminders) ? saved.reminders : {};
        Object.keys(base.reminders).forEach(function (id) { mergeReminder(base.reminders[id], from[id]); });
      } else base[k] = saved[k];
    });
    // Older or imported settings may predate the length limit on the textarea.
    base.notice = String(base.notice || '').slice(0, $('#notice').maxLength);
    return base;
  }

  function loadSettings() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) {}
    settings = merge(saved);
    // A date left over from an earlier exam would make the screen say the exam is over.
    if (settings.date < todayStr()) settings.date = todayStr();
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      $('#storage-warning').hidden = false;
    }
  }

  // Save and refresh the preview after any change in the form.
  function commit() {
    saveSettings();
    updatePreview();
  }

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) {}
    if (!session || typeof session !== 'object') session = { active: false, startedAt: null };
    // Remembered so a reload doesn't replay a reminder that just went off.
    fired = new Set(Array.isArray(session.fired) ? session.fired : []);
  }

  function saveSession() {
    session.fired = Array.from(fired);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
  }

  async function loadMedia() {
    if (media.logo) URL.revokeObjectURL(media.logo);
    Object.keys(media.audio).forEach(function (id) { URL.revokeObjectURL(media.audio[id]); });
    media = { logo: null, audio: {} };

    var logo = await MediaStore.get('logo');
    if (logo && logo.blob) media.logo = URL.createObjectURL(logo.blob);
    var list = editableReminders();
    for (var i = 0; i < list.length; i++) {
      var id = list[i].id;
      var a = await MediaStore.get('audio:' + id);
      if (a && a.blob) media.audio[id] = URL.createObjectURL(a.blob);
    }
  }

  // ---- i18n ----

  function t(key, vars) {
    var dict = I18N[settings.lang] || I18N.zh;
    var s = key in dict ? dict[key] : (I18N.zh[key] || key);
    if (vars) s = s.replace(/\{(\w+)\}/g, function (_, k) { return k in vars ? vars[k] : ''; });
    return s;
  }

  function applyI18n() {
    document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('docTitle');
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-label]').forEach(function (el) {
      el.title = t(el.dataset.i18nLabel);
      el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    });
  }

  function autoText(r) {
    if (r.id === 'leaveStart') return t('autoAfterStartLeave', { n: r.min });
    if (r.id === 'leaveEnd') return t('autoBeforeEndLeave', { n: r.min });
    switch (r.id) {
      case 'start': return t('autoStart');
      case 'end': return t('autoEnd');
      case 'beforeEnd': return t('autoBeforeEnd', { n: r.min });
    }
    return '';
  }

  function isRule(r) {
    return RULES.indexOf(r.id) >= 0;
  }

  // Every row in the reminder list, in display order.
  function editableReminders() {
    return REMINDER_ORDER.map(function (id) {
      return RULES.indexOf(id) >= 0 ? settings[id] : settings.reminders[id];
    });
  }

  // Only the reminders that actually go off during the exam.
  function activeReminders() {
    return editableReminders().filter(remindsAtTime);
  }

  function reminderText(r) {
    return (r.text || '').trim() || autoText(r);
  }

  // ---- Setup form ----

  var TEXT_FIELDS = ['schoolName', 'examTitle', 'notice', 'date', 'startTime', 'endTime'];

  function fillForm() {
    $('#lang').value = settings.lang;
    TEXT_FIELDS.forEach(function (k) { $('#' + k).value = settings[k]; });
    $('#duration').value = settings.duration;
    document.querySelectorAll('input[name="mode"]').forEach(function (el) { el.checked = el.value === settings.mode; });
    $('#theme').value = settings.theme;
    $('#bannerSeconds').value = settings.bannerSeconds;
    $('#showClock').checked = settings.showClock;
    $('#showProgress').checked = settings.showProgress;
    renderNoticeCount();
    renderLogo();
    renderMode();
    renderReminders();
    validate();
  }

  function renderAll() {
    document.documentElement.dataset.theme = settings.theme;
    applyI18n();
    fillForm();
    updatePreview();
  }

  function renderMode() {
    $('#mode-clock').hidden = settings.mode !== 'clock';
    $('#mode-duration').hidden = settings.mode !== 'duration';
  }

  function renderNoticeCount() {
    var el = $('#notice');
    $('#notice-count').textContent = el.value.length + ' / ' + el.maxLength;
  }

  function renderLogo() {
    var img = $('#logo-preview');
    img.hidden = !media.logo;
    if (media.logo) img.src = media.logo;
    $('#logo-empty').hidden = !!media.logo;
    $('#logo-remove').hidden = !media.logo;
  }

  function positiveInt(value) {
    var n = parseInt(value, 10);
    return n >= 1 ? n : null;
  }

  function validate() {
    var msg = '';
    if (settings.mode === 'clock') {
      var p = clockPlan();
      if (!(p.end > p.start)) msg = t('invalidTime');
    } else if (!positiveInt(settings.duration)) {
      msg = t('invalidDuration');
    }
    var el = $('#time-error');
    el.textContent = msg;
    el.hidden = !msg;
    return !msg;
  }

  function bindForm() {
    $('#lang').addEventListener('change', function (e) {
      settings.lang = e.target.value;
      saveSettings();
      renderAll();
    });

    TEXT_FIELDS.forEach(function (k) {
      $('#' + k).addEventListener('input', function (e) {
        settings[k] = e.target.value;
        commit();
        validate();
      });
    });
    $('#notice').addEventListener('input', renderNoticeCount);

    $('#duration').addEventListener('input', function (e) {
      settings.duration = positiveInt(e.target.value) || e.target.value;
      commit();
      validate();
    });

    document.querySelectorAll('input[name="mode"]').forEach(function (el) {
      el.addEventListener('change', function () {
        settings.mode = el.value;
        commit();
        renderMode();
        validate();
      });
    });

    document.querySelectorAll('input[name="previewState"]').forEach(function (el) {
      el.addEventListener('change', function () {
        previewState = el.value;
        updatePreview();
      });
    });

    $('#theme').addEventListener('change', function (e) {
      settings.theme = e.target.value;
      document.documentElement.dataset.theme = settings.theme;
      commit();
    });
    $('#bannerSeconds').addEventListener('input', function (e) {
      var n = positiveInt(e.target.value);
      if (n) { settings.bannerSeconds = n; commit(); }
    });
    ['showClock', 'showProgress'].forEach(function (k) {
      $('#' + k).addEventListener('change', function (e) {
        settings[k] = e.target.checked;
        commit();
      });
    });

    $('#logo-choose').addEventListener('click', function () {
      $('#logo-file').value = '';
      $('#logo-file').click();
    });
    $('#logo-file').addEventListener('change', async function (e) {
      var file = e.target.files[0];
      if (!file) return;
      await MediaStore.set('logo', { blob: file, name: file.name, type: file.type });
      if (media.logo) URL.revokeObjectURL(media.logo);
      media.logo = URL.createObjectURL(file);
      renderLogo();
      updatePreview();
    });
    $('#logo-remove').addEventListener('click', async function () {
      await MediaStore.remove('logo');
      if (media.logo) URL.revokeObjectURL(media.logo);
      media.logo = null;
      renderLogo();
      updatePreview();
    });

    bindReminders();

    $('#reset').addEventListener('click', async function () {
      if (!confirm(t('confirmReset'))) return;
      await MediaStore.clear();
      var lang = settings.lang;
      settings = defaults();
      settings.lang = lang;
      saveSettings();
      await loadMedia();
      renderAll();
    });
    $('#export').addEventListener('click', exportConfig);
    $('#import').addEventListener('click', function () {
      $('#import-file').value = '';
      $('#import-file').click();
    });
    $('#import-file').addEventListener('change', function (e) {
      if (e.target.files[0]) importConfig(e.target.files[0]);
    });
    $('#enter').addEventListener('click', function () {
      if (!validate()) return;
      Sound.unlock();
      session = { active: true, startedAt: null };
      fired = new Set();
      saveSession();
      showDisplay();
    });
  }

  // ---- Reminder list ----

  function findReminder(id) {
    return editableReminders().find(function (r) { return r.id === id; });
  }

  function iconButton(cls, label, icon, extra) {
    return '<button type="button" class="icon ' + cls + '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '"' + (extra || '') + '>' + icon + '</button>';
  }

  function minutesInput(unit) {
    return '<span class="with-unit"><input type="number" class="r-min" min="1" step="1" aria-label="' + escapeHtml(t('minutes')) + '"><span>' + escapeHtml(unit || t('minutes')) + '</span></span>';
  }

  // The part of a row that is always visible: what it is and when it happens.
  function summaryText(r) {
    switch (r.id) {
      case 'start': return escapeHtml(t('whenStart'));
      case 'end': return escapeHtml(t('whenEnd'));
      case 'beforeEnd': return escapeHtml(t('whenBeforeEnd')) + ' ' + minutesInput();
      case 'leaveStart': return escapeHtml(t('ruleStartPre')) + ' ' + minutesInput(t('ruleStartPost'));
      case 'leaveEnd': return escapeHtml(t('ruleEndPre')) + ' ' + minutesInput(t('ruleEndPost'));
    }
    return '';
  }

  // Whether the row's message and sound are in use.
  function remindsAtTime(r) {
    return r.on && (!isRule(r) || r.remind);
  }

  function soundLabel(r) {
    if (!r.on) return '';
    if (!remindsAtTime(r)) return t('noReminder');
    if (r.sound === 'custom') return (media.audio[r.id] && r.audioName) || t('soundCustom');
    return t(SOUND_KEYS[r.sound] || 'soundNone');
  }

  function renderReminders() {
    var box = $('#reminders');
    box.textContent = '';
    editableReminders().forEach(function (r) {
      var rule = isRule(r);
      var open = expanded.has(r.id);
      var row = document.createElement('div');
      row.className = 'rem' + (open ? ' open' : '') + (r.on ? '' : ' off');
      row.dataset.id = r.id;
      row.innerHTML =
        '<div class="rem-line">' +
          '<input type="checkbox" class="r-on" aria-label="' + escapeHtml(t(rule ? 'ruleToggle' : 'reminderToggle')) + '">' +
          '<span class="rem-what">' + summaryText(r) + '</span>' +
          '<span class="rem-sound-label"></span>' +
          iconButton('r-toggle', t('details'), ICONS.dots, ' aria-expanded="' + open + '"') +
        '</div>' +
        '<div class="rem-detail"' + (open ? '' : ' hidden') + '>' +
          '<input class="r-text" aria-label="' + escapeHtml(t('colText')) + '">' +
          '<div class="rem-detail-row">' +
            '<select class="r-sound" aria-label="' + escapeHtml(t('colSound')) + '">' +
              Object.keys(SOUND_KEYS).map(function (s) {
                return '<option value="' + s + '">' + escapeHtml(t(SOUND_KEYS[s])) + '</option>';
              }).join('') +
            '</select>' +
            iconButton('r-play', t('preview'), ICONS.play) +
            '<span class="r-custom"><button type="button" class="r-choose">' + escapeHtml(t('chooseAudio')) + '</button><span class="r-name"></span></span>' +
            (rule
              ? '<span class="spacer"></span><label class="check"><input type="checkbox" class="r-remind"><span>' + escapeHtml(t('remindAtTime')) + '</span></label>'
              : '') +
          '</div>' +
        '</div>';

      row.querySelector('.r-on').checked = r.on;
      // A rule that's on but silent still needs its minutes, but not its
      // message or sound.
      var min = row.querySelector('.r-min');
      if (min) {
        min.value = r.min;
        min.disabled = !r.on;
      }
      if (rule) {
        row.querySelector('.r-remind').checked = r.remind;
        row.querySelector('.r-remind').disabled = !r.on;
      }
      ['.r-text', '.r-sound', '.r-play', '.r-choose'].forEach(function (sel) {
        row.querySelector(sel).disabled = !remindsAtTime(r);
      });
      row.querySelector('.rem-sound-label').textContent = soundLabel(r);
      row.querySelector('.r-text').value = r.text;
      row.querySelector('.r-text').placeholder = autoText(r);
      row.querySelector('.r-sound').value = r.sound;
      row.querySelector('.r-custom').hidden = r.sound !== 'custom';
      row.querySelector('.r-name').textContent = (media.audio[r.id] && r.audioName) || t('noFile');
      box.appendChild(row);
    });
  }

  function refreshReminderPlaceholders() {
    document.querySelectorAll('.rem').forEach(function (row) {
      var r = findReminder(row.dataset.id);
      if (r) row.querySelector('.r-text').placeholder = autoText(r);
    });
  }

  function pickAudio(id) {
    audioTarget = id;
    $('#audio-file').value = '';
    $('#audio-file').click();
  }

  function bindReminders() {
    var box = $('#reminders');

    box.addEventListener('input', function (e) {
      var row = e.target.closest('.rem');
      var r = row && findReminder(row.dataset.id);
      if (!r) return;
      if (e.target.classList.contains('r-text')) {
        r.text = e.target.value;
        commit();
      } else if (e.target.classList.contains('r-min')) {
        var n = positiveInt(e.target.value);
        if (!n) return;
        r.min = n;
        commit();
        refreshReminderPlaceholders();
      }
    });

    box.addEventListener('change', function (e) {
      var row = e.target.closest('.rem');
      var r = row && findReminder(row.dataset.id);
      if (!r) return;
      if (e.target.classList.contains('r-on')) {
        r.on = e.target.checked;
        commit();
        renderReminders();
      } else if (e.target.classList.contains('r-remind')) {
        r.remind = e.target.checked;
        commit();
        renderReminders();
      } else if (e.target.classList.contains('r-sound')) {
        r.sound = e.target.value;
        commit();
        renderReminders();
        if (r.sound === 'custom' && !media.audio[r.id]) pickAudio(r.id);
      }
    });

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      var row = btn && btn.closest('.rem');
      var r = row && findReminder(row.dataset.id);
      if (!r) return;
      if (btn.classList.contains('r-toggle')) {
        if (expanded.has(r.id)) expanded.delete(r.id);
        else expanded.add(r.id);
        renderReminders();
      } else if (btn.classList.contains('r-play')) {
        Sound.unlock();
        Sound.play(r.sound, media.audio[r.id]);
        showBanner(preview, r);
      } else if (btn.classList.contains('r-choose')) {
        pickAudio(r.id);
      }
    });

    $('#audio-file').addEventListener('change', async function (e) {
      var file = e.target.files[0];
      var r = audioTarget && findReminder(audioTarget);
      if (!file || !r) return;
      await MediaStore.set('audio:' + r.id, { blob: file, name: file.name, type: file.type });
      if (media.audio[r.id]) URL.revokeObjectURL(media.audio[r.id]);
      media.audio[r.id] = URL.createObjectURL(file);
      r.audioName = file.name;
      commit();
      renderReminders();
    });
  }

  // ---- Import / export ----

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(url) {
    var parts = url.split(',');
    var type = (parts[0].match(/data:([^;]*)/) || [])[1] || '';
    var bin = atob(parts[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type });
  }

  async function exportConfig() {
    var keys = ['logo'].concat(editableReminders().map(function (r) { return 'audio:' + r.id; }));
    var files = {};
    for (var i = 0; i < keys.length; i++) {
      var v = await MediaStore.get(keys[i]);
      if (v && v.blob) files[keys[i]] = { name: v.name, data: await blobToDataUrl(v.blob) };
    }
    var data = { app: 'customizable-exam-timer', version: 1, settings: settings, media: files };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'exam-timer-settings-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  async function importConfig(file) {
    try {
      var data = JSON.parse(await file.text());
      if (!data || data.app !== 'customizable-exam-timer' || !data.settings) throw new Error('bad file');
      await MediaStore.clear();
      var files = data.media || {};
      for (var key in files) {
        var blob = dataUrlToBlob(files[key].data);
        await MediaStore.set(key, { blob: blob, name: files[key].name, type: blob.type });
      }
      settings = merge(data.settings);
      saveSettings();
      await loadMedia();
      renderAll();
      toast(t('imported'));
    } catch (err) {
      toast(t('importFailed'));
    }
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 3000);
  }

  // ---- Timeline ----

  function localTime(date, time) {
    var d = (date || '').split('-').map(Number);
    var tm = (time || '').split(':').map(Number);
    return new Date(d[0], d[1] - 1, d[2], tm[0], tm[1]).getTime();
  }

  function clockPlan() {
    return { start: localTime(settings.date, settings.startTime), end: localTime(settings.date, settings.endTime) };
  }

  // start/end are null while a duration-mode exam is waiting to be started.
  function plan() {
    if (settings.mode === 'clock') return clockPlan();
    var total = settings.duration * MINUTE;
    if (session.startedAt) return { start: session.startedAt, end: session.startedAt + total };
    return { start: null, end: null, total: total };
  }

  function fireTime(r, p) {
    var at;
    switch (r.when) {
      case 'start': at = p.start; break;
      case 'end': at = p.end; break;
      case 'afterStart': at = p.start + r.min * MINUTE; break;
      case 'beforeEnd': at = p.end - r.min * MINUTE; break;
    }
    return at >= p.start && at <= p.end ? at : null;
  }

  // 9:05, not 09:05
  function formatClock(ms) {
    var d = new Date(ms);
    return d.getHours() + ':' + pad(d.getMinutes());
  }

  function formatRemaining(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return (h > 0 ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60);
  }

  // ---- Exam screen, shared by the full-screen display and the preview ----

  var SCREEN_HTML =
    '<div class="s-banner" role="alert" hidden>' + ICONS.bell + '<p class="s-banner-text"></p><button type="button" class="s-banner-close"></button></div>' +
    '<header class="s-head"><img class="s-logo" alt="" hidden><p class="s-school"></p></header>' +
    '<section class="s-center">' +
      '<p class="s-title"></p><p class="s-label"></p><p class="s-time"></p><p class="s-meta"></p>' +
      '<button type="button" class="primary s-start" hidden></button>' +
    '</section>' +
    '<section class="s-bottom">' +
      '<div class="s-progress"><div class="s-zone s-zone-a"></div><div class="s-zone s-zone-end"></div><div class="s-fill"></div></div>' +
      '<div class="s-ticks"></div>' +
      '<p class="s-status-wrap"><span class="s-status"></span></p>' +
      '<p class="s-notice"></p>' +
    '</section>';

  var SCREEN_PARTS = ['banner', 'banner-text', 'banner-close', 'logo', 'school', 'title', 'label', 'time',
    'meta', 'start', 'progress', 'zone-a', 'zone-end', 'fill', 'ticks', 'status', 'notice'];

  function makeScreen(root) {
    var content = root.querySelector('.screen-content');
    content.innerHTML = SCREEN_HTML;
    var s = { root: root, bannerTimer: null, lastTicks: '' };
    SCREEN_PARTS.forEach(function (name) {
      s[name.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = content.querySelector('.s-' + name);
    });
    return s;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // Things that only change when the settings do.
  function renderStatic(s) {
    s.logo.hidden = !media.logo;
    if (media.logo && s.logo.getAttribute('src') !== media.logo) s.logo.src = media.logo;
    [['school', 'schoolName'], ['title', 'examTitle'], ['notice', 'notice']].forEach(function (pair) {
      var el = s[pair[0]];
      setText(el, settings[pair[1]].trim());
      el.hidden = !el.textContent;
    });
    setText(s.start, t('startExam'));
    setText(s.bannerClose, t('dismiss'));
  }

  function phaseOf(p, now) {
    if (p.start === null) return 'ready';
    if (now < p.start) return 'pre';
    if (now < p.end) return 'running';
    return 'over';
  }

  function renderScreen(s, p, now) {
    var phase = phaseOf(p, now);
    var remaining = { ready: p.total, pre: p.start - now, running: p.end - now, over: 0 }[phase];

    setText(s.label, t({ ready: 'ready', pre: 'untilStart', running: 'untilEnd', over: 'examOver' }[phase]));

    var timeText = formatRemaining(remaining);
    if (s.time.textContent !== timeText) {
      // Each digit gets a fixed-width cell, so narrow digits like 1 and 7
      // don't make the whole number shift sideways as it counts down.
      s.time.innerHTML = timeText.replace(/\d/g, '<span class="digit">$&</span>');
    }
    s.time.classList.toggle('long', timeText.length > 7);
    s.time.classList.toggle('over', phase === 'over');

    setText(s.meta, settings.showClock ? t('metaNow', { t: formatClock(now) }) : '');
    s.meta.hidden = !settings.showClock;

    s.start.hidden = phase !== 'ready';
    renderStatus(s, phase, p, now, remaining);
    renderProgress(s, phase, p, now);
    return phase;
  }

  function renderStatus(s, phase, p, now, remaining) {
    var text = '';
    var cls = '';
    var ls = settings.leaveStart;
    var le = settings.leaveEnd;
    if (phase === 'pre') {
      text = t('statusWait');
    } else if (phase === 'over') {
      text = t('statusOver'); cls = 'danger';
    } else if (phase === 'running') {
      if (ls.on && now - p.start < ls.min * MINUTE) { text = t('statusNoLeaveStart', { n: ls.min }); cls = 'warn'; }
      else if (le.on && remaining <= le.min * MINUTE) { text = t('statusNoLeaveEnd', { n: le.min }); cls = 'warn'; }
      else if (ls.on || le.on) { text = t('statusCanLeave'); cls = 'ok'; }
    }
    s.status.parentElement.hidden = !text;
    setText(s.status, text);
    s.status.className = 's-status' + (cls ? ' ' + cls : '');
  }

  function renderProgress(s, phase, p, now) {
    var total = p.end - p.start;
    var show = settings.showProgress && phase !== 'ready' && total > 0;
    s.progress.hidden = !show;
    s.ticks.hidden = !show;
    if (!show) return;

    var frac = function (ms) { return Math.min(1, Math.max(0, ms / total)); };
    var ls = settings.leaveStart;
    var le = settings.leaveEnd;
    var a = ls.on ? frac(ls.min * MINUTE) : 0;
    var b = le.on ? frac(le.min * MINUTE) : 0;
    s.zoneA.style.width = (a * 100) + '%';
    s.zoneEnd.style.width = (b * 100) + '%';
    s.fill.style.width = (frac(now - p.start) * 100) + '%';

    var ticks = [{ pos: 0, text: formatClock(p.start), cls: 'first' }];
    if (a > 0 && a < 1) ticks.push({ pos: a, text: formatClock(p.start + ls.min * MINUTE) + ' ' + t('progressCanLeave') });
    if (b > 0 && b < 1) ticks.push({ pos: 1 - b, text: formatClock(p.end - le.min * MINUTE) + ' ' + t('progressStopLeave') });
    ticks.push({ pos: 1, text: formatClock(p.end), cls: 'last' });
    var html = ticks.map(function (k) {
      return '<span class="' + (k.cls || '') + '" style="left:' + (k.pos * 100) + '%">' + escapeHtml(k.text) + '</span>';
    }).join('');
    if (html !== s.lastTicks) {
      s.ticks.innerHTML = html;
      s.lastTicks = html;
    }
  }

  function showBanner(s, r) {
    s.banner.className = 's-banner' + (r.when === 'start' ? ' start' : r.when === 'end' ? ' end' : '');
    s.bannerText.textContent = reminderText(r);
    s.banner.hidden = false;
    clearTimeout(s.bannerTimer);
    s.bannerTimer = setTimeout(function () { s.banner.hidden = true; }, settings.bannerSeconds * 1000);
  }

  function hideBanner(s) {
    clearTimeout(s.bannerTimer);
    s.banner.hidden = true;
  }

  // ---- Preview ----

  // Duration mode has no real start time, so the preview pretends it starts at 09:00.
  function previewPlan() {
    if (settings.mode === 'clock') return clockPlan();
    var start = localTime(todayStr(), '09:00');
    return { start: start, end: start + (positiveInt(settings.duration) || 0) * MINUTE };
  }

  function updatePreview() {
    if (!preview) return;
    renderStatic(preview);
    var p = previewPlan();
    var now;
    if (previewState === 'pre') {
      if (settings.mode === 'duration') {
        renderScreen(preview, { start: null, end: null, total: p.end - p.start }, p.start);
        return;
      }
      now = p.start - 5 * MINUTE;
    } else if (previewState === 'over') {
      now = p.end + 1000;
    } else {
      // Show a moment between the two no-leaving periods when there is one.
      var total = p.end - p.start;
      var a = settings.leaveStart.on ? settings.leaveStart.min * MINUTE : 0;
      var b = settings.leaveEnd.on ? settings.leaveEnd.min * MINUTE : 0;
      var free = total - a - b;
      now = p.start + Math.round((free > 0 ? a + free / 2 : total / 2) / MINUTE) * MINUTE;
    }
    renderScreen(preview, p, now);
  }

  // ---- Exam mode ----

  function showDisplay() {
    document.documentElement.dataset.theme = settings.theme;
    $('#setup').hidden = true;
    display.root.hidden = false;
    display.lastTicks = '';
    renderStatic(display);
    $('#sound-hint').hidden = !Sound.needsGesture();
    tick();
    markActive();
    requestWakeLock();
  }

  function hideDisplay() {
    hideBanner(display);
    Sound.stop();
    display.root.hidden = true;
    $('#setup').hidden = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  function exitExam() {
    var p = plan();
    if (settings.mode === 'duration' && p.start && Date.now() < p.end && !confirm(t('confirmExit'))) return;
    session = { active: false, startedAt: null };
    fired = new Set();
    saveSession();
    hideDisplay();
  }

  function startDuration() {
    if (settings.mode !== 'duration' || session.startedAt) return;
    Sound.unlock();
    session.startedAt = Date.now();
    fired = new Set();
    saveSession();
    tick();
  }

  function tick() {
    if (display.root.hidden) return;
    var now = Date.now();
    var p = plan();
    var phase = renderScreen(display, p, now);
    if (phase === 'running' || phase === 'over') checkReminders(p, now);
  }

  function checkReminders(p, now) {
    // When two reminders fall at the same moment, only the first in list
    // order is shown; the second would just replace its banner.
    var shown = new Set();
    activeReminders().forEach(function (r) {
      var at = fireTime(r, p);
      if (at === null) return;
      var key = r.id + '@' + at;
      if (fired.has(key) || now < at) return;
      fired.add(key);
      saveSession();
      if (now - at <= FIRE_GRACE_MS && !shown.has(at)) {
        shown.add(at);
        showBanner(display, r);
        Sound.play(r.sound, media.audio[r.id]);
      }
    });
  }

  function markActive() {
    var el = display.root;
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { el.classList.add('idle'); }, IDLE_MS);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else document.documentElement.requestFullscreen().catch(function () {});
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || display.root.hidden || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }

  function bindDisplay() {
    var root = display.root;
    ['mousemove', 'pointerdown', 'keydown'].forEach(function (type) {
      root.addEventListener(type, markActive);
    });
    // Browsers block sound until the page has been clicked once, e.g. after a reload.
    document.addEventListener('pointerdown', function () {
      Sound.unlock();
      $('#sound-hint').hidden = true;
    });

    $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
    $('#btn-exit').addEventListener('click', exitExam);
    display.start.addEventListener('click', startDuration);
    display.bannerClose.addEventListener('click', function () {
      hideBanner(display);
      Sound.stop();
    });

    document.addEventListener('keydown', function (e) {
      if (root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      Sound.unlock();
      $('#sound-hint').hidden = true;
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      else if ((e.key === ' ' || e.key === 'Enter') && !display.start.hidden) { e.preventDefault(); startDuration(); }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { requestWakeLock(); tick(); }
    });
  }

  // ---- Start ----

  async function init() {
    loadSettings();
    loadSession();
    try { localStorage.setItem(SETTINGS_KEY + ':test', '1'); localStorage.removeItem(SETTINGS_KEY + ':test'); }
    catch (e) { $('#storage-warning').hidden = false; }
    display = makeScreen($('#display'));
    preview = makeScreen($('#preview'));
    await loadMedia();
    renderAll();
    bindForm();
    bindDisplay();
    setInterval(tick, 200);
    // Pick up where we left off if the page was reloaded during an exam.
    if (session.active) showDisplay();
  }

  init();
})();
