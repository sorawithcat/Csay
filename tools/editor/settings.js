// Csay 编辑器：用户设置。保存在浏览器本地，不写项目文件。
var SETTINGS_KEY = 'csay.editor.settings';
var SETTINGS = { autoFormat: true, autoClose: true, hover: true, fontSize: 14, tabSize: 4, formatBrace: 'same' };
var SETTINGS_TRAILS = {
  general: [{ label: '设置', page: 'general' }, { label: '常规' }],
  editing: [{ label: '设置', page: 'general' }, { label: '编辑' }],
  completion: [{ label: '设置', page: 'general' }, { label: '编辑', page: 'editing' }, { label: '自动补全' }],
  appearance: [{ label: '设置', page: 'general' }, { label: '外观' }]
};
var currentSettingsPage = 'general';

function loadSettings() {
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.autoFormat === 'boolean') SETTINGS.autoFormat = saved.autoFormat;
    if (typeof saved.autoClose === 'boolean') SETTINGS.autoClose = saved.autoClose;
    if (typeof saved.hover === 'boolean') SETTINGS.hover = saved.hover;
    if ([13, 14, 15, 16].indexOf(Number(saved.fontSize)) >= 0) SETTINGS.fontSize = Number(saved.fontSize);
    if ([2, 4].indexOf(Number(saved.tabSize)) >= 0) SETTINGS.tabSize = Number(saved.tabSize);
    if (saved.formatBrace === 'same' || saved.formatBrace === 'next') SETTINGS.formatBrace = saved.formatBrace;
  } catch (e) {}
}

function applySettings() {
  cm.setOption('tabSize', SETTINGS.tabSize);
  cm.setOption('indentUnit', SETTINGS.tabSize);
  var box = cm.getWrapperElement();
  box.style.fontSize = SETTINGS.fontSize + 'px';
  box.style.lineHeight = (SETTINGS.fontSize + 6) + 'px';
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
  applySettings();
}

function renderSettingsBreadcrumb(page) {
  var trail = SETTINGS_TRAILS[page] || SETTINGS_TRAILS.general;
  var nav = document.getElementById('settingsBreadcrumb');
  nav.textContent = '';
  for (var i = 0; i < trail.length; i++) {
    if (i > 0) {
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      nav.appendChild(sep);
    }
    var item = trail[i];
    if (item.page) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.setAttribute('data-settings-page', item.page);
      nav.appendChild(button);
    } else {
      var current = document.createElement('span');
      current.className = 'current';
      current.textContent = item.label;
      nav.appendChild(current);
    }
  }
}

function showSettingsPage(page) {
  if (!SETTINGS_TRAILS[page]) page = 'general';
  currentSettingsPage = page;
  var pages = document.querySelectorAll('[data-settings-panel]');
  for (var i = 0; i < pages.length; i++) {
    pages[i].classList.toggle('active', pages[i].getAttribute('data-settings-panel') === page);
  }
  var items = document.querySelectorAll('.settings-nav-item');
  for (var n = 0; n < items.length; n++) {
    items[n].classList.toggle('active', items[n].getAttribute('data-settings-page') === page);
  }
  renderSettingsBreadcrumb(page);
  var body = document.querySelector('.settings-body');
  if (body) body.scrollTop = 0;
}

function openSettings() {
  document.getElementById('setAutoFormat').checked = SETTINGS.autoFormat;
  document.getElementById('setAutoClose').checked = SETTINGS.autoClose;
  document.getElementById('setHover').checked = SETTINGS.hover;
  document.getElementById('setFontSize').value = String(SETTINGS.fontSize);
  document.getElementById('setTabSize').value = String(SETTINGS.tabSize);
  document.getElementById('setFormatBrace').value = SETTINGS.formatBrace;
  document.getElementById('settingsHint').textContent = '设置保存在本机浏览器';
  showSettingsPage(currentSettingsPage);
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsDialog() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveSettingsDialog() {
  SETTINGS.autoFormat = document.getElementById('setAutoFormat').checked;
  SETTINGS.autoClose = document.getElementById('setAutoClose').checked;
  SETTINGS.hover = document.getElementById('setHover').checked;
  SETTINGS.fontSize = Number(document.getElementById('setFontSize').value);
  SETTINGS.tabSize = Number(document.getElementById('setTabSize').value);
  SETTINGS.formatBrace = document.getElementById('setFormatBrace').value === 'next' ? 'next' : 'same';
  saveSettings();
  closeSettingsDialog();
  setStatus('设置已保存', 'ok');
}

function bindSettingsUi() {
  var nav = document.querySelector('.settings-nav');
  nav.addEventListener('click', function (event) {
    var item = event.target.closest('[data-settings-page]');
    if (item) showSettingsPage(item.getAttribute('data-settings-page'));
  });
  var breadcrumb = document.getElementById('settingsBreadcrumb');
  breadcrumb.addEventListener('click', function (event) {
    var item = event.target.closest('[data-settings-page]');
    if (item) showSettingsPage(item.getAttribute('data-settings-page'));
  });
  var links = document.querySelectorAll('[data-settings-goto]');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function () {
      showSettingsPage(this.getAttribute('data-settings-goto'));
    });
    links[i].addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showSettingsPage(this.getAttribute('data-settings-goto'));
      }
    });
  }
  document.getElementById('settingsClose').addEventListener('click', closeSettingsDialog);
  document.getElementById('settingsX').addEventListener('click', closeSettingsDialog);
  document.getElementById('settingsSave').addEventListener('click', saveSettingsDialog);
  document.addEventListener('keydown', function (event) {
    var modal = document.getElementById('settingsModal');
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeSettingsDialog();
  });
}

loadSettings();
applySettings();
bindSettingsUi();
