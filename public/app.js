/* 电子图说 · 语音布置清单 —— 前端（无构建，原生 ES Module） */

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const params = new URLSearchParams(location.search);
const MODE = {
  readonly: params.has('readonly') || params.has('ro'),
  print: params.has('print'),
};

/** 单条录音上限：3 分钟 */
const MAX_RECORD_SECONDS = 180;
/** 一条最多 12 张图片 */
const MAX_IMAGES_PER_ITEM = 12;
/** 一次粘贴最多 12 张 */
const MAX_IMAGES_PER_REQUEST = 12;
const SAVE_DEBOUNCE_MS = 500;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

const S = {
  data: null,
  sectionId: null,
  itemId: null,
  rec: null,
  busy: new Map(),
  exporting: false,
  exportingItem: null,
  saveError: false,
  importing: false,
  /** 视频语音来源：auto / recording / tts（由 health 接口的默认值初始化） */
  audioSource: 'auto',
  /** 是否支持 TTS 配音（有 macOS say 命令） */
  ttsReady: false,
  /** 视频渲染配置（由 health 接口初始化，用于卡片上的时长校验提示） */
  videoCfg: { secondsPerImage: 2, transSeconds: 0.5 },
};

const dom = {
  titleInput: document.getElementById('docTitle'),
  titleH: document.getElementById('docTitleH'),
  saveIndicator: document.getElementById('saveIndicator'),
  btnExport: document.getElementById('btnExport'),
  btnPdf: document.getElementById('btnPdf'),
  btnPreview: document.getElementById('btnPreview'),
  btnOpenWorkdir: document.getElementById('btnOpenWorkdir'),
  btnReset: document.getElementById('btnReset'),
  btnImport: document.getElementById('btnImport'),
  importInput: document.getElementById('importInput'),
  dropOverlay: document.getElementById('dropOverlay'),
  btnUndo: document.getElementById('btnUndo'),
  btnRedo: document.getElementById('btnRedo'),
  topbarActions: document.getElementById('topbarActions'),
  tabs: document.getElementById('tabs'),
  list: document.getElementById('list'),
  outline: document.getElementById('outline'),
  hintbar: document.getElementById('hintbar'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxCount: document.getElementById('lbCount'),
  lightboxStage: document.getElementById('lbStage'),
  lightboxPrev: document.getElementById('lbPrev'),
  lightboxNext: document.getElementById('lbNext'),
  lightboxClose: document.getElementById('lbClose'),
  toasts: document.getElementById('toasts'),
  dialogLayer: document.getElementById('dialogLayer'),
  dialogTitle: document.getElementById('dialogTitle'),
  dialogText: document.getElementById('dialogText'),
  dialogOk: document.getElementById('dialogOk'),
  dialogCancel: document.getElementById('dialogCancel'),
  btnLogs: document.getElementById('btnLogs'),
  logPanel: document.getElementById('logPanel'),
  logStatus: document.getElementById('logStatus'),
  logBody: document.getElementById('logBody'),
  logScroll: document.getElementById('logScroll'),
  logClear: document.getElementById('logClear'),
  logClose: document.getElementById('logClose'),
  recLive: document.getElementById('recLive'),
  recWave: document.getElementById('recWave'),
  recLiveTime: document.getElementById('recLiveTime'),
};

let saveTimer = null;
let saveTail = Promise.resolve();
let pendingSaves = 0;
let outlineDragging = null;
let sttHintShown = false;

/* 运行日志面板状态 */
let logSource = null;
let logAutoScroll = true;

/* ---------------- 基础工具 ---------------- */

const canEdit = () => !MODE.readonly && !MODE.print;
const nowIso = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
const mediaUrl = (file) => (file ? `/${file}` : '');

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 面向提示文案的短时长：几秒 / 几分几秒 */
function fmtSecondsBrief(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

function isEditable(node) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable;
}

function extFromMime(mime = '') {
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  return (
    { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }[clean] ||
    'webm'
  );
}

function currentSection() {
  return S.data?.sections.find((s) => s.id === S.sectionId) ?? null;
}

function currentItem() {
  const section = currentSection();
  return section?.items.find((i) => i.id === S.itemId) ?? null;
}

function sectionOfItem(itemId) {
  return S.data?.sections.find((s) => s.items.some((i) => i.id === itemId)) ?? null;
}

/** 编辑模式下保证「始终有一个当前条目」 */
function selectFirstItem() {
  if (!canEdit()) return;
  const section = currentSection();
  if (!section || section.items.length === 0) return;
  if (section.items.some((i) => i.id === S.itemId)) return;
  selectItem(section.items[0].id);
}

function findItem(itemId) {
  return sectionOfItem(itemId)?.items.find((i) => i.id === itemId) ?? null;
}

function cardEl(itemId) {
  if (!itemId) return null;
  return dom.list.querySelector(`.card[data-item-id="${CSS.escape(itemId)}"]`);
}

function outlineRowEl(itemId) {
  if (!itemId) return null;
  return dom.outline.querySelector(`.outline-item[data-item-id="${CSS.escape(itemId)}"]`);
}

/** 页面上所有的播放器元素（目前只有录音） */
function allMedia() {
  return document.querySelectorAll('audio, video');
}

/**
 * 暂停除 keep 之外的所有正在播放的媒体。
 * 多条录音同时在播会很吵，所以全局只允许一个在响。
 */
function pauseOtherMedia(keep = null) {
  let paused = 0;
  for (const media of allMedia()) {
    if (media === keep || media.paused) continue;
    media.pause();
    paused += 1;
  }
  return paused;
}

// play/pause 这类媒体事件不冒泡，但捕获阶段能拿到，所以挂在 document 上统一处理。
document.addEventListener(
  'play',
  (event) => {
    const target = event.target;
    if (!(target instanceof HTMLMediaElement)) return;
    pauseOtherMedia(target);
  },
  true,
);

/** 同屏最多保留几块 toast，超出的把最旧的挤掉，避免刷屏后一直堆着 */
const TOAST_MAX = 4;

/**
 * 移除一块 toast（带淡出动画）。
 * 重复调用是安全的：已经在离场或已移除的直接忽略。
 */
function dismissToast(node) {
  if (!node || !node.isConnected || node.dataset.leaving === '1') return;
  node.dataset.leaving = '1';
  if (typeof node.__toastStop === 'function') node.__toastStop();

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    node.remove();
  };

  node.classList.add('is-leaving');
  node.addEventListener('animationend', remove, { once: true });
  // 兜底：动画被 prefers-reduced-motion 之类关掉时也能收掉
  setTimeout(remove, 300);
}

/**
 * 给 toast 挂自动消失计时器，并画一条倒计时细线。
 * 鼠标移入（或焦点落在里面的按钮上）时暂停，移开后继续，方便点下载/关闭。
 */
function armToastTimer(node, timeout) {
  const bar = el('span', 'toast-timer');
  bar.style.animationDuration = `${timeout}ms`;
  node.append(bar);
  node.classList.add('is-timed');

  let remaining = timeout;
  let startedAt = Date.now();
  let timer = setTimeout(() => dismissToast(node), remaining);

  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(remaining - (Date.now() - startedAt), 700);
    bar.style.animationPlayState = 'paused';
  };
  const resume = () => {
    if (timer) return;
    startedAt = Date.now();
    timer = setTimeout(() => dismissToast(node), remaining);
    bar.style.animationPlayState = 'running';
  };

  node.addEventListener('mouseenter', pause);
  node.addEventListener('mouseleave', resume);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', resume);
  node.__toastStop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * 把一块已构造好的 toast 挂到右下角。
 * timeout > 0 时到点自动消失；closable 为 true 时带关闭按钮。
 */
function mountToast(node, { timeout = 4200, closable = true } = {}) {
  if (closable) {
    const close = el('button', 'toast-close');
    close.type = 'button';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭');
    close.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
      '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      dismissToast(node);
    });
    node.append(close);
  }

  dom.toasts.append(node);

  while (dom.toasts.children.length > TOAST_MAX) {
    dismissToast(dom.toasts.firstElementChild);
  }

  if (timeout > 0) armToastTimer(node, timeout);
  return node;
}

function toast(message, type = 'info', timeout = 4200) {
  const node = el('div', `toast${type === 'error' ? ' error' : ''}`, message);
  return mountToast(node, { timeout });
}

/* ---------------- 确认弹窗（纯键盘可用） ---------------- */

/** 弹窗打开时保存 resolve；关闭后置空，同时用它判断「是否有弹窗」 */
let dialogResolve = null;
let dialogReturnFocus = null;

function isDialogOpen() {
  return dialogResolve !== null;
}

/**
 * 关闭弹窗并回传结果。
 * 重复调用是安全的，返回值表示是否真的关掉了一个弹窗。
 */
function closeDialog(confirmed) {
  const resolve = dialogResolve;
  if (!resolve) return false;
  dialogResolve = null;

  dom.dialogLayer.hidden = true;
  document.body.classList.remove('dialog-open');

  // 焦点还给触发删除的按钮，避免焦点掉到 body 上
  const back = dialogReturnFocus;
  dialogReturnFocus = null;
  if (back?.isConnected) back.focus({ preventScroll: true });

  resolve(confirmed);
  return true;
}

/**
 * 键盘可操作的确认弹窗：Enter 确认、Esc 取消、Tab 在两个按钮间切换。
 * 返回 Promise<boolean>，确认是 true。同一时间只会存在一个弹窗。
 */
function askConfirm({ title, text = '', okText = '删除', cancelText = '取消', danger = true } = {}) {
  // 理论上不会同时开两个，兜底：旧的那个按取消收掉
  if (isDialogOpen()) closeDialog(false);

  dom.dialogTitle.textContent = title;
  dom.dialogText.textContent = text;
  dom.dialogText.hidden = !text;
  dom.dialogOk.textContent = okText;
  dom.dialogCancel.textContent = cancelText;
  dom.dialogOk.classList.toggle('is-danger', danger);

  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const result = new Promise((resolve) => {
    dialogResolve = resolve;
  });

  dom.dialogLayer.hidden = false;
  document.body.classList.add('dialog-open');
  // 默认聚焦「确认」，「⌫ 再 Enter」一气呵成；想反悔按 Esc
  dom.dialogOk.focus({ preventScroll: true });

  return result;
}

function bindDialog() {
  dom.dialogOk.addEventListener('click', () => closeDialog(true));
  dom.dialogCancel.addEventListener('click', () => closeDialog(false));

  // 点空白处等同取消
  dom.dialogLayer.addEventListener('mousedown', (event) => {
    if (event.target === dom.dialogLayer) closeDialog(false);
  });

  dom.dialogLayer.addEventListener('keydown', (event) => {
    if (!isDialogOpen()) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(true);
      return;
    }
    if (event.key === 'Tab') {
      // 只有两个按钮，Tab 在它们之间循环，焦点不会跑出弹窗
      event.preventDefault();
      const next = document.activeElement === dom.dialogOk ? dom.dialogCancel : dom.dialogOk;
      next.focus();
    }
  });
}

const LB = { files: [], index: 0 };

function lbVisible() {
  return !dom.lightbox.hidden;
}

/** 打开一组图片（同一条目的所有图片），可左右切换 */
function openLightbox(files, index = 0) {
  const list = (files || []).filter(Boolean);
  if (list.length === 0) return;
  LB.files = list;
  LB.index = Math.min(Math.max(0, index), list.length - 1);
  dom.lightbox.hidden = false;
  document.body.classList.add('lb-open');
  renderLightbox();
}

function renderLightbox() {
  const total = LB.files.length;
  const file = LB.files[LB.index];
  if (!file) return closeLightbox();

  dom.lightboxImg.src = mediaUrl(file);
  dom.lightboxImg.alt = `第 ${LB.index + 1} 张，共 ${total} 张`;
  dom.lightboxCount.textContent = total > 1 ? `${LB.index + 1} / ${total}` : '';
  dom.lightboxPrev.hidden = total <= 1;
  dom.lightboxNext.hidden = total <= 1;
  dom.lightboxPrev.disabled = LB.index === 0;
  dom.lightboxNext.disabled = LB.index === total - 1;
}

function stepLightbox(delta) {
  if (!lbVisible() || LB.files.length <= 1) return;
  const next = Math.min(Math.max(0, LB.index + delta), LB.files.length - 1);
  if (next === LB.index) return;
  LB.index = next;
  renderLightbox();
}

function closeLightbox() {
  dom.lightbox.hidden = true;
  dom.lightboxImg.removeAttribute('src');
  document.body.classList.remove('lb-open');
  LB.files = [];
  LB.index = 0;
}

/* ---------------- 保存 ---------------- */

function setIndicator(kind) {
  const node = dom.saveIndicator;
  node.classList.toggle('is-saving', kind === 'saving');
  node.classList.toggle('is-error', kind === 'error');
  if (kind === 'saving') node.textContent = '保存中…';
  else if (kind === 'error') node.textContent = '保存失败';
  else node.textContent = '已保存';
}

function markDirty({ immediate = false } = {}) {
  if (!canEdit()) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (immediate) enqueueSave();
  else {
    setIndicator('saving');
    saveTimer = setTimeout(() => {
      saveTimer = null;
      enqueueSave();
    }, SAVE_DEBOUNCE_MS);
  }
}

function enqueueSave() {
  const snapshot = JSON.parse(JSON.stringify(S.data));
  pendingSaves += 1;
  setIndicator('saving');
  saveTail = saveTail.then(async () => {
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      S.saveError = false;
    } catch (err) {
      S.saveError = true;
      toast(`保存失败：${err.message}`, 'error', 7000);
    } finally {
      pendingSaves -= 1;
      if (pendingSaves === 0 && !saveTimer) setIndicator(S.saveError ? 'error' : 'saved');
    }
  });
  return saveTail;
}

async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    enqueueSave();
  }
  await saveTail;
}

/* ---------------- 撤销 / 重做 ---------------- */

const MAX_HISTORY = 100;

const history = {
  undo: [],
  redo: [],
  /** 正在编辑的文本框：焦点进入时抓拍「改动前」快照，真正输入时才入栈 */
  pendingText: null,
};

function snapshot() {
  return JSON.parse(
    JSON.stringify({
      data: S.data,
      sectionId: S.sectionId,
      itemId: S.itemId,
    }),
  );
}

function applySnapshot(snap) {
  S.data = snap.data;
  S.sectionId = snap.sectionId;
  S.itemId = snap.itemId;
  markDirty({ immediate: true });
  render();
  // 顶栏标题输入框是常驻节点，撤销/重做后即使它还持有焦点也要同步回被恢复的标题
  dom.titleInput.value = S.data?.title || '清单';
  rearmFocusedTextEdit();
  refreshUndoRedo();
}

function pushUndo() {
  if (!canEdit()) return;
  history.undo.push(snapshot());
  if (history.undo.length > MAX_HISTORY) history.undo.shift();
  history.redo.length = 0;
  refreshUndoRedo();
}

function undo() {
  if (!canEdit() || history.undo.length === 0) return;
  if (S.rec) stopRecording(true);
  history.redo.push(snapshot());
  applySnapshot(history.undo.pop());
  toast('已撤销');
}

function redo() {
  if (!canEdit() || history.redo.length === 0) return;
  if (S.rec) stopRecording(true);
  history.undo.push(snapshot());
  applySnapshot(history.redo.pop());
  toast('已重做');
}

/** 文本框开始编辑：记录改动前快照，但等真正输入时才入栈，避免「点了没改」也占一步 */
function textEditStart(key) {
  if (!canEdit()) return;
  history.pendingText = { key, before: snapshot() };
}

function textEditChange(key) {
  const pending = history.pendingText;
  if (!pending || pending.key !== key || !pending.before) return;
  history.undo.push(pending.before);
  if (history.undo.length > MAX_HISTORY) history.undo.shift();
  history.redo.length = 0;
  pending.before = null;
  refreshUndoRedo();
}

/** 撤销/重做后，若焦点仍在某个文本框上，重新抓拍「改动前」快照，保证继续输入也能撤销 */
function textEditKeyFor(node) {
  if (!node) return null;
  if (node === dom.titleInput) return 'doctitle';
  if (node.classList?.contains('item-title')) return `itemtitle-${node.dataset.itemId}`;
  if (node.classList?.contains('item-text')) return `itemtext-${node.dataset.itemId}`;
  return null;
}

function rearmFocusedTextEdit() {
  const key = textEditKeyFor(document.activeElement);
  if (key) textEditStart(key);
}

function refreshUndoRedo() {
  if (dom.btnUndo) dom.btnUndo.disabled = history.undo.length === 0;
  if (dom.btnRedo) dom.btnRedo.disabled = history.redo.length === 0;
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderTitle();
  if (MODE.print) {
    dom.tabs.hidden = true;
  } else {
    renderTabs();
  }
  renderList();
}

function renderTitle() {
  const title = S.data?.title || '清单';
  document.title = title;
  const asStatic = MODE.readonly || MODE.print;
  dom.titleInput.hidden = asStatic;
  dom.titleH.hidden = !asStatic;
  dom.titleH.textContent = title;
  if (document.activeElement !== dom.titleInput) dom.titleInput.value = title;
}

/** 构造视频配音来源下拉（auto / 录音 / TTS），TTS 不可用时禁用该选项 */
function buildAudioSourceSelect() {
  const audioSelect = el('select', 'audio-source');
  audioSelect.title = '视频配音来源';
  const options = [
    ['auto', '配音：自动'],
    ['recording', '配音：录音'],
    ['tts', '配音：TTS'],
  ];
  for (const [value, label] of options) {
    const opt = el('option', null, label);
    opt.value = value;
    if (value === 'tts' && !S.ttsReady) opt.disabled = true;
    audioSelect.append(opt);
  }
  audioSelect.value = S.audioSource;
  audioSelect.addEventListener('change', () => {
    S.audioSource = audioSelect.value;
  });
  return audioSelect;
}

/** checkHealth 拿到 say 可用性后，刷新下拉里的 TTS 选项与当前值（不重建整个页签栏） */
function refreshAudioSourceSelect() {
  const select = dom.tabs.querySelector('.audio-source');
  if (!select) return;
  const ttsOpt = select.querySelector('option[value="tts"]');
  if (ttsOpt) ttsOpt.disabled = !S.ttsReady;
  // 若当前选中了不可用的 TTS 且本机不支持，回退到 auto
  if (!S.ttsReady && select.value === 'tts') {
    S.audioSource = 'auto';
  }
  select.value = S.audioSource;
}

function renderTabs() {
  dom.tabs.replaceChildren();
  S.data.sections.forEach((section, index) => {
    const tab = el('div', 'tab');
    tab.dataset.id = section.id;
    if (section.id === S.sectionId) tab.classList.add('active');

    const name = el('span', 'tab-name', section.name || `页签 ${index + 1}`);
    tab.append(name);

    tab.addEventListener('click', () => {
      if (S.sectionId === section.id) return;
      S.sectionId = section.id;
      S.itemId = null;
      render();
      selectFirstItem();
    });

    if (canEdit()) {
      const del = el('button', 'tab-del', '×');
      del.type = 'button';
      del.title = '删除页签';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSection(section.id);
      });
      tab.append(del);

      tab.addEventListener('dblclick', (e) => {
        e.preventDefault();
        startRename(section);
      });
    }

    dom.tabs.append(tab);
  });

  if (canEdit()) {
    const add = el('button', 'tab-add', '＋ 页签');
    add.type = 'button';
    add.addEventListener('click', addSection);
    dom.tabs.append(add);

    // 视频语音来源选择（auto / 录音 / TTS）
    dom.tabs.append(buildAudioSourceSelect());

    // TODO(视频开关)：字幕 / 进度条开关接到这里。
    // 值存 localStorage 并随请求体发送；后端 buildVideos 已预留 cfg.burnText / cfg.progressBar，
    // 两个参数都已在缓存签名里，接线后不需要改缓存逻辑。

    const tabExport = el('button', 'tab-export', '⏺ 导出视频');
    tabExport.type = 'button';
    tabExport.title = '把每个章节各导出一个视频';
    tabExport.addEventListener('click', exportSectionsVideo);
    dom.tabs.append(tabExport);
  }
}

function startRename(section) {
  const tab = dom.tabs.querySelector(`.tab[data-id="${CSS.escape(section.id)}"]`);
  const nameEl = tab?.querySelector('.tab-name');
  if (!tab || !nameEl) return;

  const input = el('input', 'tab-rename');
  input.value = section.name;
  input.maxLength = 40;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const renameKey = `rename-${section.id}`;
  textEditStart(renameKey);

  const commit = () => {
    const value = input.value.trim();
    if (value && value !== section.name) {
      section.name = value;
      markDirty({ immediate: true });
    }
    renderTabs();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('input', () => textEditChange(renameKey));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = section.name;
      input.blur();
    }
  });
}

function sectionTitleEl(section) {
  return el('h2', 'section-title', section.name);
}

function renderList() {
  const active = document.activeElement;
  const focusInfo =
    active && active.classList?.contains('item-text')
      ? { id: active.dataset.itemId, start: active.selectionStart, end: active.selectionEnd }
      : null;

  dom.list.replaceChildren();

  if (MODE.print) {
    const sections = S.data.sections.filter((s) => s.items.length > 0);
    if (sections.length === 0) {
      dom.list.append(el('div', 'empty', '（清单为空）'));
    } else {
      for (const section of sections) {
        dom.list.append(sectionTitleEl(section));
        section.items.forEach((item, index) => dom.list.append(createCard(section, item, index)));
      }
    }
    return;
  }

  const section = currentSection();
  if (!section) {
    dom.list.append(el('div', 'empty', '暂无页签'));
    return;
  }

  if (section.items.length === 0) {
    const empty = el('div', 'empty');
    empty.append(el('b', null, '这个页签还没有条目'));
    empty.append(el('span', null, canEdit() ? '点击下方按钮新建，然后按 ⌘V 粘贴截图' : ''));
    dom.list.append(empty);
  }

  section.items.forEach((item, index) => dom.list.append(createCard(section, item, index)));

  if (canEdit()) {
    const add = el('button', 'add-item', '＋ 添加条目');
    add.type = 'button';
    add.addEventListener('click', () => addItem());
    dom.list.append(add);
  }

  if (focusInfo) {
    const ta = dom.list.querySelector(`textarea[data-item-id="${CSS.escape(focusInfo.id)}"]`);
    if (ta) {
      ta.focus();
      try {
        ta.setSelectionRange(focusInfo.start, focusInfo.end);
      } catch {
        /* ignore */
      }
    }
  }

  renderOutline();
}

/**
 * 左侧「条目大纲」：像 PPT 缩略图一样列出当前页签的每个条目，
 * 点击跳转选中，拖拽即可排序。这比在卡片右上角拖动好用，因为卡片高度不一、可能整屏都很高。
 */
function renderOutline() {
  if (!dom.outline) return;

  if (MODE.print) {
    dom.outline.hidden = true;
    dom.outline.replaceChildren();
    return;
  }
  dom.outline.hidden = false;
  dom.outline.replaceChildren();

  const section = currentSection();
  if (!section || section.items.length === 0) {
    dom.outline.append(el('div', 'outline-empty', '暂无条目'));
    return;
  }

  section.items.forEach((item, index) => {
    const row = el('div', 'outline-item');
    row.dataset.itemId = item.id;
    row.draggable = canEdit();
    row.title = canEdit() ? '拖拽排序 · 点击跳转' : '点击跳转';
    if (item.id === S.itemId) row.classList.add('active');

    const grip = el('span', 'outline-grip');
    grip.setAttribute('aria-hidden', 'true');
    grip.innerHTML =
      '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">' +
      '<circle cx="2" cy="2" r="1.2"/><circle cx="8" cy="2" r="1.2"/>' +
      '<circle cx="2" cy="7" r="1.2"/><circle cx="8" cy="7" r="1.2"/>' +
      '<circle cx="2" cy="12" r="1.2"/><circle cx="8" cy="12" r="1.2"/></svg>';
    row.append(grip);

    row.append(el('span', 'outline-index', String(index + 1).padStart(2, '0')));

    const raw = (item.title || item.text || '').trim().replace(/\s+/g, ' ');
    const label = raw || `条目 ${index + 1}`;
    row.append(el('span', 'outline-label', label.length > 40 ? `${label.slice(0, 40)}…` : label));

    if (item.audio?.file) {
      row.append(el('span', 'outline-dot', '●'));
    }

    row.addEventListener('click', () => {
      selectItem(item.id);
      cardEl(item.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    dom.outline.append(row);
  });
}

function persistOutlineOrder() {
  const section = currentSection();
  if (!section) return;
  const ids = [...dom.outline.querySelectorAll('.outline-item')].map((r) => r.dataset.itemId);
  const byId = new Map(section.items.map((i) => [i.id, i]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length !== section.items.length) return;

  const changed = next.some((item, index) => item.id !== section.items[index].id);
  if (!changed) return;

  pushUndo();
  section.items = next;
  markDirty({ immediate: true });
  renderList();
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight, 88)}px`;
}

/**
 * 自定义音频播放器：隐藏原生 <audio>，换成 播放/暂停 + 可拖动进度条 + 时间。
 * 原生进度条在窄栏里太挤、也不好拖动，这里用更直观的自绘进度条。
 */
function createAudioPlayer(file, durationHint) {
  const wrap = el('div', 'audio-player');

  // 隐藏的原生 audio，负责真正的播放；仍留在 DOM 里，好让全局「同屏只响一个」逻辑生效
  const audio = el('audio', 'ap-audio');
  audio.preload = 'metadata';
  audio.src = mediaUrl(file);

  const toggle = el('button', 'ap-toggle');
  toggle.type = 'button';
  toggle.title = '播放 / 暂停';
  toggle.setAttribute('aria-label', '播放 / 暂停');
  toggle.textContent = '▶';

  const bar = el('div', 'ap-bar');
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', '播放进度');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  bar.tabIndex = 0;
  const progress = el('div', 'ap-progress');
  const thumb = el('div', 'ap-thumb');
  bar.append(progress, thumb);

  const time = el('span', 'ap-time');
  time.textContent = `00:00 / ${durationHint ? fmtDuration(durationHint) : '00:00'}`;

  wrap.append(audio, toggle, bar, time);

  let duration = Number(durationHint) > 0 ? Number(durationHint) : 0;
  let seeking = false;

  const render = () => {
    const cur = audio.currentTime || 0;
    const total = duration > 0 ? duration : (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    if (total > 0 && duration <= 0) duration = total;
    const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
    progress.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    time.textContent = `${fmtDuration(cur)} / ${fmtDuration(total)}`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    toggle.textContent = audio.paused ? '▶' : '⏸';
    toggle.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
  };

  audio.addEventListener('loadedmetadata', render);
  audio.addEventListener('durationchange', render);
  audio.addEventListener('timeupdate', render);
  audio.addEventListener('play', render);
  audio.addEventListener('pause', render);
  audio.addEventListener('ended', render);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  const seekTo = (clientX) => {
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const total = duration > 0 ? duration : audio.duration;
    if (Number.isFinite(total) && total > 0) {
      audio.currentTime = ratio * total;
      render();
    }
  };

  bar.addEventListener('pointerdown', (e) => {
    seeking = true;
    bar.setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (seeking) seekTo(e.clientX);
  });
  bar.addEventListener('pointerup', (e) => {
    if (seeking) {
      seeking = false;
      seekTo(e.clientX);
    }
  });
  bar.addEventListener('pointercancel', () => {
    seeking = false;
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const total = duration > 0 ? duration : audio.duration;
    if (!Number.isFinite(total) || total <= 0) return;
    const step = e.key === 'ArrowLeft' ? -5 : 5;
    audio.currentTime = Math.max(0, Math.min(total, audio.currentTime + step));
    render();
  });

  return { wrap, audio };
}

function makeRecordButton(itemId, label) {
  const btn = el('button', 'rec-btn', label);
  btn.type = 'button';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectItem(itemId);
    toggleRecording();
    btn.blur();
  });
  return btn;
}

function makeRecPill(itemId) {
  const pill = el('span', 'rec-pill');
  pill.hidden = S.rec?.itemId !== itemId;
  pill.textContent = '00:00';
  return pill;
}

function createCard(section, item, index) {
  const card = el('article', 'card');
  card.dataset.itemId = item.id;
  if (!MODE.print) {
    card.tabIndex = 0;
    if (item.id === S.itemId) card.classList.add('selected');
    if (S.rec?.itemId === item.id) card.classList.add('recording');
  }

  /* --- 左：图片（可多张） --- */
  const mediaWrap = el('div', 'card-media');
  const images = itemImages(item);

  if (images.length === 0) {
    const slot = el('div', 'media-slot empty');
    if (MODE.print) {
      slot.textContent = '（无图片）';
    } else if (canEdit()) {
      slot.append(el('span', 'media-add-icon', '＋'));
      slot.append(el('span', 'media-add-label', '添加图片'));
      slot.append(el('span', 'media-add-hint', 'PNG / JPG · 可多选'));
      slot.addEventListener('click', () => {
        selectItem(item.id);
        pickImages(item.id);
      });
    } else {
      slot.textContent = '无图片';
    }
    mediaWrap.append(slot);
  } else {
    const gallery = el('div', `gallery${images.length === 1 ? ' single' : ''}`);
    const printable = MODE.print ? images.slice(0, 6) : images;

    printable.forEach((image, imageIndex) => {
      const tile = el('div', 'shot');
      const img = el('img');
      img.src = mediaUrl(image.file);
      img.alt = '';
      img.loading = MODE.print ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      if (canEdit() && images.length > 1) {
        tile.draggable = true;
        tile.dataset.index = String(imageIndex);
        tile.title = '拖拽排序';
      }
      if (!MODE.print) {
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openLightbox(images.map((i) => i.file), imageIndex);
        });
      }
      tile.append(img);

      if (images.length > 1) {
        tile.append(el('span', 'shot-badge', String(imageIndex + 1)));
      }

      if (canEdit()) {
        const clear = el('button', 'media-clear', '×');
        clear.type = 'button';
        clear.title = '移除这张图片';
        clear.addEventListener('click', (e) => {
          e.stopPropagation();
          pushUndo();
          images.splice(imageIndex, 1);
          item.updatedAt = nowIso();
          markDirty({ immediate: true });
          renderList();
        });
        tile.append(clear);
      }

      gallery.append(tile);
    });

    if (canEdit() && images.length > 1) {
      bindGalleryDrag(gallery, images);
    }

    if (MODE.print && images.length > 6) {
      mediaWrap.append(el('div', 'gallery-more', `共 ${images.length} 张，其余见 data/images`));
    }

    // 已经到上限时不再提供「继续添加」，避免点了没反应
    const canAddMore = canEdit() && images.length < MAX_IMAGES_PER_ITEM;
    if (canAddMore) {
      const add = el('button', 'shot-add');
      add.type = 'button';
      add.title = '添加更多图片 · 拖动图片可排序';
      add.append(el('span', 'shot-add-icon', '＋'));
      add.append(el('span', 'shot-add-label', '添加 / 拖拽排序'));
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        selectItem(item.id);
        pickImages(item.id);
      });
      gallery.append(add);
    }

    mediaWrap.append(gallery);
  }

  /* --- 右：序号 + 操作 + 文案 + 音频 --- */
  const body = el('div', 'card-body');
  const head = el('div', 'card-head');
  head.append(el('span', 'card-index', String(index + 1).padStart(2, '0')));

  if (canEdit()) {
    const titleInput = el('input', 'item-title');
    titleInput.type = 'text';
    titleInput.value = item.title || '';
    titleInput.placeholder = '标题';
    titleInput.maxLength = 6;
    titleInput.dataset.itemId = item.id;
    titleInput.title = '可选标题（6 字内），用于视频进度条与章节过渡';
    const titleKey = `itemtitle-${item.id}`;
    titleInput.addEventListener('focus', () => {
      selectItem(item.id);
      textEditStart(titleKey);
    });
    titleInput.addEventListener('input', () => {
      textEditChange(titleKey);
      item.title = titleInput.value;
      item.updatedAt = nowIso();
      markDirty();
    });
    head.append(titleInput);
  } else if (item.title) {
    head.append(el('span', 'item-title-static', item.title));
  }

  head.append(el('div', 'card-spacer'));

  if (S.busy.has(item.id)) head.append(el('span', 'busy', S.busy.get(item.id)));

  if (canEdit()) {
    const del = el('button', 'rec-btn', '删除');
    del.type = 'button';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteItem(item.id);
    });
    head.append(del);

    const videoBtn = el('button', 'video-btn', '视频');
    videoBtn.type = 'button';
    videoBtn.title = '把这条导出成视频';
    videoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectItem(item.id);
      exportItemVideo(item.id);
      videoBtn.blur();
    });
    head.append(videoBtn);
  }

  body.append(head);

  if (canEdit()) {
    const ta = el('textarea', 'item-text');
    ta.value = item.text || '';
    ta.placeholder = '写点文案…';
    ta.rows = 3;
    ta.dataset.itemId = item.id;
    const textKey = `itemtext-${item.id}`;
    ta.addEventListener('focus', () => {
      selectItem(item.id);
      textEditStart(textKey);
    });
    ta.addEventListener('input', () => {
      textEditChange(textKey);
      item.text = ta.value;
      item.updatedAt = nowIso();
      autoGrow(ta);
      markDirty();
    });
    body.append(ta);
    requestAnimationFrame(() => autoGrow(ta));
  } else {
    const text = el('div', 'item-text-static');
    if (item.text) text.textContent = item.text;
    else {
      text.classList.add('empty');
      text.textContent = '（无文案）';
    }
    body.append(text);
  }

  const audioRow = el('div', 'item-audio');
  if (item.audio?.file) {
    if (MODE.print) {
      const meta = el('span', 'audio-file-line');
      const duration = item.audio.duration ? fmtDuration(item.audio.duration) : '';
      meta.textContent = `${item.audio.file}${duration ? ` · ${duration}` : ''}`;
      audioRow.append(meta);
    } else {
      const player = createAudioPlayer(item.audio.file, item.audio.duration);
      audioRow.append(player.wrap);
    }

    if (canEdit()) {
      audioRow.append(makeRecordButton(item.id, '重录'));
      audioRow.append(makeRecPill(item.id));

      const sttBtn = el('button', 'rec-btn', '转文字');
      sttBtn.type = 'button';
      sttBtn.title = '本地 mlx-whisper 转写，并用本地模型整理成一段描述';
      sttBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        transcribeItem(item.id);
      });
      audioRow.append(sttBtn);

      const delAudio = el('button', 'rec-btn', '删除录音');
      delAudio.type = 'button';
      delAudio.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        item.audio = null;
        item.updatedAt = nowIso();
        markDirty({ immediate: true });
        renderList();
      });
      audioRow.append(delAudio);
    }
  } else if (canEdit()) {
    audioRow.append(makeRecordButton(item.id, '录音'));
    audioRow.append(makeRecPill(item.id));
  }

  if (audioRow.childNodes.length > 0) body.append(audioRow);

  // 条目底部的小字快捷键提示（空格录音、粘贴图片、拖拽排序）
  if (canEdit()) {
    body.append(el('div', 'item-hints', '空格 录音 · ⌘V 粘贴图片 · 拖动图片 / 左侧条目可排序'));
  }

  // 视频时长校验提示：图片多、语音短时会静音续播
  if (canEdit()) {
    const hint = videoTimingHint(item);
    if (hint) {
      const warn = el('div', 'item-warning');
      warn.append(el('span', 'item-warning-icon', '⚠'));
      warn.append(
        el(
          'span',
          'item-warning-text',
          `语音 ${fmtSecondsBrief(hint.audio)} 短于 ${hint.n} 张图最短展示 ${fmtSecondsBrief(hint.minFull)}，视频将静音续播约 ${fmtSecondsBrief(hint.gap)}`,
        ),
      );
      body.append(warn);
    }
  }

  // 打印模式且没有图片时，不占用图片列，让文案占满整行（否则空图位会把卡片撑高、导致多页）
  if (MODE.print && images.length === 0) {
    card.classList.add('no-media');
    card.append(body);
  } else {
    card.append(mediaWrap, body);
  }

  if (!MODE.print) {
    card.addEventListener('pointerdown', () => selectItem(item.id));
  }

  return card;
}

function itemImages(item) {
  if (!Array.isArray(item.images)) {
    item.images = item.image ? [item.image] : [];
    delete item.image;
  }
  return item.images;
}

/**
 * 视频时长校验：图片多、语音短时，视频会「静音续播」到图片能完整展示一遍。
 * 与后端 computeGalleryTimeline 的保底策略保持一致，返回提示对象或 null。
 */
function videoTimingHint(item) {
  const n = itemImages(item).length;
  if (n === 0) return null;

  const hold = Number(S.videoCfg.secondsPerImage) || 2;
  const trans = Number(S.videoCfg.transSeconds) >= 0 ? Number(S.videoCfg.transSeconds) : 0.5;
  const audio = Number(item.audio?.duration) || 0;
  // 没录音时不在此提示：auto 会用 TTS（时长未知），recording 则纯静音
  if (audio <= 0) return null;

  const minFull = n === 1 ? hold : n * hold + (n - 1) * trans;
  if (audio >= minFull) return null;

  return { n, audio, minFull, gap: minFull - audio };
}

/* ---------------- 图片拖拽排序 ---------------- */

let dragShot = null;

function bindGalleryDrag(gallery, images) {
  gallery.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.shot');
    if (!tile) return;
    dragShot = tile;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', tile.dataset.index || '');
    } catch {
      /* ignore */
    }
  });

  gallery.addEventListener('dragover', (e) => {
    if (!dragShot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = galleryShotAt(gallery, dragShot, e.clientX, e.clientY);
    if (target) {
      gallery.insertBefore(dragShot, target);
    } else {
      const add = gallery.querySelector('.shot-add');
      if (add) gallery.insertBefore(dragShot, add);
      else gallery.append(dragShot);
    }
  });

  gallery.addEventListener('drop', (e) => {
    if (dragShot) e.preventDefault();
  });

  gallery.addEventListener('dragend', () => {
    if (!dragShot) return;
    dragShot.classList.remove('dragging');
    dragShot = null;
    persistGalleryOrder(gallery, images);
  });
}

/** 返回拖拽元素应插入到哪个 .shot 之前；null 表示放到末尾 */
function galleryShotAt(gallery, dragging, x, y) {
  const shots = [...gallery.querySelectorAll('.shot')].filter((s) => s !== dragging);
  for (const shot of shots) {
    const r = shot.getBoundingClientRect();
    if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return shot;
  }
  return null;
}

function persistGalleryOrder(gallery, images) {
  const order = [...gallery.querySelectorAll('.shot')].map((t) => Number(t.dataset.index));
  if (order.length !== images.length) return;
  const next = order.map((i) => images[i]).filter(Boolean);
  if (next.length !== images.length) return;
  if (order.every((idx, pos) => idx === pos)) return;
  pushUndo();
  images.splice(0, images.length, ...next);
  markDirty({ immediate: true });
  renderList();
}

/* ---------------- 选中 / 快捷键 ---------------- */

function selectItem(itemId) {
  if (S.itemId === itemId) return;
  S.itemId = itemId;
  for (const card of dom.list.querySelectorAll('.card')) {
    card.classList.toggle('selected', card.dataset.itemId === itemId);
  }
  for (const row of dom.outline.querySelectorAll('.outline-item')) {
    row.classList.toggle('active', row.dataset.itemId === itemId);
  }
}

function moveSelection(delta) {
  const section = currentSection();
  if (!section || section.items.length === 0) return;
  const ids = section.items.map((i) => i.id);
  let index = ids.indexOf(S.itemId);
  index = index < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, index + delta));
  selectItem(ids[index]);
  cardEl(ids[index])?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  outlineRowEl(ids[index])?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------------- 条目 / 页签操作 ---------------- */

function addItem({ focusText = true } = {}) {
  const section = currentSection();
  if (!section) {
    toast('请先创建一个页签');
    return null;
  }
  pushUndo();
  const ts = nowIso();
  const seq = ++S.data.counters.item;
  const item = {
    id: newId('i'),
    seq,
    // 默认标题带上稳定序号，避免一堆空标题条目在删除时无法区分
    title: `第${seq}条`,
    text: '',
    images: [],
    audio: null,
    createdAt: ts,
    updatedAt: ts,
  };
  section.items.push(item);
  S.itemId = item.id;
  markDirty({ immediate: true });
  renderList();

  if (focusText) {
    const ta = dom.list.querySelector(`textarea[data-item-id="${CSS.escape(item.id)}"]`);
    ta?.focus();
  }
  cardEl(item.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return item;
}

async function deleteItem(itemId) {
  const section = sectionOfItem(itemId);
  if (!section) return;
  const index = section.items.findIndex((i) => i.id === itemId);
  if (index < 0) return;

  const item = section.items[index];
  const summary = (item.title || item.text || '').trim().replace(/\s+/g, ' ');
  const label = summary ? (summary.length > 24 ? `${summary.slice(0, 24)}…` : summary) : '';

  const media = [];
  const imageCount = itemImages(item).length;
  if (imageCount) media.push(`图片 ${imageCount} 张`);
  if (item.audio?.file) media.push('录音 1 段');

  const ok = await askConfirm({
    title: label ? `删除「${label}」？` : '删除这个条目？',
    text: media.length
      ? `${media.join('、')}会一起从清单里移除，磁盘上的文件仍保留在 data 目录。`
      : '这条会从清单里移除，⌘Z 可以撤销。',
  });
  if (!ok) return;

  // 弹窗期间可能已经被别处改过，重新定位，避免删错
  const target = sectionOfItem(itemId);
  if (!target) return;
  const at = target.items.findIndex((i) => i.id === itemId);
  if (at < 0) return;

  if (S.rec?.itemId === itemId) stopRecording(true);
  pushUndo();
  target.items.splice(at, 1);
  if (S.itemId === itemId) {
    S.itemId = target.items[Math.min(at, target.items.length - 1)]?.id ?? null;
  }
  markDirty({ immediate: true });
  renderList();
}

function addSection() {
  pushUndo();
  const ts = nowIso();
  const section = {
    id: newId('s'),
    name: `页签 ${S.data.sections.length + 1}`,
    seq: ++S.data.counters.section,
    createdAt: ts,
    items: [],
  };
  S.data.sections.push(section);
  S.sectionId = section.id;
  S.itemId = null;
  markDirty({ immediate: true });
  render();
  startRename(section);
}

async function deleteSection(sectionId) {
  if (S.data.sections.length <= 1) {
    toast('至少保留一个页签');
    return;
  }
  const section = S.data.sections.find((s) => s.id === sectionId);
  if (!section) return;

  const count = section.items.length;
  const ok = await askConfirm({
    title: `删除页签「${section.name}」？`,
    text: `${count ? `其中 ${count} 个条目会一起移除。` : ''}媒体文件不会被删除，⌘Z 可以撤销。`,
  });
  if (!ok) return;

  if (S.rec && section.items.some((i) => i.id === S.rec.itemId)) stopRecording(true);
  pushUndo();
  S.data.sections = S.data.sections.filter((s) => s.id !== sectionId);
  if (S.sectionId === sectionId) {
    S.sectionId = S.data.sections[0].id;
    S.itemId = null;
  }
  markDirty({ immediate: true });
  render();
}

function setBusy(itemId, label) {
  if (label) S.busy.set(itemId, label);
  else S.busy.delete(itemId);
  if (!MODE.print) renderList();
}

/* ---------------- 图片 ---------------- */

/** 打开系统文件选择器，可多选图片（PNG / JPG 等），选中后上传到指定条目 */
function pickImages(itemId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept =
    'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/svg+xml,image/heic,image/heif';
  input.multiple = true;
  input.style.display = 'none';

  const cleanup = () => {
    input.remove();
    window.removeEventListener('focus', cleanup);
  };

  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])].filter(isImageFile);
    cleanup();
    if (!files.length) return;
    if (itemId) selectItem(itemId);
    handleImageFiles(files);
  });
  // 个别浏览器不触发 cancel 事件，用「窗口重新获得焦点」兜底清理
  input.addEventListener('cancel', cleanup);
  window.addEventListener('focus', cleanup);

  document.body.append(input);
  input.click();
}

async function handleImageFiles(files) {
  if (!canEdit() || files.length === 0) return;
  let item = currentItem();
  if (!item) item = addItem({ focusText: false });
  if (!item) return;

  const section = sectionOfItem(item.id);
  if (!section) return;

  const list = itemImages(item);
  const room = MAX_IMAGES_PER_ITEM - list.length;
  if (room <= 0) {
    toast(`一条最多放 ${MAX_IMAGES_PER_ITEM} 张图片`, 'error');
    return;
  }
  const batch = files.slice(0, Math.min(room, MAX_IMAGES_PER_REQUEST));

  setBusy(item.id, batch.length > 1 ? `上传 ${batch.length} 张图片…` : '上传图片…');
  try {
    const form = new FormData();
    for (const file of batch) form.append('files', file, file.name || 'paste.png');
    form.append('sectionSeq', String(section.seq));
    form.append('itemSeq', String(item.seq));

    const res = await fetch('/api/media/images', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败 (HTTP ${res.status})`);

    const added = Array.isArray(data.images) ? data.images : [];
    pushUndo();
    list.push(...added.map((image) => ({ file: image.file, w: image.w, h: image.h })));
    item.updatedAt = nowIso();
    markDirty({ immediate: true });
    if (files.length > batch.length) {
      toast(`一条最多 ${MAX_IMAGES_PER_ITEM} 张，本次只上传了前 ${batch.length} 张`);
    }
  } catch (err) {
    toast(`图片处理失败：${err.message}`, 'error', 7000);
  } finally {
    setBusy(item.id, null);
  }
}

/* ---------------- 录音实时波形 ---------------- */

let wave = null;

function startWaveform(stream) {
  stopWaveform();
  const canvas = dom.recWave;
  if (!canvas) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;

  let audioCtx;
  try {
    audioCtx = new AC();
  } catch {
    return;
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

  wave = {
    audioCtx,
    analyser,
    ctx2d: canvas.getContext('2d'),
    data: new Uint8Array(analyser.fftSize),
    W: canvas.width,
    H: canvas.height,
    raf: 0,
  };
  wave.raf = requestAnimationFrame(drawWaveform);
}

function drawWaveform() {
  if (!wave) return;
  wave.raf = requestAnimationFrame(drawWaveform);

  const { analyser, ctx2d, data, W, H } = wave;
  analyser.getByteTimeDomainData(data);

  const mid = H / 2;
  const amp = H / 2 - 3;
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.beginPath();
  const step = data.length / W;
  for (let x = 0; x < W; x++) {
    const idx = Math.min(data.length - 1, Math.round(x * step));
    const v = (data[idx] - 128) / 128;
    const y = mid + v * amp;
    if (x === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.strokeStyle = '#ff7a72';
  ctx2d.lineWidth = 2;
  ctx2d.lineJoin = 'round';
  ctx2d.lineCap = 'round';
  ctx2d.stroke();
}

function stopWaveform() {
  if (!wave) return;
  cancelAnimationFrame(wave.raf);
  const audioCtx = wave.audioCtx;
  wave = null;
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  const canvas = dom.recWave;
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

/* ---------------- 录音 ---------------- */

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
  return null;
}

function toggleRecording() {
  if (S.rec) {
    stopRecording();
    return;
  }
  startRecording('button');
}

async function startRecording(trigger = 'space') {
  if (!canEdit() || S.rec) return;
  const item = currentItem();
  if (!item) {
    toast('先选中一个条目');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('当前浏览器不支持录音（需要 https 或 localhost）', 'error', 7000);
    return;
  }

  // 先把正在播的录音停掉，否则会被麦克风录进去
  pauseOtherMedia();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    const message =
      err.name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器地址栏的权限设置里允许'
        : `无法访问麦克风：${err.message}`;
    toast(message, 'error', 8000);
    return;
  }

  const mime = pickMime();
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`浏览器无法创建录音器：${err.message}`, 'error', 7000);
    return;
  }

  const ctx = {
    recorder,
    stream,
    chunks: [],
    itemId: item.id,
    startAt: Date.now(),
    cancelled: false,
    trigger,
    mime: recorder.mimeType || mime || 'audio/webm',
    timerId: null,
  };

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) ctx.chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    ctx.cancelled = true;
    toast(`录音出错：${e.error?.message || '未知错误'}`, 'error', 7000);
    if (S.rec === ctx) stopRecording();
  };
  recorder.onstop = () => finalizeRecording(ctx);

  try {
    recorder.start(250);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`开始录音失败：${err.message}`, 'error', 7000);
    return;
  }

  S.rec = ctx;
  updateRecordingUI();
  startWaveform(stream);
  ctx.timerId = setInterval(() => {
    if (S.rec !== ctx) return;
    const seconds = (Date.now() - ctx.startAt) / 1000;
    updateRecordingPill(seconds);
    if (seconds >= MAX_RECORD_SECONDS) {
      toast(`已达到 ${Math.round(MAX_RECORD_SECONDS / 60)} 分钟录音上限，自动停止`);
      stopRecording();
    }
  }, 200);
}

function stopRecording(cancel = false) {
  const ctx = S.rec;
  if (!ctx) return;
  ctx.cancelled = cancel;
  S.rec = null;
  clearInterval(ctx.timerId);
  updateRecordingUI();
  if (ctx.recorder.state === 'inactive') {
    finalizeRecording(ctx);
    return;
  }
  try {
    ctx.recorder.stop();
  } catch {
    finalizeRecording(ctx);
  }
}

function updateRecordingUI() {
  const activeId = S.rec?.itemId ?? null;
  for (const card of dom.list.querySelectorAll('.card')) {
    const on = card.dataset.itemId === activeId;
    card.classList.toggle('recording', on);
    const pill = card.querySelector('.rec-pill');
    if (pill) pill.hidden = !on;
  }
  if (dom.recLive) dom.recLive.hidden = !activeId;
  if (activeId) updateRecordingPill(0);
}

function updateRecordingPill(seconds) {
  const pill = cardEl(S.rec?.itemId)?.querySelector('.rec-pill');
  if (pill) pill.textContent = fmtDuration(seconds);
  if (dom.recLiveTime) dom.recLiveTime.textContent = fmtDuration(seconds);
}

async function finalizeRecording(ctx) {
  ctx.stream.getTracks().forEach((t) => t.stop());
  clearInterval(ctx.timerId);
  stopWaveform();
  if (S.rec === ctx) S.rec = null;
  updateRecordingUI();

  if (ctx.cancelled) return;

  const duration = (Date.now() - ctx.startAt) / 1000;
  const blob = new Blob(ctx.chunks, { type: ctx.mime });
  if (blob.size < 1000 || duration < 0.4) {
    toast('录音太短，已丢弃');
    return;
  }
  await uploadAudio(ctx.itemId, blob, duration, ctx.mime);
}

async function uploadAudio(itemId, blob, duration, mime) {
  const item = findItem(itemId);
  const section = sectionOfItem(itemId);
  if (!item || !section) return;

  setBusy(itemId, '音频处理中…');
  try {
    const form = new FormData();
    form.append('file', blob, `recording.${extFromMime(mime)}`);
    form.append('sectionSeq', String(section.seq));
    form.append('itemSeq', String(item.seq));
    form.append('duration', String(Math.round(duration * 100) / 100));

    const res = await fetch('/api/media/audio', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败 (HTTP ${res.status})`);

    pushUndo();
    item.audio = {
      file: data.file,
      duration: data.duration ?? Math.round(duration * 100) / 100,
      format: data.format || extFromMime(mime),
      mime: data.mime || mime,
    };
    item.updatedAt = nowIso();
    markDirty({ immediate: true });
  } catch (err) {
    toast(`音频保存失败：${err.message}`, 'error', 8000);
  } finally {
    setBusy(itemId, null);
  }
}

/* ---------------- 语音转文字 ---------------- */

async function transcribeItem(itemId) {
  const item = findItem(itemId);
  if (!item?.audio?.file) return;

  if (!sttHintShown) {
    sttHintShown = true;
    toast('首次转写需要下载/加载模型，可能较慢；之后会快很多', 'info', 7000);
  }
  openLogPanel();
  setBusy(itemId, '转写中…');
  const startedAt = performance.now();
  try {
    const res = await fetch('/api/audio/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const textToAdd = String(data.description || data.transcript || '').trim();
    if (!textToAdd) throw new Error('没有识别到语音内容');

    pushUndo();
    item.text = item.text ? `${item.text.replace(/\s+$/, '')}\n${textToAdd}` : textToAdd;
    item.updatedAt = nowIso();
    markDirty({ immediate: true });

    const t = data.timings || {};
    const sec = (ms) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;
    const speed = t.speed ? `，${t.speed}x 实时` : '';
    const detail = t.transcribeMs
      ? `转写 ${sec(t.transcribeMs)}${speed}` +
        (t.describeMs ? ` + 描述 ${sec(t.describeMs)}` : '') +
        ` = ${sec(t.totalMs ?? data.tookMs)}`
      : `耗时 ${sec(data.tookMs)}`;
    const downloadHint = t.downloaded ? '（首次下载模型，后续会快很多）' : '';
    const cacheHint = t.transcribeCached || t.describeCached ? '（命中缓存）' : '';

    console.log('[transcribe]', detail, t);

    if (data.llmError) {
      toast(`转写完成：${detail}${downloadHint}${cacheHint}，但描述生成失败，已写入原始文字`, 'info', 9000);
    } else {
      toast(`转写完成：${detail}${downloadHint}${cacheHint}，已写入文案`, 'info', 6000);
    }
  } catch (err) {
    const elapsed = Math.round(performance.now() - startedAt);
    console.warn(`[transcribe] 失败 客户端耗时=${elapsed}ms`, err.message);

    // 服务端现在会返回较长的可操作提示（含底层原因），toast 里截断显示
    const message = String(err.message || '未知错误');
    const brief = message.length > 180 ? `${message.slice(0, 180)}…` : message;
    toast(`转写失败：${brief}（耗时 ${(elapsed / 1000).toFixed(1)}s）`, 'error', 15000);
  } finally {
    setBusy(itemId, null);
  }
}

/* ---------------- 预览 ---------------- */

/** 在新标签页打开只读视图；先保存，避免看到旧内容 */
async function openPreview() {
  // 先同步打开窗口：异步之后再 window.open 会被浏览器当成弹窗拦截
  const tab = window.open('', '_blank');
  try {
    await flushSave();
  } catch {
    /* 保存失败也让用户看到当前内容 */
  }
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('readonly', '1');
  url.hash = '';

  if (tab) {
    tab.location.href = url.toString();
    tab.focus?.();
  } else {
    toast('浏览器拦截了新标签页，请允许弹窗后再试', 'error', 7000);
  }
}

/* ---------------- 工作区 ---------------- */

/** 在本机 Finder 中打开工作区文件夹 */
async function openWorkdir() {
  const btn = dom.btnOpenWorkdir;
  if (!btn) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '打开中…';
  try {
    const res = await fetch('/api/workdir/open', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    toast('已在 Finder 中打开工作区文件夹', 'info', 4000);
  } catch (err) {
    toast(`打开失败：${err.message}`, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---------------- 导出 / 清空 ---------------- */

function refreshVideoButtons() {
  for (const card of dom.list.querySelectorAll('.card')) {
    const btn = card.querySelector('.video-btn');
    if (!btn) continue;
    btn.disabled = S.exporting;
    btn.textContent = S.exportingItem === card.dataset.itemId ? '生成中…' : '视频';
  }
  const tabExport = dom.tabs.querySelector('.tab-export');
  if (tabExport) {
    tabExport.disabled = S.exporting;
    tabExport.textContent = S.exporting && !S.exportingItem ? '生成中…' : '⏺ 导出视频';
  }
}

function setExportBusy(busy, opts = {}) {
  S.exporting = busy;
  S.exportingItem = opts.itemId ?? null;

  for (const btn of [dom.btnPdf, dom.btnExport]) {
    if (!btn) continue;
    btn.disabled = busy;
  }
  dom.btnPdf.textContent = busy && opts.kind === 'pdf' ? '生成中…' : '导出 PDF';
  dom.btnExport.textContent = busy && opts.kind === 'zip' ? '导出中…' : '导出 Zip';

  refreshVideoButtons();
}

async function runExport(kind) {
  if (S.exporting) return;
  const isPdf = kind === 'pdf';
  setExportBusy(true, { kind });
  const working = toast(
    isPdf ? '正在生成 PDF…（首次启动 Chrome 可能稍慢）' : '正在生成 PDF 并打包…（首次启动 Chrome 可能稍慢）',
    'info',
    0,
  );
  try {
    await flushSave();
    const res = await fetch(isPdf ? '/api/export/pdf' : '/api/export', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `导出失败 (HTTP ${res.status})`);
    showExportResult(data, isPdf ? 'pdf' : 'zip');
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error', 10000);
  } finally {
    // 统一在 finally 收掉「生成中」弹窗，任何分支都不会残留
    dismissToast(working);
    setExportBusy(false);
  }
}

function doExportPdf() {
  return runExport('pdf');
}

function doExport() {
  return runExport('zip');
}

async function exportVideo({ mode, itemId, toastStart }) {
  if (S.exporting) return;
  openLogPanel();
  setExportBusy(true, { itemId });
  const working = toast(toastStart || '正在生成视频…', 'info', 0);
  try {
    await flushSave();
    const res = await fetch('/api/export/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, itemId, audioSource: S.audioSource }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `导出失败 (HTTP ${res.status})`);
    showVideoResult(data);
  } catch (err) {
    toast(`导出失败：${err.message}`, 'error', 10000);
  } finally {
    // 统一在 finally 收掉「生成中」弹窗，任何分支都不会残留
    dismissToast(working);
    setExportBusy(false);
  }
}

function exportItemVideo(itemId) {
  return exportVideo({ mode: 'items', itemId, toastStart: '正在生成这条的视频…' });
}

function exportSectionsVideo() {
  return exportVideo({ mode: 'sections', toastStart: '正在生成章节视频…' });
}

function sizeText(size) {
  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(2)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function showVideoResult(data) {
  const node = el('div', 'toast');
  if (data.mode === 'items' && data.count === 1) {
    node.append(el('div', null, '这条已生成视频'));
  } else {
    const modeLabel = data.mode === 'sections' ? '每个章节' : data.mode === 'all' ? '全部合并' : '每个条目';
    node.append(el('div', null, `视频已生成 · ${modeLabel} · ${data.count} 个`));
  }

  const list = el('div', 'export-list');
  for (const f of data.files || []) {
    const row = el('div', 'export-file');
    const name = el('span', 'export-file-name', f.name);
    const size = el('span', 'export-file-size', sizeText(f.size));
    const link = el('a', null, '下载');
    link.href = f.url;
    link.download = f.name;
    row.append(name, size, link);
    list.append(row);
  }
  node.append(list);

  const openBtn = el('button', 'toast-open', '打开所在文件夹');
  openBtn.type = 'button';
  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    openBtn.textContent = '打开中…';
    try {
      const res = await fetch('/api/export/video/open', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      toast('已在 Finder 中打开视频目录', 'info', 4000);
    } catch (err) {
      toast(`打开失败：${err.message}`, 'error', 6000);
    } finally {
      openBtn.disabled = false;
      openBtn.textContent = '打开所在文件夹';
    }
  });
  node.append(openBtn);

  // 结果里带文件列表和「打开所在文件夹」，给足 20 秒；鼠标移上去会暂停
  mountToast(node, { timeout: 20000 });
}

function showExportResult(data, kind = 'zip') {
  const fileName = data.pdf || data.zip;
  const isPdf = kind === 'pdf';

  const node = el('div', 'toast');
  node.append(el('div', null, `${isPdf ? 'PDF 已生成' : '导出完成'} · ${sizeText(data.size)}`));

  const link = el('a', null, fileName);
  link.href = data.url;
  link.download = fileName;
  node.append(link);

  node.append(el('div', null, data.path));

  // 带下载链接，给 12 秒；鼠标移上去会暂停
  mountToast(node, { timeout: 12000 });

  // 浏览器下载（PDF 用新标签预览更直观时也可以，这里统一走下载）
  const auto = el('a');
  auto.href = data.url;
  auto.download = fileName;
  auto.style.display = 'none';
  document.body.append(auto);
  auto.click();
  setTimeout(() => auto.remove(), 1000);
}

async function doReset() {
  const total = S.data.sections.reduce((sum, s) => sum + s.items.length, 0);
  const ok = await askConfirm({
    title: '清空当前清单？',
    text: `全部 ${S.data.sections.length} 个页签、${total} 个条目都会被移除，媒体文件仍保留在 data 目录。`,
    okText: '清空',
  });
  if (!ok) return;

  try {
    await flushSave();
    const res = await fetch('/api/reset', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = await res.json();
    pushUndo();
    S.data = fresh;
    S.sectionId = fresh.sections[0]?.id ?? null;
    S.itemId = null;
    S.saveError = false;
    setIndicator('saved');
    render();
    toast('已清空，媒体文件仍保留在 data 目录');
  } catch (err) {
    toast(`清空失败：${err.message}`, 'error', 7000);
  }
}

/* ---------------- 导入备份 ---------------- */

const isZipFile = (file) =>
  /\.zip$/i.test(file.name) || ['application/zip', 'application/x-zip-compressed'].includes(file.type);

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg|heic|heif)$/i;

const isImageFile = (file) => file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name || '');

const dropHasFiles = (event) => {
  const dt = event.dataTransfer;
  if (!dt) return false;
  return (dt.types && [...dt.types].includes('Files')) || (dt.files && dt.files.length > 0);
};

async function doImportFile(file) {
  if (!canEdit() || S.importing) return;
  const ok = await askConfirm({
    title: '导入备份？',
    text: '导入会整体替换当前清单，未保存的改动会丢失。',
    okText: '导入',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;

  // 让已有改动在导入前落盘，避免排队中的旧快照在导入后覆盖新数据
  await flushSave();

  S.importing = true;
  const working = toast('正在导入备份…', 'info', 0);
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/import', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `导入失败 (HTTP ${res.status})`);

    // 清掉保存队列与撤销历史，防止旧状态回写
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingSaves = 0;
    saveTail = Promise.resolve();
    history.undo.length = 0;
    history.redo.length = 0;
    history.pendingText = null;

    const stateRes = await fetch('/api/state', { cache: 'no-store' });
    if (!stateRes.ok) throw new Error(`读取导入结果失败 (HTTP ${stateRes.status})`);
    S.data = await stateRes.json();
    S.sectionId = S.data.sections[0]?.id ?? null;
    S.itemId = null;
    S.saveError = false;
    setIndicator('saved');
    render();
    refreshUndoRedo();
    selectFirstItem();

    const missing = Array.isArray(data.missing) ? data.missing.length : 0;
    toast(
      `已导入「${data.title}」· ${data.sections} 个页签、${data.items} 个条目` +
        (missing ? `，${missing} 个媒体文件缺失` : ''),
      'info',
      8000,
    );
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error', 10000);
  } finally {
    S.importing = false;
    dismissToast(working);
  }
}

/**
 * 拖入文件的统一入口：
 * - zip → 导入备份（整体替换）
 * - 图片 → 上传到当前激活的条目（没有当前条目时自动新建一条）
 */
function handleDroppedFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (files.length === 0) return;

  const zip = files.find(isZipFile);
  if (zip) {
    if (files.length > 1) toast('一次只导入一个备份文件', 'info', 4000);
    doImportFile(zip);
    return;
  }

  const images = files.filter(isImageFile);
  if (images.length) {
    if (images.length < files.length) {
      toast('只支持拖入图片或备份 zip，已忽略不支持的格式', 'info', 5000);
    }
    handleImageFiles(images);
    return;
  }

  toast('只能拖入备份 zip 或图片', 'error', 6000);
}

let dropDepth = 0;

function bindFileDrop() {
  window.addEventListener('dragenter', (event) => {
    if (!canEdit() || !dropHasFiles(event)) return;
    dropDepth += 1;
    dom.dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', (event) => {
    if (!canEdit() || !dropHasFiles(event)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0) dom.dropOverlay.hidden = true;
  });
  window.addEventListener('dragover', (event) => {
    if (!canEdit() || !dropHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (event) => {
    if (!canEdit() || !dropHasFiles(event)) return;
    event.preventDefault();
    dropDepth = 0;
    dom.dropOverlay.hidden = true;
    handleDroppedFiles(event.dataTransfer.files);
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindLightbox() {
  dom.lightboxClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  dom.lightboxPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    stepLightbox(-1);
  });
  dom.lightboxNext.addEventListener('click', (e) => {
    e.stopPropagation();
    stepLightbox(1);
  });

  // 点背景关闭，点图片本身不关闭
  dom.lightbox.addEventListener('click', (e) => {
    if (e.target === dom.lightbox || e.target === dom.lightboxStage) closeLightbox();
  });

  // 手机左右滑动切换
  let startX = 0;
  let startY = 0;
  let tracking = false;
  const stage = dom.lightboxStage;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      stepLightbox(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

function bindEvents() {
  dom.titleInput.addEventListener('focus', () => textEditStart('doctitle'));
  dom.titleInput.addEventListener('input', () => {
    textEditChange('doctitle');
    S.data.title = dom.titleInput.value;
    document.title = dom.titleInput.value || '清单';
    markDirty();
  });

  dom.btnExport.addEventListener('click', doExport);
  dom.btnPdf?.addEventListener('click', doExportPdf);
  dom.btnPreview?.addEventListener('click', openPreview);
  dom.btnOpenWorkdir?.addEventListener('click', openWorkdir);
  dom.btnReset.addEventListener('click', doReset);
  dom.btnUndo?.addEventListener('click', undo);
  dom.btnRedo?.addEventListener('click', redo);

  dom.btnImport.addEventListener('click', () => {
    dom.importInput.value = '';
    dom.importInput.click();
  });
  dom.importInput.addEventListener('change', () => {
    const files = [...(dom.importInput.files ?? [])];
    if (files.length) doImportFile(files[0]);
    dom.importInput.value = '';
  });

  bindFileDrop();
  bindLightbox();
  bindDialog();
  bindLogPanel();

  document.addEventListener('paste', (e) => {
    if (!canEdit()) return;
    const data = e.clipboardData;
    if (!data) return;

    const files = [];
    for (const entry of data.items || []) {
      if (entry.kind === 'file' && entry.type.startsWith('image/')) {
        const file = entry.getAsFile();
        if (file) files.push(file);
      }
    }
    // 某些场景 items 为空但 files 有内容（例如从 Finder 复制的图片）
    if (files.length === 0 && data.files?.length) {
      for (const file of data.files) {
        if (file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length === 0) return;

    e.preventDefault();
    handleImageFiles(files);
  });

  document.addEventListener('keydown', (e) => {
    // 拦截浏览器「保存网页」：⌘S / Ctrl+S 改为立即保存清单数据
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (canEdit()) {
        flushSave().then(() => {
          if (!S.saveError) toast('已保存', 'info', 1500);
        });
      }
      return;
    }

    if (lbVisible()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepLightbox(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepLightbox(1);
      }
      return;
    }

    // 弹窗自己处理键盘（Enter / Esc / Tab），这里一律不再响应全局快捷键
    if (isDialogOpen()) return;

    if (!canEdit()) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openPreview();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      addItem();
      return;
    }

    if (e.key === 'Escape') {
      if (S.rec) {
        e.preventDefault();
        stopRecording(true);
      }
      return;
    }

    // 空文案输入框里按空格，仍按「长按录音」处理（新建条目后默认聚焦文案）
    const inEditable = isEditable(e.target);
    const emptyTextarea =
      inEditable && e.target.tagName?.toLowerCase() === 'textarea' && !String(e.target.value ?? '').length;
    if (inEditable && !(emptyTextarea && e.code === 'Space')) return;

    if (e.code === 'Space') {
      // 空格永远不触发页面滚动；长按录音时 repeat 也不会把页面往下带
      e.preventDefault();
      if (e.repeat) return;
      // 已经在录音（例如点了「录音」按钮）时，再按空格 = 结束录音，和点击一致
      if (S.rec) {
        stopRecording();
        return;
      }
      startRecording('space');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
      return;
    }

    // Mac 键盘上 ⌫(Backspace) 就是「删除」键；外接键盘的 Delete 也一并支持
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (!S.itemId || isDialogOpen()) return;
      e.preventDefault();
      deleteItem(S.itemId);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    if (S.rec?.trigger === 'space') stopRecording();
  });

  window.addEventListener('blur', () => {
    if (S.rec) stopRecording();
  });

  window.addEventListener('beforeunload', (e) => {
    if (saveTimer || pendingSaves > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  bindOutlineDrag();
}

function bindOutlineDrag() {
  dom.outline.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.outline-item');
    if (!row || !row.draggable) return;
    outlineDragging = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', row.dataset.itemId);
    } catch {
      /* ignore */
    }
  });

  dom.outline.addEventListener('dragover', (e) => {
    if (!outlineDragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest?.('.outline-item');
    if (!target || target === outlineDragging) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (after) target.after(outlineDragging);
    else target.before(outlineDragging);
  });

  dom.outline.addEventListener('drop', (e) => {
    if (outlineDragging) e.preventDefault();
  });

  dom.outline.addEventListener('dragend', () => {
    if (!outlineDragging) return;
    outlineDragging.classList.remove('dragging');
    outlineDragging = null;
    persistOutlineOrder();
  });
}

/* ---------------- 运行日志面板（SSE） ---------------- */

function setLogStatus(state, text) {
  if (!dom.logStatus) return;
  dom.logStatus.dataset.state = state;
  dom.logStatus.textContent = text;
}

function logScrollToBottom(force = false) {
  if (!dom.logBody) return;
  if (force || logAutoScroll) dom.logBody.scrollTop = dom.logBody.scrollHeight;
}

function appendLogLine(line) {
  if (!dom.logBody) return;
  const wasAtBottom = dom.logBody.scrollHeight - dom.logBody.scrollTop - dom.logBody.clientHeight < 40;

  // 空态提示清掉
  dom.logBody.querySelector('.log-empty')?.remove();

  const node = el('div', 'log-line', line);
  // 服务端已把 ndjson 格式化成人话，这里仅按关键字弱标记颜色
  const lower = line.toLowerCase();
  if (lower.includes('错误') || lower.includes('失败') || /\berror\b/.test(lower)) node.dataset.level = 'error';
  else if (lower.includes('警告') || lower.includes('warn')) node.dataset.level = 'warn';
  dom.logBody.append(node);

  // 保持每屏最多 2000 行，避免长时间挂着把 DOM 撑爆
  while (dom.logBody.childElementCount > 2000) dom.logBody.firstElementChild.remove();

  logScrollToBottom(wasAtBottom);
}

function connectLogStream() {
  if (logSource) return logSource;
  if (!('EventSource' in window)) return null;

  setLogStatus('connecting', '连接中…');
  const es = new EventSource('/api/logs/stream');
  es.addEventListener('open', () => setLogStatus('connected', '已连接 · 实时'));
  es.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data?.line) appendLogLine(data.line);
    } catch {
      /* 忽略无法解析的事件 */
    }
  });
  es.addEventListener('error', () => setLogStatus('disconnected', '连接断开，重连中…'));
  logSource = es;
  return es;
}

function openLogPanel() {
  if (!dom.logPanel) return;
  dom.logPanel.hidden = false;
  document.body.classList.add('log-open');
  connectLogStream();
  logScrollToBottom(true);
}

function closeLogPanel() {
  if (!dom.logPanel) return;
  dom.logPanel.hidden = true;
  document.body.classList.remove('log-open');
}

function toggleLogPanel() {
  if (dom.logPanel?.hidden) openLogPanel();
  else closeLogPanel();
}

function bindLogPanel() {
  if (!dom.btnLogs) return;
  dom.btnLogs.addEventListener('click', toggleLogPanel);
  dom.logClose?.addEventListener('click', closeLogPanel);
  dom.logClear?.addEventListener('click', () => {
    if (!dom.logBody) return;
    dom.logBody.replaceChildren(el('div', 'log-empty', '日志已清空，等待新的输出…'));
  });
  dom.logScroll?.addEventListener('click', () => {
    logAutoScroll = !logAutoScroll;
    dom.logScroll.textContent = logAutoScroll ? '暂停滚动' : '恢复滚动';
    if (logAutoScroll) logScrollToBottom(true);
  });

  // 用户手动往上翻时暂停自动滚动；翻回底部时恢复
  dom.logBody?.addEventListener('scroll', () => {
    if (!dom.logBody) return;
    const nearBottom = dom.logBody.scrollHeight - dom.logBody.scrollTop - dom.logBody.clientHeight < 40;
    if (nearBottom !== logAutoScroll) {
      logAutoScroll = nearBottom;
      if (dom.logScroll) dom.logScroll.textContent = logAutoScroll ? '暂停滚动' : '恢复滚动';
    }
  });
}

/* ---------------- 健康检查 / 打印就绪 ---------------- */

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const health = await res.json();
    if (!health.ffmpeg) {
      toast('未检测到 ffmpeg：录音将保存为原始格式，导出视频不可用', 'info', 9000);
    }
    if (!health.chrome) {
      toast('未检测到 Chrome/Chromium：导出 PDF 会失败，请设置 CHROME_PATH', 'error', 12000);
    }

    // 视频语音来源：用服务端 .env 的默认值初始化，TTS 不可用时禁用 TTS 选项
    S.ttsReady = Boolean(health.say);
    if (health.video?.audioSource && ['auto', 'recording', 'tts'].includes(health.video.audioSource)) {
      S.audioSource = health.video.audioSource;
    }
    if (health.video) {
      const nextCfg = {
        secondsPerImage: Number(health.video.secondsPerImage) > 0 ? Number(health.video.secondsPerImage) : 2,
        transSeconds: Number(health.video.transSeconds) >= 0 ? Number(health.video.transSeconds) : 0.5,
      };
      // 配置变化会影响卡片上的「静音续播」提示，需要重算
      const changed = nextCfg.secondsPerImage !== S.videoCfg.secondsPerImage || nextCfg.transSeconds !== S.videoCfg.transSeconds;
      S.videoCfg = nextCfg;
      if (changed) renderList();
    }
    refreshAudioSourceSelect();
  } catch {
    /* 忽略 */
  }
}

async function markPrintReady() {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = [...document.images];
    await Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            }),
      ),
    );
    await Promise.all(images.map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
  } catch {
    /* 忽略 */
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.__PRINT_READY__ = true;
}

/* ---------------- 启动 ---------------- */

async function init() {
  document.body.classList.toggle('readonly', MODE.readonly || MODE.print);
  document.body.classList.toggle('print-mode', MODE.print);
  if (MODE.print) dom.hintbar?.remove();
  if (!canEdit()) {
    // 只读/打印模式：隐藏不可用的操作分区，避免空分组占位把顶栏挤出横向滚动
    for (const btn of [dom.btnUndo, dom.btnRedo, dom.btnPreview, dom.btnReset, dom.btnLogs]) {
      if (!btn) continue;
      btn.hidden = true;
      btn.closest('.action-group')?.setAttribute('hidden', '');
    }
  }

  bindEvents();

  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.data = await res.json();
  } catch (err) {
    dom.list.append(el('div', 'empty', `无法读取数据：${err.message}`));
    return;
  }

  if (!Array.isArray(S.data.sections) || S.data.sections.length === 0) {
    S.data.sections = [
      { id: newId('s'), name: '页签 1', seq: 1, createdAt: nowIso(), items: [] },
    ];
    S.data.counters = { section: 1, item: 0 };
  }

  // 兼容第一版的单图数据
  for (const section of S.data.sections) {
    for (const item of section.items) itemImages(item);
  }

  S.sectionId = S.data.sections[0].id;
  render();
  selectFirstItem();

  if (MODE.print) {
    await markPrintReady();
  } else if (canEdit()) {
    checkHealth();
  }
}

init();
