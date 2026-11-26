'use strict';

(function () {
  const $ = selector => document.querySelector(selector);
  const LS_KEY = 'smac-agent-chat-v2';
  const LS_SIDEBAR_KEY = 'smac-agent-sidebar-collapsed';
  const MAX_ATTACH = 8;
  const MAX_ATTACH_BYTES = 40 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_HISTORY = 420 * 1024;

  const state = {
    token: '',
    device: '',
    info: null,
    models: null,
    root: '',
    workdir: '',
    rootWorkdirs: {},
    backend: '',
    provider: '',
    model: '',
    reasoning: '',
    fast: false,
    wdPath: '',
    wdParent: '',
    previewPath: '',
    sessionName: '',
    messages: [],
    attachments: [],
    sessions: [],
    running: false,
    sending: false,
    ready: false,
    currentTurnId: '',
    ignoredTurnId: '',
    lastSeq: 0,
    es: null,
    saved: null
  };

  const messagesEl = $('#messages');
  const inputEl = $('#input');
  const composerEl = $('#composer');
  const attachmentsEl = $('#attachments');
  const fileInput = $('#fileInput');
  const sendBtn = $('#btnSend');
  const stopBtn = $('#btnStop');
  const attachBtn = $('#btnAttach');
  const statusEl = $('#status');
  const rootSelect = $('#rootSelect');
  const backendSelect = $('#backendSelect');
  const providerSelect = $('#providerSelect');
  const modelSelect = $('#modelSelect');
  const reasoningSelect = $('#reasoningSelect');
  const fastField = $('#fastField');
  const fastToggle = $('#fastToggle');
  const workdirNameEl = $('#workdirName');
  const sessionNameEl = $('#sessionName');
  const historyListEl = $('#historyList');
  const connEl = $('#conn');
  const jumpBtn = $('#jump');
  const toastEl = $('#toast');
  const lightboxEl = $('#lightbox');
  const lightboxImg = $('#lightboxImg');
  const fatalEl = $('#fatal');
  const fatalText = $('#fatalText');
  const sidebarEl = $('#sidebar');
  const appRootEl = $('#appRoot');
  const sidebarScrimEl = $('#sidebarScrim');
  const chatTitleEl = $('#chatTitle');
  const topDeviceEl = $('#topDevice');
  const wdModal = $('#wdModal');
  const wdList = $('#wdList');
  const wdPath = $('#wdPath');
  const wdNewName = $('#wdNewName');
  const previewEl = $('#preview');
  const previewBody = $('#previewBody');
  const previewTitle = $('#previewTitle');
  const previewDownload = $('#previewDownload');
  let toastTimer = null;
  let historyTimer = null;
  let stickToBottom = true;

  /* ---------------- small helpers ---------------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  const BACKEND_LABELS = {
    dsh: 'DeepSeek Harness',
    hermes: 'Hermes Agent',
    codex: 'Codex CLI',
    claude: 'Claude Code',
    agy: 'Gemini · Antigravity',
    opencode: 'OpenCode CLI'
  };

  function backendLabel(value) {
    return BACKEND_LABELS[value] || BACKEND_LABELS.hermes;
  }

  function backendShort(value) {
    if (value === 'dsh') { return 'DeepSeek'; }
    if (value === 'codex') { return 'Codex'; }
    if (value === 'claude') { return 'Claude'; }
    if (value === 'agy') { return 'Gemini'; }
    if (value === 'opencode') { return 'OpenCode'; }
    return 'Hermes';
  }

  function imageSupported() {
    return state.backend === 'hermes' || state.backend === 'codex';
  }

  function unescapeBasic(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function basename(value) {
    const parts = String(value || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(value || '');
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms)) { return ''; }
    if (ms < 1000) { return Math.max(1, Math.round(ms)) + 'ms'; }
    if (ms < 60000) { return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's'; }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return minutes + 'm ' + seconds + 's';
  }

  function fileUrl(filePath, raw) {
    return '/api/file?path=' + encodeURIComponent(filePath) + (raw ? '&raw=1' : '')
      + '&token=' + encodeURIComponent(state.token);
  }

  function workdirBase() {
    const root = String(state.root || '').replace(/[\\/]+$/, '');
    const rel = String(state.workdir || '').replace(/^[\\/]+|[\\/]+$/g, '');
    return rel ? root + '/' + rel : root;
  }

  // Agents often print paths relative to the sync root even when a workdir is
  // selected. If the path already starts with the workdir, resolve it against
  // the root; otherwise treat it as relative to the workdir.
  function baseForPath(value) {
    const raw = String(value || '').replace(/^[\\/]+/, '');
    const rel = String(state.workdir || '').replace(/^[\\/]+|[\\/]+$/g, '');
    if (rel && (raw === rel || raw.indexOf(rel + '/') === 0)) { return state.root; }
    return workdirBase();
  }

  function joinWorkdir(value) {
    const raw = String(value || '');
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || /^[a-z]+:\/\//i.test(raw)) { return raw; }
    return baseForPath(raw) + '/' + raw.replace(/^[\\/]+/, '');
  }

  function formatWhen(value) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (!time || !isFinite(time)) { return ''; }
    const date = new Date(time);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const pad = number => String(number).padStart(2, '0');
    if (sameDay) { return pad(date.getHours()) + ':' + pad(date.getMinutes()); }
    if (date.getFullYear() === now.getFullYear()) {
      return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }
    return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
  }

  function providerText(msg) {
    return msg.backend && msg.backend !== 'hermes' ? backendShort(msg.backend) : (msg.provider || '');
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 150;
  }

  function scrollToBottom(force) {
    if (force || stickToBottom) {
      requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
    }
  }

  function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (kind === 'err' ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3400);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setConn(kind, text) {
    connEl.className = 'conn' + (kind ? ' ' + kind : '');
    connEl.querySelector('span').textContent = text;
  }

  function showFatal(text) {
    fatalText.textContent = text;
    fatalEl.hidden = false;
    sendBtn.disabled = true;
    setConn('bad', '未连接');
  }

  async function api(url, options) {
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ 'X-Smac-Token': state.token }, opts.headers || {});
    if (opts.body && !opts.headers['Content-Type']) { opts.headers['Content-Type'] = 'application/json'; }
    const response = await fetch(url, opts);
    let data = null;
    try { data = await response.json(); } catch { }
    if (!response.ok) {
      throw new Error((data && data.error) || ('请求失败 (' + response.status + ')'));
    }
    return data || {};
  }

  /* ---------------- markdown ---------------- */

  function resolveFileUrl(value) {
    let raw = String(value || '').trim().replace(/^<|>$/g, '');
    if (!raw) { return ''; }
    if (/^(https?:|data:|blob:)/i.test(raw)) { return raw; }
    if (/^file:\/\//i.test(raw)) {
      try { raw = decodeURIComponent(raw.slice(7)); } catch { raw = raw.slice(7); }
      if (/^\/[A-Za-z]:/.test(raw)) { raw = raw.slice(1); }
    }
    const base = baseForPath(raw).replace(/[\\/]+$/, '');
    const winRoot = /^[A-Za-z]:[\\/]/.test(base);
    const absolute = /^[A-Za-z]:[\\/]/.test(raw) || (!winRoot && raw.startsWith('/'));
    if (!absolute) {
      raw = base + '/' + raw.replace(/^[\\/]+/, '');
    }
    return '/api/file?path=' + encodeURIComponent(raw) + '&token=' + encodeURIComponent(state.token);
  }

  function imageTag(alt, url) {
    const src = resolveFileUrl(unescapeBasic(url));
    if (!src) { return ''; }
    return '<img class="inline-img" data-src="' + escapeAttr(src) + '" alt="' +
      escapeAttr(alt || '') + '">';
  }

  const KATEX_MACROS = {
    '\\bm': '\\boldsymbol',
    '\\argmax': '\\operatorname*{arg\\,max}',
    '\\argmin': '\\operatorname*{arg\\,min}',
    '\\diag': '\\operatorname{diag}',
    '\\Tr': '\\operatorname{Tr}',
    '\\tr': '\\operatorname{tr}',
    '\\rank': '\\operatorname{rank}',
    '\\Re': '\\operatorname{Re}',
    '\\Im': '\\operatorname{Im}',
    '\\E': '\\mathbb{E}',
    '\\R': '\\mathbb{R}',
    '\\C': '\\mathbb{C}',
    '\\N': '\\mathbb{N}',
    '\\Z': '\\mathbb{Z}'
  };

  function renderMathHtml(tex, displayMode) {
    const raw = String(tex == null ? '' : tex).trim();
    if (!raw) { return ''; }
    if (window.katex && typeof window.katex.renderToString === 'function') {
      try {
        const rendered = window.katex.renderToString(raw, {
          displayMode: Boolean(displayMode),
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          macros: Object.assign({}, KATEX_MACROS)
        });
        return displayMode
          ? '<div class="math-block">' + rendered + '</div>'
          : '<span class="math-inline">' + rendered + '</span>';
      } catch { }
    }
    return displayMode
      ? '<div class="math-block math-fallback"><code>' + escapeHtml(raw) + '</code></div>'
      : '<code class="math-fallback">' + escapeHtml(raw) + '</code>';
  }

  // Pass 1: stash inline code spans (`...` / ``...``) so `$` inside code like
  // `$HOME` is never seen by the math scanner.
  function extractInlineCode(input, stash) {
    const src = String(input == null ? '' : input);
    const len = src.length;
    let out = '';
    let i = 0;
    while (i < len) {
      if (src[i] === '`') {
        let ticks = 1;
        while (i + ticks < len && src[i + ticks] === '`') { ticks += 1; }
        const close = src.indexOf('`'.repeat(ticks), i + ticks);
        if (close > i + ticks) {
          let code = src.slice(i + ticks, close);
          if (ticks > 1 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) {
            code = code.slice(1, -1);
          }
          out += stash('<code>' + escapeHtml(code) + '</code>');
          i = close + ticks;
          continue;
        }
        out += src.slice(i, i + ticks);
        i += ticks;
        continue;
      }
      out += src[i];
      i += 1;
    }
    return out;
  }

  // Pass 2: extract LaTeX math ($...$, $$...$$, \(...\), \[...\]) BEFORE HTML
  // escaping and Markdown emphasis so underscores/asterisks inside formulas are
  // never mangled.
  function extractCodeAndMath(input, stash) {
    const src = extractInlineCode(input, stash);
    const len = src.length;
    let out = '';
    let i = 0;

    while (i < len) {
      const ch = src[i];

      // 1. Backslash escapes: \$, \(...\), \[...\]
      if (ch === '\\' && i + 1 < len) {
        const next = src[i + 1];
        if (next === '$') {
          out += stash('$');
          i += 2;
          continue;
        }
        if (next === '(' || next === '[') {
          const isDisplay = next === '[';
          const endChar = isDisplay ? ']' : ')';
          let j = i + 2;
          let found = -1;
          while (j < len) {
            if (src[j] === '\\' && j + 1 < len) {
              if (src[j + 1] === endChar) { found = j; break; }
              j += 2;
              continue;
            }
            j += 1;
          }
          if (found > i + 2) {
            const inner = src.slice(i + 2, found);
            out += stash(renderMathHtml(inner, isDisplay));
            i = found + 2;
            continue;
          }
        }
        out += ch;
        i += 1;
        continue;
      }

      // 2. Display $$...$$ or inline $...$
      if (ch === '$') {
        if (src[i + 1] === '$') {
          let j = i + 2;
          let found = -1;
          while (j < len - 1) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '$' && src[j + 1] === '$') { found = j; break; }
            j += 1;
          }
          if (found > i + 2) {
            const inner = src.slice(i + 2, found);
            out += stash(renderMathHtml(inner, true));
            i = found + 2;
            continue;
          }
          out += '$$';
          i += 2;
          continue;
        }

        // Inline $...$: cannot start with whitespace/newline, cannot cross
        // newline or contain stashed tokens, cannot end with whitespace, and
        // closing $ cannot be followed by a digit (avoids $5-$10).
        const first = src[i + 1];
        if (first && !/\s/.test(first) && first !== '\u0000') {
          let j = i + 1;
          let found = -1;
          while (j < len) {
            if (src[j] === '\n' || src[j] === '\u0000') { break; }
            if (src[j] === '\\' && j + 1 < len) { j += 2; continue; }
            if (src[j] === '$') {
              if (src[j + 1] === '$') { break; }
              const prev = src[j - 1];
              const after = src[j + 1] || '';
              if (j > i + 1 && !/\s/.test(prev) && !/^\d$/.test(after)) {
                found = j;
              }
              // An unescaped $ inside LaTeX math is illegal; either this closes
              // the formula or the opening $ was a literal currency sign.
              break;
            }
            j += 1;
          }
          if (found > i + 1) {
            const inner = src.slice(i + 1, found);
            out += stash(renderMathHtml(inner, false));
            i = found + 1;
            continue;
          }
        }
        out += '$';
        i += 1;
        continue;
      }

      out += ch;
      i += 1;
    }
    return out;
  }

  function renderInline(raw) {
    const tokens = [];
    const stash = html => {
      const key = '\u0000T' + tokens.length + '\u0000';
      tokens.push(html);
      return key;
    };
    let text = String(raw == null ? '' : raw);
    text = text.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
      (match, alt, url) => stash(imageTag(alt, url)));
    text = extractCodeAndMath(text, stash);
    text = escapeHtml(text);
    text = text.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (match, label, url) => {
      const href = unescapeBasic(url);
      if (!/^(https?:|mailto:)/i.test(href)) { return label; }
      return '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/\u0000T(\d+)\u0000/g, (match, index) => tokens[Number(index)] || '');
    return text;
  }

  function splitTableRow(row) {
    const trimmed = String(row || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cur = '';
    let inCode = false;
    let inMath = false;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === '\\' && i + 1 < trimmed.length) {
        cur += ch + trimmed[i + 1];
        i += 1;
        continue;
      }
      if (ch === '`' && !inMath) { inCode = !inCode; cur += ch; continue; }
      if (ch === '$' && !inCode) {
        if (trimmed[i + 1] === '$') { cur += '$$'; i += 1; }
        else { cur += ch; }
        inMath = !inMath;
        continue;
      }
      if (ch === '|' && !inCode && !inMath) {
        cells.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function renderBlocks(text) {
    const lines = String(text).split('\n');
    let html = '';
    let index = 0;
    let paragraph = [];
    let listType = '';
    let listStart = 1;
    let listItems = [];

    const flushParagraph = () => {
      if (!paragraph.length) { return; }
      html += '<p>' + renderInline(paragraph.join('\n')).replace(/\n/g, '<br>') + '</p>';
      paragraph = [];
    };
    const flushList = () => {
      if (!listType) { return; }
      const openTag = listType === 'ol' && listStart > 1 ? '<ol start="' + listStart + '">' : '<' + listType + '>';
      html += openTag + listItems.map(item => '<li>' + renderInline(item) + '</li>').join('') + '</' + listType + '>';
      listType = '';
      listStart = 1;
      listItems = [];
    };
    const closeAll = () => { flushParagraph(); flushList(); };

    const splitRow = splitTableRow;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { closeAll(); index += 1; continue; }

      if (/^\s*```/.test(line)) {
        closeAll();
        html += '<pre><code>' + escapeHtml(line) + '</code></pre>';
        index += 1;
        continue;
      }

      // Standalone single-line or multi-line display math: $$...$$
      const singleDollarBlock = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (singleDollarBlock) {
        closeAll();
        html += renderMathHtml(singleDollarBlock[1], true);
        index += 1;
        continue;
      }
      const openDollarBlock = /^\s*\$\$(.*)$/.exec(line);
      if (openDollarBlock && !openDollarBlock[1].includes('$$')) {
        let end = index + 1;
        while (end < lines.length && !/\$\$/.test(lines[end])) { end += 1; }
        if (end < lines.length) {
          closeAll();
          const body = [openDollarBlock[1]];
          for (let k = index + 1; k < end; k += 1) { body.push(lines[k]); }
          body.push(lines[end].replace(/\$\$.*$/, ''));
          html += renderMathHtml(body.join('\n'), true);
          index = end + 1;
          continue;
        }
      }

      // Standalone single-line or multi-line display math: \[...\]
      const singleBracketBlock = /^\s*\\\[(.+)\\\]\s*$/.exec(line);
      if (singleBracketBlock) {
        closeAll();
        html += renderMathHtml(singleBracketBlock[1], true);
        index += 1;
        continue;
      }
      const openBracketBlock = /^\s*\\\[(.*)$/.exec(line);
      if (openBracketBlock && !openBracketBlock[1].includes('\\]')) {
        let end = index + 1;
        while (end < lines.length && !/\\\]/.test(lines[end])) { end += 1; }
        if (end < lines.length) {
          closeAll();
          const body = [openBracketBlock[1]];
          for (let k = index + 1; k < end; k += 1) { body.push(lines[k]); }
          body.push(lines[end].replace(/\\\].*$/, ''));
          html += renderMathHtml(body.join('\n'), true);
          index = end + 1;
          continue;
        }
      }

      // Bare LaTeX display environments: \begin{equation|align|aligned|gather|multline|cases}
      const envOpen = /^\s*\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?|eqnarray\*?|cases)\}/.exec(line);
      if (envOpen) {
        const envName = envOpen[1];
        const envEndRe = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}');
        let end = index;
        while (end < lines.length && !envEndRe.test(lines[end])) { end += 1; }
        if (end < lines.length) {
          closeAll();
          html += renderMathHtml(lines.slice(index, end + 1).join('\n'), true);
          index = end + 1;
          continue;
        }
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeAll();
        const level = heading[1].length;
        html += '<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>';
        index += 1;
        continue;
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        closeAll();
        html += '<hr>';
        index += 1;
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length
        && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
        closeAll();
        const head = splitRow(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(splitRow(lines[index]));
          index += 1;
        }
        html += '<table><thead><tr>' + head.map(cell => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead><tbody>';
        rows.forEach(cells => {
          html += '<tr>' + head.map((cell, column) => '<td>' + renderInline(cells[column] || '') + '</td>').join('') + '</tr>';
        });
        html += '</tbody></table>';
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        closeAll();
        const buffer = [];
        while (index < lines.length) {
          const quote = /^\s*>\s?(.*)$/.exec(lines[index]);
          if (!quote) { break; }
          buffer.push(quote[1]);
          index += 1;
        }
        html += '<blockquote>' + renderInline(buffer.join('\n')).replace(/\n/g, '<br>') + '</blockquote>';
        continue;
      }

      const item = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        flushParagraph();
        const isOrdered = /\d+\./.test(item[2]);
        const type = isOrdered ? 'ol' : 'ul';
        if (listType && listType !== type) { flushList(); }
        if (!listType) {
          listType = type;
          listStart = isOrdered ? (parseInt(item[2], 10) || 1) : 1;
        }
        listItems.push(item[3]);
        index += 1;
        continue;
      }

      flushList();
      paragraph.push(line);
      index += 1;
    }
    closeAll();
    return html;
  }

  function renderMarkdown(source) {
    const text = String(source == null ? '' : source);
    if (!text) { return ''; }
    let html = '';
    let last = 0;
    let match;
    const fence = /```([A-Za-z0-9_+.-]*)[^\n]*\n?([\s\S]*?)```/g;
    while ((match = fence.exec(text))) {
      html += renderBlocks(text.slice(last, match.index));
      const language = match[1] ? ' class="language-' + escapeAttr(match[1]) + '"' : '';
      html += '<pre><code' + language + '>' + escapeHtml(match[2].replace(/\s+$/, '')) + '</code></pre>';
      last = fence.lastIndex;
    }
    html += renderBlocks(text.slice(last));
    return html;
  }

  function hydrateImages(container) {
    container.querySelectorAll('img.inline-img[data-src]').forEach(img => {
      const src = img.getAttribute('data-src');
      img.removeAttribute('data-src');
      img.addEventListener('error', () => { img.classList.add('broken'); }, { once: true });
      img.addEventListener('click', () => openLightbox(src));
      img.src = src;
    });
  }

  function extractImagePaths(text) {
    const cleaned = String(text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    const pattern = /(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+|(?:[\w.\-\u4e00-\u9fa5]+\/)+[\w.\-\u4e00-\u9fa5]+)\.(?:png|jpe?g|gif|webp|bmp|svg)/gi;
    const found = [];
    let match;
    while ((match = pattern.exec(cleaned)) && found.length < 12) {
      const value = match[0].replace(/[),.;:!?]+$/, '');
      if (!found.includes(value)) { found.push(value); }
    }
    return found;
  }

  function extractFilePaths(text) {
    const cleaned = String(text || '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
    const pattern = /(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/][^\s"'<>|]+|\/[^\s"'<>|]+|(?:[\w.\-\u4e00-\u9fa5]+\/)+[\w.\-\u4e00-\u9fa5]+)\.(?:md|markdown|txt|json|csv|html|htm|xml|ya?ml|toml|ini|js|mjs|cjs|ts|tsx|jsx|css|py|java|c|h|cpp|hpp|cs|go|rs|sh|bat|ps1|log)(?![\w])/gi;
    const found = [];
    let match;
    while ((match = pattern.exec(cleaned)) && found.length < 8) {
      const value = match[0].replace(/[),.;:!?]+$/, '');
      if (value && !found.includes(value)) { found.push(value); }
    }
    return found;
  }

  /* ---------------- message rendering ---------------- */

  function clearEmpty() {
    const empty = messagesEl.querySelector('.empty');
    if (empty) { empty.remove(); }
  }

  function renderEmpty() {
    messagesEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    const device = state.device ? escapeHtml(state.device) : '远端设备';
    const source = state.backend === 'dsh' ? 'DeepSeek Harness'
      : state.backend === 'codex' ? 'ChatGPT（Codex）'
        : state.backend === 'claude' ? 'Claude Code'
          : state.backend === 'agy' ? 'Gemini · Antigravity'
            : state.backend === 'opencode' ? 'OpenCode'
              : 'Hermes';
    wrap.innerHTML =
      '<div class="empty-logo">◈</div>' +
      '<h1>远端 ' + escapeHtml(backendLabel(state.backend)) + '</h1>' +
      '<p>直接对话、读写 <b>' + escapeHtml(workdirBase() || '所选同步目录') + '</b> 下的文件。' +
      '由 ' + device + ' 上已登录的 ' + escapeHtml(source) +
      ' 执行，写入范围只限同步文件夹。</p>' +
      '<div class="chips">' +
      '<button type="button" data-prompt="列出当前目录的文件，简要说明每个文件是什么。">列出目录内容</button>' +
      '<button type="button" data-prompt="阅读当前目录里的笔记，提炼主要内容并整理成条目。">阅读并总结笔记</button>' +
      '<button type="button" data-prompt="找出当前目录里所有图片，按文件名列成清单。">查找目录中的图片</button>' +
      '</div>' +
      '<div class="empty-note">支持直接拖入、粘贴或点击「＋ 文件 / 图片」上传主机任意文件（PDF、文档、表格、代码、压缩包、图片等，自动存入工作区 <code>_smac_uploads/</code> 供模型直接分析）。</div>';
    messagesEl.append(wrap);
    wrap.querySelectorAll('button[data-prompt]').forEach(button => {
      button.addEventListener('click', () => {
        inputEl.value = button.getAttribute('data-prompt') || '';
        autoGrow();
        inputEl.focus();
      });
    });
  }

  function renderMessage(msg) {
    const el = document.createElement('div');
    el.className = 'msg ' + (msg.role === 'user' ? 'user' : 'assistant');
    if (msg.turnId) { el.dataset.turn = msg.turnId; }
    msg._el = el;

    if (msg.role === 'user') {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (msg.text) {
        const text = document.createElement('div');
        text.className = 'msg-text';
        text.textContent = msg.text;
        bubble.append(text);
      }
      if (msg.image) {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.alt = '附件图片';
        img.src = msg.image;
        img.addEventListener('click', () => openLightbox(msg.image));
        img.addEventListener('error', () => {
          img.hidden = true;
          const note = document.createElement('div');
          note.className = 'image-note';
          note.textContent = '（图片附件已过期，远端会在 7 天后清理上传图片）';
          bubble.append(note);
        }, { once: true });
        bubble.append(img);
      }
      if (msg.imageHidden) {
        const note = document.createElement('div');
        note.className = 'image-note';
        note.textContent = '（历史图片过大，未保留预览）';
        bubble.append(note);
      }
      if (Array.isArray(msg.files) && msg.files.length) {
        const list = document.createElement('div');
        list.className = 'msg-files';
        msg.files.forEach(file => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'msg-file-pill';
          const ext = (file.name && file.name.includes('.') ? file.name.split('.').pop() : 'FILE').toUpperCase().slice(0, 6);
          btn.innerHTML = '<span class="ext">' + escapeHtml(ext) + '</span><span>' + escapeHtml(file.name || file.relPath) + '</span>';
          btn.title = '已上传至工作区: ' + (file.relPath || file.name) + '（点击预览）';
          btn.addEventListener('click', () => {
            const target = file.path || file.relPath;
            if (target) openPreview(target, file.name || basename(target));
          });
          list.append(btn);
        });
        bubble.append(list);
      }
      if (!msg.text && !msg.image && !msg.imageHidden && !(Array.isArray(msg.files) && msg.files.length)) {
        const text = document.createElement('div');
        text.className = 'msg-text';
        text.textContent = msg.prompt || '';
        bubble.append(text);
      }
      el.append(bubble);
      return el;
    }

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '◈';
    const body = document.createElement('div');
    body.className = 'body';

    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = backendShort(msg.backend || state.backend);
    const model = document.createElement('span');
    model.className = 'model';
    const stateEl = document.createElement('span');
    stateEl.className = 'state';
    who.append(name, model, stateEl);

    const activity = document.createElement('details');
    activity.className = 'activity';
    activity.hidden = true;
    const summary = document.createElement('summary');
    const summaryLabel = document.createElement('span');
    summaryLabel.textContent = '执行过程';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.hidden = true;
    const spinner = document.createElement('span');
    spinner.className = 'spin';
    spinner.hidden = true;
    summary.append(summaryLabel, badge, spinner);
    const activityBody = document.createElement('div');
    activityBody.className = 'activity-body';
    activity.append(summary, activityBody);

    const answer = document.createElement('div');
    answer.className = 'answer';
    const gallery = document.createElement('div');
    gallery.className = 'gallery';
    gallery.hidden = true;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const error = document.createElement('div');
    error.className = 'error-box';
    error.hidden = true;

    body.append(who, activity, answer, gallery, meta, error);
    el.append(avatar, body);

    msg._answerEl = answer;
    msg._activityEl = activity;
    msg._activityBody = activityBody;
    msg._summaryLabel = summaryLabel;
    msg._badge = badge;
    msg._spin = spinner;
    msg._gallery = gallery;
    msg._meta = meta;
    msg._error = error;
    msg._state = stateEl;
    msg._model = model;
    return el;
  }

  function renderAnswerNow(msg) {
    if (!msg._answerEl) { return; }
    const stick = nearBottom();
    if (!msg.text) {
      msg._answerEl.classList.remove('streaming-cursor');
      if (msg.status === 'running') {
        msg._answerEl.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
      } else if (msg.status === 'interrupted') {
        msg._answerEl.innerHTML = '<div class="notice">已打断，这一轮没有生成回复</div>';
      } else if (msg.status === 'cancelled') {
        msg._answerEl.innerHTML = '<div class="notice">已停止，这一轮没有生成回复</div>';
      } else {
        msg._answerEl.innerHTML = '';
      }
    } else {
      msg._answerEl.innerHTML = renderMarkdown(msg.text);
      hydrateImages(msg._answerEl);
      msg._answerEl.classList.toggle('streaming-cursor', msg.status === 'running');
    }
    if (stick) { scrollToBottom(true); }
  }

  function scheduleAnswer(msg, immediate) {
    if (immediate) {
      renderAnswerNow(msg);
      return;
    }
    if (msg._answerTimer) { return; }
    msg._answerTimer = setTimeout(() => {
      msg._answerTimer = null;
      renderAnswerNow(msg);
    }, 70);
  }

  window.__smacRerenderMath = function () {
    state.messages.forEach(msg => {
      if (msg && msg.role === 'assistant' && msg.text) { renderAnswerNow(msg); }
    });
  };

  function renderActivity(msg) {
    if (!msg._activityEl) { return; }
    const text = String(msg.activity || '').replace(/\s+$/, '');
    if (!text) {
      msg._activityEl.hidden = true;
      msg._spin.hidden = msg.status !== 'running';
      return;
    }
    msg._activityEl.hidden = false;
    msg._spin.hidden = msg.status !== 'running';
    if (msg._renderedActivity === text && msg._renderedActivityStatus === msg.status) { return; }
    msg._renderedActivity = text;
    msg._renderedActivityStatus = msg.status;

    const allLines = text.split('\n');
    const lines = allLines.slice(-420);
    let tools = 0;
    const fragment = document.createDocumentFragment();
    if (lines.length < allLines.length) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = '… 省略前 ' + (allLines.length - lines.length) + ' 行';
      fragment.append(more);
    }
    lines.forEach(line => {
      const div = document.createElement('div');
      if (/^\s*┊/.test(line)) {
        tools += 1;
        div.className = 'tool-line';
        div.textContent = line.replace(/^\s*┊\s?/, '');
      } else if (/^\s*@@/.test(line)) {
        div.className = 'diff-hunk';
        div.textContent = line;
      } else if (/^\s*\+/.test(line) && !/^\s*\+\+\+/.test(line)) {
        div.className = 'diff-add';
        div.textContent = line;
      } else if (/^\s*-/.test(line) && !/^\s*---/.test(line)) {
        div.className = 'diff-del';
        div.textContent = line;
      } else {
        div.className = 'log-line';
        div.textContent = line;
      }
      fragment.append(div);
    });
    msg._activityBody.replaceChildren(fragment);
    if (tools > 0) {
      msg._badge.hidden = false;
      msg._badge.textContent = tools + ' 个工具';
    } else {
      msg._badge.hidden = true;
    }
    if (msg.status === 'running') {
      msg._activityEl.open = true;
      const bodyStick = msg._activityBody.scrollHeight - msg._activityBody.scrollTop - msg._activityBody.clientHeight < 60;
      requestAnimationFrame(() => {
        if (bodyStick) { msg._activityBody.scrollTop = msg._activityBody.scrollHeight; }
      });
    }
  }

  function scheduleActivity(msg) {
    if (msg._activityTimer) { return; }
    msg._activityTimer = setTimeout(() => {
      msg._activityTimer = null;
      renderActivity(msg);
    }, 90);
  }

  function renderMeta(msg) {
    if (!msg._meta || !msg._state) { return; }
    msg._meta.replaceChildren();
    if (msg.text) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-btn';
      copyBtn.title = '复制回复内容';
      copyBtn.setAttribute('aria-label', '复制回复内容');
      const copySvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.8"/><path d="M10.8 5.2V3.8A1.8 1.8 0 0 0 9 2H3.8A1.8 1.8 0 0 0 2 3.8V9a1.8 1.8 0 0 0 1.8 1.8h1.4"/></svg>';
      const checkSvg = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.4 6.5 11.7 13 4.6"/></svg>';
      copyBtn.innerHTML = copySvg;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.text);
          copyBtn.innerHTML = checkSvg;
          copyBtn.style.color = 'var(--green)';
          setTimeout(() => { copyBtn.innerHTML = copySvg; copyBtn.style.color = ''; }, 1400);
        } catch {
          toast('复制失败', 'err');
        }
      });
      msg._meta.append(copyBtn);
    }
    const provider = providerText(msg);
    const parts = [];
    if (msg.model) {
      parts.push(provider ? provider + ' · ' + msg.model : msg.model);
    } else if (provider) {
      parts.push(provider);
    }
    if (msg.reasoning) { parts.push('思考 ' + (REASONING_LABELS[msg.reasoning] || msg.reasoning)); }
    if (msg.fast) { parts.push('快速'); }
    if (msg.workdir) { parts.push(msg.workdir); }
    if (msg.durationMs != null) { parts.push(formatDuration(msg.durationMs)); }
    if (msg.usage && (msg.usage.input || msg.usage.output)) {
      parts.push('tokens ' + msg.usage.input + '/' + msg.usage.output);
    }
    if (msg.status === 'cancelled') { parts.push('已停止'); }
    else if (msg.status === 'interrupted') { parts.push('已打断'); }
    else if (msg.status === 'error') { parts.push('出错'); }
    parts.forEach((part, index) => {
      if (index > 0) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        msg._meta.append(dot);
      }
      const span = document.createElement('span');
      span.textContent = part;
      msg._meta.append(span);
    });

    msg._model.textContent = msg.model
      ? (provider ? provider + ' · ' + msg.model : msg.model)
      : (provider || '');
    msg._model.title = msg._model.textContent;
    msg._state.textContent = msg.status === 'running' ? '执行中'
      : msg.status === 'cancelled' ? '已停止'
        : msg.status === 'interrupted' ? '已打断'
          : msg.status === 'error' ? '出错' : '';
  }

  function renderGallery(msg) {
    if (!msg._gallery) { return; }
    const paths = Array.isArray(msg.images) && msg.images.length
      ? msg.images.slice()
      : extractImagePaths(msg.text || '');
    const files = extractFilePaths(String(msg.activity || '') + '\n' + String(msg.text || ''));
    msg._gallery.replaceChildren();
    msg._gallery.hidden = paths.length === 0 && files.length === 0;
    paths.forEach(filePath => {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.alt = basename(filePath);
      img.src = resolveFileUrl(filePath);
      img.addEventListener('error', () => { figure.classList.add('broken'); }, { once: true });
      const caption = document.createElement('figcaption');
      caption.textContent = basename(filePath);
      caption.title = '点击预览 · ' + filePath;
      figure.append(img, caption);
      figure.addEventListener('click', () => {
        if (!figure.classList.contains('broken')) { openPreview(filePath, basename(filePath)); }
      });
      msg._gallery.append(figure);
    });
    files.forEach(filePath => {
      if (paths.includes(filePath)) { return; }
      const ext = previewExt(filePath);
      const figure = document.createElement('figure');
      figure.className = 'file-card';
      const top = document.createElement('div');
      top.className = 'file-top';
      const extEl = document.createElement('span');
      extEl.className = 'file-ext';
      extEl.textContent = ext ? ext.toUpperCase() : 'FILE';
      const name = document.createElement('span');
      name.textContent = basename(filePath);
      name.title = filePath;
      name.style.maxWidth = '100%';
      name.style.overflow = 'hidden';
      name.style.textOverflow = 'ellipsis';
      name.style.whiteSpace = 'nowrap';
      top.append(extEl, name);
      const caption = document.createElement('figcaption');
      caption.className = 'file-actions';
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.textContent = '预览';
      previewBtn.addEventListener('click', () => openPreview(filePath, basename(filePath)));
      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.textContent = '下载';
      downloadBtn.addEventListener('click', () => { window.open(fileUrl(joinWorkdir(filePath), true), '_blank', 'noopener'); });
      caption.append(previewBtn, downloadBtn);
      figure.append(top, caption);
      msg._gallery.append(figure);
    });
  }

  function renderError(msg) {
    if (!msg._error) { return; }
    if (msg.error && msg.status === 'error') {
      msg._error.textContent = msg.error;
      msg._error.hidden = false;
    } else {
      msg._error.hidden = true;
      msg._error.textContent = '';
    }
  }

  function addMessage(msg) {
    clearEmpty();
    state.messages.push(msg);
    renderMessage(msg);
    messagesEl.append(msg._el);
    if (msg.role === 'assistant') {
      renderAnswerNow(msg);
      renderActivity(msg);
      renderMeta(msg);
      renderError(msg);
      renderGallery(msg);
    }
    scrollToBottom(true);
    updateChatTitle();
    saveHistory();
    return msg;
  }

  function ensureAssistant(turnId) {
    let msg = state.messages.find(item => item.role === 'assistant' && item.turnId === turnId);
    if (!msg) {
      msg = {
        role: 'assistant',
        turnId,
        text: '',
        activity: '',
        status: 'running',
        error: '',
        backend: state.backend,
        provider: state.provider,
        model: state.model,
        workdir: state.workdir,
        reasoning: state.reasoning,
        fast: state.fast,
        images: [],
        sessionName: state.sessionName,
        usage: null,
        at: Date.now()
      };
      addMessage(msg);
    }
    if (state.currentTurnId !== turnId) {
      state.currentTurnId = turnId;
    }
    return msg;
  }

  function finalizeTurn(turn) {
    if (!turn) { return; }
    if (turn.id === state.ignoredTurnId) { return; }
    if (turn.sessionName && turn.sessionName !== state.sessionName) {
      state.ignoredTurnId = turn.id;
      return;
    }
    const msg = ensureAssistant(turn.id);
    if (turn.answer) { msg.text = turn.answer; }
    if (turn.activity) { msg.activity = turn.activity; }
    msg.status = turn.status || 'done';
    msg.backend = turn.backend || msg.backend;
    msg.provider = turn.provider || msg.provider;
    msg.model = turn.model || msg.model;
    msg.sessionName = turn.sessionName || msg.sessionName;
    msg.workdir = turn.workdir || msg.workdir || '';
    msg.reasoning = turn.reasoning || '';
    msg.fast = Boolean(turn.fast);
    if (Array.isArray(turn.images)) { msg.images = turn.images.slice(0, 12); }
    msg.usage = turn.usage || msg.usage || null;
    msg.durationMs = turn.durationMs;
    msg.endedAt = turn.endedAt;
    msg.error = turn.status === 'error' ? (turn.error || '执行失败') : '';
    if (!msg.text && turn.status === 'error' && !msg.error) { msg.error = '执行失败'; }

    clearTimeout(msg._answerTimer);
    clearTimeout(msg._activityTimer);
    msg._answerTimer = null;
    msg._activityTimer = null;
    renderAnswerNow(msg);
    renderActivity(msg);
    renderMeta(msg);
    renderGallery(msg);
    renderError(msg);
    if (msg._activityEl) { msg._activityEl.open = false; }
    // A late "done" for an interrupted turn must not clear the state of the
    // newly started turn in the same session.
    if (state.currentTurnId === turn.id) { setRunning(false); }
    stickToBottom = true;
    scrollToBottom(true);
    saveHistory();
    refreshSessions(200);
  }

  function handleState(turn) {
    if (!turn) { return; }
    if (turn.sessionName && turn.sessionName !== state.sessionName) {
      state.ignoredTurnId = turn.id;
      return;
    }
    if (turn.id === state.ignoredTurnId) { return; }

    if (turn.id !== state.currentTurnId) {
      state.currentTurnId = turn.id;
      const existingUser = state.messages.find(item => item.role === 'user' && item.turnId === turn.id);
      if (!existingUser) {
        const pending = state.messages.filter(item => item.role === 'user' && !item.turnId).reverse();
        let match = pending.find(item => (item.prompt || item.text) === turn.prompt);
        if (!match && turn.prompt) {
          match = addMessage({
            role: 'user',
            text: turn.prompt,
            prompt: turn.prompt,
            turnId: turn.id,
            at: Date.now()
          });
        }
        if (match) { match.turnId = turn.id; }
      }
    }

    const msg = ensureAssistant(turn.id);
    msg.backend = turn.backend || msg.backend;
    msg.provider = turn.provider || msg.provider;
    msg.model = turn.model || msg.model;
    msg.sessionName = turn.sessionName || msg.sessionName;
    msg.workdir = turn.workdir || msg.workdir || '';
    msg.reasoning = turn.reasoning || msg.reasoning || '';
    msg.fast = Boolean(turn.fast);
    if (Array.isArray(turn.images) && turn.images.length) { msg.images = turn.images.slice(0, 12); }
    msg.usage = turn.usage || msg.usage || null;
    if (turn.answer) { msg.text = turn.answer; }
    if (turn.activity) { msg.activity = turn.activity; }

    if (turn.status === 'running') {
      msg.status = 'running';
      renderAnswerNow(msg);
      renderActivity(msg);
      renderMeta(msg);
      setRunning(true);
    } else {
      finalizeTurn(turn);
    }
  }

  function handleEvent(event) {
    if (event.type === 'state') {
      if (event.turn) { handleState(event.turn); }
      // 快照里的 seq 是当前最新序号；新回合 eventSeq 会从 0 重新计数。
      state.lastSeq = Number(event.seq) || 0;
      return;
    }
    if (event.seq && event.seq <= state.lastSeq) { return; }
    state.lastSeq = Number(event.seq) || state.lastSeq;
    const turnId = event.turnId;
    if (!turnId || turnId === state.ignoredTurnId) { return; }
    if (event.type === 'activity') {
      const msg = ensureAssistant(turnId);
      msg.activity += event.text || '';
      scheduleActivity(msg);
    } else if (event.type === 'answer') {
      const msg = ensureAssistant(turnId);
      msg.text += event.text || '';
      scheduleAnswer(msg);
      if (!state.running) { setRunning(true); }
    } else if (event.type === 'done') {
      finalizeTurn(event.turn);
    }
  }

  /* ---------------- running / status ---------------- */

  function runningLabel() {
    return backendLabel(state.backend) + ' 正在执行…';
  }

  function updateComposer() {
    sendBtn.disabled = !state.ready || !state.root || state.sending;
    const label = state.sending ? '正在发送…' : (state.running ? '打断并发送 (Enter)' : '发送 (Enter)');
    sendBtn.title = label;
    sendBtn.setAttribute('aria-label', label);
    stopBtn.hidden = !state.running;
    composerEl.classList.toggle('running', state.running);
    inputEl.placeholder = state.running
      ? '正在执行…继续输入可打断并插入新消息'
      : '向 ' + backendLabel(state.backend) + ' 提问，可拖入或粘贴文件 / 图片…';
    if (attachBtn) {
      attachBtn.disabled = false;
      attachBtn.title = '上传主机任意文件或图片到当前工作区';
    }
    if (state.attachments.length) { renderAttachments(); }
  }

  function setRunning(value) {
    state.running = Boolean(value);
    stopBtn.disabled = false;
    updateComposer();
    if (state.running) {
      setStatus(runningLabel() + '（可继续输入打断并插入）');
    } else if (String(statusEl.textContent || '').indexOf('正在执行') >= 0
      || statusEl.textContent === '正在停止…') {
      setStatus('');
    }
  }

  /* ---------------- sse ---------------- */

  function openEvents() {
    if (state.es) { state.es.close(); }
    const source = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
    state.es = source;
    source.onopen = () => { setConn('ok', '已连接'); };
    source.onerror = () => { setConn('bad', '重连中'); };
    source.onmessage = event => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { return; }
      handleEvent(data);
    };
  }

  /* ---------------- history / prefs ---------------- */

  function loadSaved() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) { return null; }
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.messages)) { return null; }
      return data;
    } catch {
      return null;
    }
  }

  function saveHistory() {
    if (!state.ready) { return; }
    const messages = state.messages.map(msg => ({
      role: msg.role,
      text: msg.text || '',
      prompt: msg.prompt || '',
      image: msg.image && msg.image.length <= MAX_IMAGE_HISTORY ? msg.image : '',
      imageHidden: Boolean(msg.image && msg.image.length > MAX_IMAGE_HISTORY),
      files: Array.isArray(msg.files) ? msg.files.slice(0, 12) : [],
      at: msg.at || 0,
      turnId: msg.turnId || '',
      activity: msg.activity ? msg.activity.slice(-16000) : '',
      status: msg.status || '',
      error: msg.error || '',
      backend: msg.backend || '',
      provider: msg.provider || '',
      model: msg.model || '',
      workdir: msg.workdir || '',
      reasoning: msg.reasoning || '',
      fast: Boolean(msg.fast),
      images: Array.isArray(msg.images) ? msg.images.slice(0, 12) : [],
      sessionName: msg.sessionName || '',
      usage: msg.usage || null,
      durationMs: msg.durationMs == null ? null : msg.durationMs,
      endedAt: msg.endedAt || ''
    })).slice(-80);
    const payload = {
      sessionName: state.sessionName,
      root: state.root,
      workdir: state.workdir,
      rootWorkdirs: state.rootWorkdirs,
      backend: state.backend,
      provider: state.provider,
      model: state.model,
      reasoning: state.reasoning,
      fast: state.fast,
      messages,
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      try {
        const light = JSON.parse(JSON.stringify(payload));
        light.messages = light.messages.map(msg => Object.assign({}, msg, { image: '', activity: '' }));
        localStorage.setItem(LS_KEY, JSON.stringify(light));
      } catch { }
    }
  }

  function renderAll() {
    messagesEl.innerHTML = '';
    if (!state.messages.length) {
      renderEmpty();
      return;
    }
    state.messages.forEach(msg => {
      renderMessage(msg);
      messagesEl.append(msg._el);
      if (msg.role === 'assistant') {
        renderAnswerNow(msg);
        renderActivity(msg);
        renderMeta(msg);
        renderError(msg);
        renderGallery(msg);
      }
    });
    scrollToBottom(true);
  }

  /* ---------------- conversation history ---------------- */

  function fromHistoryMessage(msg) {
    const out = {
      role: msg.role === 'user' ? 'user' : 'assistant',
      text: msg.text || '',
      prompt: msg.prompt || msg.text || '',
      at: typeof msg.at === 'number' ? msg.at : (Date.parse(msg.at) || Date.now()),
      turnId: msg.turnId || '',
      activity: msg.activity || '',
      status: msg.status || 'done',
      error: msg.error || '',
      backend: msg.backend || '',
      provider: msg.provider || '',
      model: msg.model || '',
      workdir: msg.workdir || '',
      reasoning: msg.reasoning || '',
      fast: Boolean(msg.fast),
      images: Array.isArray(msg.images) ? msg.images.slice(0, 12) : [],
      sessionName: msg.sessionName || '',
      usage: msg.usage || null,
      durationMs: msg.durationMs == null ? null : msg.durationMs,
      endedAt: msg.endedAt || ''
    };
    if (out.role === 'user' && msg.image) {
      out.image = fileUrl(msg.image);
      out.imagePath = msg.image;
    }
    return out;
  }

  function applyRecord(record) {
    if (!record) { return; }
    state.ignoredTurnId = state.currentTurnId;
    state.currentTurnId = '';
    state.lastSeq = 0;
    state.sessionName = record.sessionName;
    state.messages = (record.messages || []).map(fromHistoryMessage);

    if (record.root && Array.from(rootSelect.options).some(option => option.value === record.root)) {
      state.root = record.root;
      rootSelect.value = record.root;
    }
    if (!state.root) { state.root = rootSelect.value || ''; }
    applyWorkdir(record.workdir || '');

    const hasProvider = record.provider
      && Array.from(providerSelect.options).some(option => option.value === record.provider);
    if (hasProvider) {
      state.provider = record.provider;
      providerSelect.value = record.provider;
      populateModels(record.provider, record.model || '');
    } else if (record.model
      && Array.from(modelSelect.options).some(option => option.value === record.model)) {
      state.model = record.model;
      modelSelect.value = record.model;
      populateReasoning(record.reasoning || '');
    }
    if (record.reasoning && Array.from(reasoningSelect.options).some(option => option.value === record.reasoning)) {
      state.reasoning = record.reasoning;
      reasoningSelect.value = record.reasoning;
    }
    if (record.fast && !fastField.hidden) {
      state.fast = true;
      fastToggle.checked = true;
    }
    updateWorkdirLabel();
    setStatus('');
  }

  async function switchBackend(next) {
    if (!next || next === state.backend) { return; }
    backendSelect.disabled = true;
    try {
      const result = await api('/api/backend', {
        method: 'POST',
        body: JSON.stringify({ backend: next })
      });
      const info = await api('/api/info');
      const models = result.models || await api('/api/models');
      state.saved = null;
      applyInfo(info, models);
      refreshSessions(0);
    } finally {
      backendSelect.disabled = false;
    }
  }

  async function openSession(name) {
    if (!name || name === state.sessionName) {
      if (window.innerWidth <= 900) { closeMobileSidebar(); }
      return;
    }
    if (state.running) { toast('请先停止当前任务，再切换历史对话'); return; }
    if (state.sending) { toast('正在发送，请稍候'); return; }
    const summary = state.sessions.find(item => item.sessionName === name);
    let session = null;
    try {
      const data = await api('/api/session?name=' + encodeURIComponent(name));
      session = data.session;
    } catch (error) {
      toast(error.message || '读取历史对话失败', 'err');
      return;
    }
    if (!session) { return; }
    if (session.backend && session.backend !== state.backend) {
      try { await switchBackend(session.backend); }
      catch (error) { toast(error.message || '切换后端失败', 'err'); return; }
    }
    applyRecord(session);
    updateSession();
    renderAll();
    saveHistory();
    updateComposer();
    renderSessions();
    if (summary && summary.running) {
      try {
        const info = await api('/api/info');
        if (info.busy && info.turn && info.turn.sessionName === state.sessionName) {
          handleState(info.turn);
        }
      } catch { }
    }
    if (window.innerWidth <= 900) { closeMobileSidebar(); }
    inputEl.focus();
  }

  function updateChatTitle() {
    if (!chatTitleEl) { return; }
    const active = state.sessions.find(item => item.sessionName === state.sessionName);
    let title = active && active.title ? String(active.title).trim() : '';
    if (!title) {
      const firstUser = state.messages.find(msg => msg && msg.role === 'user' && (msg.text || msg.prompt));
      if (firstUser) {
        title = String(firstUser.text || firstUser.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      }
    }
    chatTitleEl.textContent = title || '新对话';
    chatTitleEl.title = title || '新对话';
  }

  function closeMobileSidebar() {
    if (sidebarEl) { sidebarEl.classList.remove('open'); }
    if (sidebarScrimEl) { sidebarScrimEl.hidden = true; }
  }

  function setSidebarCollapsed(collapsed) {
    const next = Boolean(collapsed);
    closeMobileSidebar();
    if (appRootEl) { appRootEl.classList.toggle('sidebar-collapsed', next); }
    try { localStorage.setItem(LS_SIDEBAR_KEY, next ? '1' : '0'); } catch { }
  }

  function toggleSidebar() {
    if (window.innerWidth <= 900) {
      const open = !sidebarEl.classList.contains('open');
      sidebarEl.classList.toggle('open', open);
      if (sidebarScrimEl) { sidebarScrimEl.hidden = !open; }
      return;
    }
    const currentlyCollapsed = Boolean(appRootEl && appRootEl.classList.contains('sidebar-collapsed'));
    setSidebarCollapsed(!currentlyCollapsed);
  }

  function renderSessions() {
    if (!historyListEl) { return; }
    historyListEl.replaceChildren();
    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '暂无历史对话';
      historyListEl.append(empty);
      updateChatTitle();
      return;
    }
    state.sessions.forEach(item => {
      const card = document.createElement('div');
      card.className = 'history-item' + (item.sessionName === state.sessionName ? ' active' : '');
      const tipParts = [
        item.title || '新对话',
        [backendShort(item.backend || 'hermes'), formatWhen(item.updatedAt), item.rootLabel, item.workdir].filter(Boolean).join(' · ')
      ];
      if (item.preview) { tipParts.push(item.preview); }
      card.title = tipParts.join('\n');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      const open = () => { openSession(item.sessionName); };
      card.addEventListener('click', open);
      card.addEventListener('keydown', event => {
        if (event.target !== card) { return; }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
      });

      if (item.running) {
        const run = document.createElement('span');
        run.className = 'h-run';
        run.title = '正在执行';
        card.append(run);
      } else {
        const dot = document.createElement('span');
        dot.className = 'h-dot ' + (item.backend || 'hermes');
        card.append(dot);
      }

      const title = document.createElement('span');
      title.className = 'h-title';
      title.textContent = item.title || '新对话';

      const time = document.createElement('span');
      time.className = 'h-time';
      time.textContent = formatWhen(item.updatedAt);

      const actions = document.createElement('div');
      actions.className = 'h-actions';
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'h-act';
      renameBtn.textContent = '✎';
      renameBtn.title = '重命名';
      renameBtn.setAttribute('aria-label', '重命名对话');
      renameBtn.addEventListener('click', event => {
        event.stopPropagation();
        beginRename(item, title, card);
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'h-act danger';
      deleteBtn.textContent = '✕';
      deleteBtn.title = '删除对话';
      deleteBtn.setAttribute('aria-label', '删除对话');
      deleteBtn.addEventListener('click', event => {
        event.stopPropagation();
        removeSession(item);
      });
      actions.append(renameBtn, deleteBtn);
      card.append(title, time, actions);
      historyListEl.append(card);
    });
    updateChatTitle();
  }

  // Inline rename: swaps the title line for an input. Enter / blur saves,
  // Escape cancels. The remote keeps the same sessionName, only the title
  // changes, so backend resume mappings stay valid.
  function beginRename(item, titleEl, card) {
    const busyHere = item.running || (state.running && state.sessionName === item.sessionName);
    if (busyHere) { toast('该对话正在执行，暂不能改名', 'err'); return; }
    if (card.querySelector('.h-rename')) { return; }
    const input = document.createElement('input');
    input.className = 'h-rename';
    input.type = 'text';
    input.maxLength = 80;
    input.value = item.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async save => {
      if (done) { return; }
      done = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      if (!save || !next || next === item.title) { renderSessions(); return; }
      try {
        const data = await api('/api/session/rename', {
          method: 'POST',
          body: JSON.stringify({ name: item.sessionName, title: next })
        });
        item.title = data.title || next;
        toast('已重命名');
      } catch (error) {
        toast(error.message || '重命名失败', 'err');
      }
      renderSessions();
    };
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('click', event => { event.stopPropagation(); });
    input.addEventListener('blur', () => { finish(true); });
  }

  async function removeSession(item) {
    const busyHere = item.running || (state.running && state.sessionName === item.sessionName);
    if (busyHere) { toast('该对话正在执行，请先停止任务', 'err'); return; }
    const label = item.title || '新对话';
    if (!window.confirm('删除对话「' + label + '」？删除后不可恢复。')) { return; }
    try {
      await api('/api/session/delete', {
        method: 'POST',
        body: JSON.stringify({ name: item.sessionName })
      });
    } catch (error) {
      toast(error.message || '删除失败', 'err');
      return;
    }
    state.sessions = state.sessions.filter(session => session.sessionName !== item.sessionName);
    if (state.sessionName === item.sessionName) {
      startNewSession('对话已删除');
    } else {
      renderSessions();
    }
  }

  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderSessions();
    } catch { }
  }

  function refreshSessions(delay) {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => { loadSessions(); }, delay == null ? 150 : delay);
  }

  /* ---------------- session / selects ---------------- */

  function newSessionName() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return 'smac-' + stamp + '-' + Math.random().toString(16).slice(2, 6);
  }

  function updateSession() {
    sessionNameEl.textContent = state.sessionName;
    sessionNameEl.title = state.sessionName;
    updateChatTitle();
  }

  function populateProviders(savedProvider) {
    const list = (state.models && state.models.providers) || [];
    providerSelect.replaceChildren();
    if (!list.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未检测到账号';
      providerSelect.append(option);
      state.provider = '';
      populateModels('', '');
      return;
    }
    list.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = (item.active ? '● ' : '') + (item.label || item.id);
      providerSelect.append(option);
    });
    const preferred = list.find(item => item.id === savedProvider) ? savedProvider
      : (state.info && state.info.provider && list.some(item => item.id === state.info.provider)
        ? state.info.provider
        : (state.models.defaultProvider || list[0].id));
    state.provider = preferred;
    providerSelect.value = preferred;
    populateModels(preferred, state.info && state.info.model);
  }

  function populateModels(providerId, savedModel) {
    const list = (state.models && state.models.providers) || [];
    const labels = (state.models && state.models.modelLabels) || {};
    const provider = list.find(item => item.id === providerId);
    const models = provider && Array.isArray(provider.models) ? provider.models.slice() : [];
    modelSelect.replaceChildren();
    if (!models.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '未获取到模型（请检查登录或刷新）';
      modelSelect.append(option);
      state.model = '';
      populateReasoning('');
      return;
    }
    models.forEach(name => {
      const option = document.createElement('option');
      option.value = name;
      const friendly = labels[name];
      option.textContent = friendly || name;
      option.title = friendly && friendly !== name ? (name + ' · ' + friendly) : name;
      modelSelect.append(option);
    });
    const preferred = savedModel && models.includes(savedModel) ? savedModel : models[0];
    state.model = preferred;
    modelSelect.value = preferred;
    populateReasoning('');
  }

  const REASONING_LABELS = {
    none: '关闭', minimal: '极低', low: '低', medium: '中',
    high: '高', xhigh: '很高', max: '最高', ultra: '极致'
  };
  const DEFAULT_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

  function modelReasoningInfo() {
    const map = (state.models && state.models.reasoning) || {};
    return map[state.model] || null;
  }

  // Codex exposes per-model effort levels and a fast tier; Hermes accepts the
  // same level names on its CLI.
  function populateReasoning(saved) {
    const info = modelReasoningInfo();
    const fallback = state.backend === 'claude' || state.backend === 'agy'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : DEFAULT_REASONING_LEVELS;
    const levels = info && Array.isArray(info.levels) && info.levels.length
      ? info.levels.filter(level => REASONING_LABELS[level])
      : fallback;
    reasoningSelect.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '思考 · 自动';
    reasoningSelect.append(auto);
    levels.forEach(level => {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = REASONING_LABELS[level] + ' (' + level + ')';
      reasoningSelect.append(option);
    });
    const preferred = saved && levels.includes(saved) ? saved : '';
    state.reasoning = preferred;
    reasoningSelect.value = preferred;
    const fastSupported = state.backend === 'codex' && Boolean(info && info.fast);
    fastField.hidden = !fastSupported;
    if (!fastSupported) {
      state.fast = false;
      fastToggle.checked = false;
    }
  }

  /* ---------------- workspace ---------------- */

  function updateWorkdirLabel() {
    const rel = String(state.workdir || '');
    workdirNameEl.textContent = rel || '同步目录根';
    workdirNameEl.title = workdirBase();
  }

  function applyWorkdir(rel) {
    state.workdir = String(rel || '').replace(/^[\\/]+|[\\/]+$/g, '');
    if (state.root) { state.rootWorkdirs[state.root] = state.workdir; }
    updateWorkdirLabel();
  }

  async function loadWorkdirs(path) {
    wdList.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'wd-empty';
    loading.textContent = '正在读取…';
    wdList.append(loading);
    let data = null;
    try {
      data = await api('/api/workdirs?root=' + encodeURIComponent(state.root)
        + '&path=' + encodeURIComponent(path || ''));
    } catch (error) {
      wdList.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'wd-empty';
      empty.textContent = error.message || '读取目录失败';
      wdList.append(empty);
      return;
    }
    state.wdPath = data.path || '';
    state.wdParent = data.parent == null ? null : data.parent;
    wdPath.textContent = '/' + (state.wdPath || '');
    wdPath.title = workdirBase();
    wdList.replaceChildren();
    const dirs = Array.isArray(data.dirs) ? data.dirs : [];
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'wd-empty';
      empty.textContent = '这个文件夹下没有子文件夹，可以直接使用它，或在下方新建一个。';
      wdList.append(empty);
    }
    dirs.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wd-item';
      button.title = item.path;
      const icon = document.createElement('span');
      icon.className = 'ico';
      icon.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = item.name;
      const go = document.createElement('span');
      go.className = 'go';
      go.textContent = '进入';
      button.append(icon, name, go);
      button.addEventListener('click', () => { loadWorkdirs(item.path); });
      wdList.append(button);
    });
    if (data.truncated) {
      const more = document.createElement('div');
      more.className = 'wd-empty';
      more.textContent = '子文件夹太多，只显示前 400 个。';
      wdList.append(more);
    }
  }

  async function openWorkdirModal() {
    if (state.running) { toast('请先停止当前任务，再切换工作区'); return; }
    if (!state.root) { toast('没有可用的同步目录', 'err'); return; }
    wdNewName.value = '';
    wdModal.hidden = false;
    await loadWorkdirs(state.workdir || '');
  }

  function closeWorkdirModal() {
    wdModal.hidden = true;
  }

  async function selectBrowsedWorkdir() {
    const next = state.wdPath || '';
    closeWorkdirModal();
    if (next === state.workdir) { return; }
    applyWorkdir(next);
    saveHistory();
    startNewSession(next ? '已切换到工作区 ' + next : '已切换到同步目录根，开始新会话');
  }

  async function createWorkdir(event) {
    event.preventDefault();
    const name = wdNewName.value.trim();
    if (!name) { wdNewName.focus(); return; }
    try {
      const made = await api('/api/mkdir', {
        method: 'POST',
        body: JSON.stringify({ root: state.root, path: state.wdPath || '', name })
      });
      wdNewName.value = '';
      toast('已新建文件夹 ' + made.path);
      await loadWorkdirs(state.wdPath || '');
    } catch (error) {
      toast(error.message || '新建文件夹失败', 'err');
    }
  }

  /* ---------------- preview ---------------- */

  function previewExt(filePath) {
    const match = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''));
    return match ? match[1].toLowerCase() : '';
  }

  function isImageExt(ext) {
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) >= 0;
  }

  function closePreview() {
    previewEl.hidden = true;
    previewBody.replaceChildren();
    previewTitle.textContent = '';
    previewDownload.removeAttribute('href');
    state.previewPath = '';
  }

  function openPreview(filePath, label) {
    const path = joinWorkdir(filePath);
    const ext = previewExt(path);
    state.previewPath = path;
    previewTitle.textContent = label || basename(path);
    previewTitle.title = path;
    previewDownload.href = fileUrl(path);
    previewBody.replaceChildren();
    previewEl.hidden = false;

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].indexOf(ext) >= 0) {
      const img = document.createElement('img');
      img.alt = basename(path);
      img.src = fileUrl(path);
      img.addEventListener('error', () => {
        previewBody.replaceChildren();
        const note = document.createElement('div');
        note.className = 'preview-loading';
        note.textContent = '图片无法读取，可能已被移动或删除。';
        previewBody.append(note);
      }, { once: true });
      previewBody.append(img);
      return;
    }

    if (ext === 'svg' || ext === 'html' || ext === 'htm') {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = fileUrl(path, ext !== 'svg');
      previewBody.append(frame);
      return;
    }

    if (!ext) {
      const note = document.createElement('div');
      note.className = 'preview-loading';
      note.textContent = '这个路径没有可预览的扩展名。';
      previewBody.append(note);
      return;
    }

    const loading = document.createElement('div');
    loading.className = 'preview-loading';
    loading.textContent = '正在加载…';
    previewBody.append(loading);
    fetch(fileUrl(path, true), { headers: { 'X-Smac-Token': state.token } })
      .then(response => {
        if (!response.ok) { throw new Error('读取失败 (' + response.status + ')'); }
        return response.text();
      })
      .then(text => {
        if (state.previewPath !== path) { return; }
        previewBody.replaceChildren();
        if (ext === 'md' || ext === 'markdown') {
          const view = document.createElement('div');
          view.className = 'md-preview';
          view.innerHTML = renderMarkdown(text);
          hydrateImages(view);
          previewBody.append(view);
        } else {
          const pre = document.createElement('pre');
          pre.textContent = text;
          previewBody.append(pre);
        }
      })
      .catch(error => {
        if (state.previewPath !== path) { return; }
        previewBody.replaceChildren();
        const note = document.createElement('div');
        note.className = 'preview-loading';
        note.textContent = '无法预览：' + (error.message || '未知错误') + '。可以点右上角下载。';
        previewBody.append(note);
      });
  }

  function updateBackendChrome(info) {
    const current = info || state.info || {};
    const stateEl = $('#hermesState');
    if (stateEl) {
      if (state.backend === 'dsh') {
        const ready = Boolean(current.dsh);
        stateEl.textContent = ready ? 'DeepSeek Harness 已就绪' : '未找到 DeepSeek Harness';
        stateEl.style.color = ready ? 'var(--green)' : 'var(--red)';
      } else if (state.backend === 'claude') {
        const ready = Boolean(current.claude) && !current.claudeAuthError;
        stateEl.textContent = ready ? 'Claude 已就绪' : (current.claude ? 'Claude 未登录' : '未找到 Claude');
        stateEl.style.color = ready ? 'var(--green)' : 'var(--red)';
      } else if (state.backend === 'agy') {
        const ready = Boolean(current.agy) && !current.agyAuthError;
        stateEl.textContent = ready ? 'Antigravity 已就绪' : (current.agy ? 'Antigravity 未登录' : '未找到 Antigravity');
        stateEl.style.color = ready ? 'var(--green)' : 'var(--red)';
      } else if (state.backend === 'codex') {
        const ready = Boolean(current.codex) && !current.codexAuthError;
        stateEl.textContent = ready ? 'Codex 已就绪' : (current.codex ? 'Codex 未登录' : '未找到 Codex');
        stateEl.style.color = ready ? 'var(--green)' : 'var(--red)';
      } else if (state.backend === 'opencode') {
        const ready = Boolean(current.opencode);
        stateEl.textContent = ready ? 'OpenCode 已就绪' : '未找到 OpenCode';
        stateEl.style.color = ready ? 'var(--green)' : 'var(--red)';
      } else {
        stateEl.textContent = current.hermes ? 'Hermes 已就绪' : '未找到 Hermes';
        stateEl.style.color = current.hermes ? 'var(--green)' : 'var(--red)';
      }
    }
    const tools = $('#toolSummary');
    if (tools) {
      tools.textContent = state.backend === 'hermes' ? 'file · todo'
        : state.backend === 'dsh' ? 'dsh 文件沙箱工具'
          : 'smac 文件工具';
    }
    const safety = $('#safetyNote');
    if (safety) {
      if (state.backend === 'dsh') {
        safety.textContent = 'Agent 在客机后台无头静默运行 DeepSeek Harness 内置 dsh 引擎，直接复用客机桌面端已登录的账号订阅与模型配置，不弹窗、不抢占焦点；仅允许在所选同步目录内读写文件。';
      } else if (state.backend === 'codex') {
        safety.textContent = 'Agent 运行在客机上，自动读取客机 Codex 本地登录（~/.codex/auth.json）与 Hermes 的 ChatGPT 登录，并在上方提供商列表标明账号类型（free / plus / pro）及实时模型目录；切换账号后点「刷新模型」即可同步。';
      } else if (state.backend === 'claude') {
        safety.textContent = 'Agent 运行在远端机器上，使用远端 Claude Code 的登录或访问密钥。Claude 的内置文件 / 命令工具已关闭，只能通过 smac 文件工具读写当前选择的同步目录 / 工作区。';
      } else if (state.backend === 'agy') {
        safety.textContent = 'Agent 运行在客机交互会话后台（零弹窗），自动读取客机 Antigravity 当前登录账号的模型列表；更换付费/免费账号后点「刷新模型」即可实时更新。';
      } else {
        safety.textContent = 'Agent 运行在远端机器上，使用该机器已登录的 Hermes 额度。模型只能读写当前选择的同步目录 / 工作区，写入前有双重路径校验。';
      }
    }
    providerSelect.disabled = state.backend !== 'hermes' && state.backend !== 'dsh' && state.backend !== 'codex';
    updateComposer();
  }

  function populateBackends(info, saved) {
    const backends = info.backends || {};
    const items = [
      { id: 'dsh', label: 'DeepSeek Harness', ok: Boolean(backends.dsh) },
      { id: 'hermes', label: 'Hermes Agent', ok: Boolean(backends.hermes) },
      { id: 'codex', label: 'Codex CLI', ok: Boolean(backends.codex) },
      { id: 'claude', label: 'Claude Code', ok: Boolean(backends.claude) },
      { id: 'agy', label: 'Gemini · Antigravity', ok: Boolean(backends.agy) },
      { id: 'opencode', label: 'OpenCode CLI', ok: Boolean(backends.opencode) }
    ];
    backendSelect.replaceChildren();
    items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label + (item.ok ? '' : '（未安装）');
      backendSelect.append(option);
    });
    const preferred = info.backend || (saved && saved.backend) || 'hermes';
    state.backend = items.some(item => item.id === preferred) ? preferred : 'hermes';
    backendSelect.value = state.backend;
    updateBackendChrome(info);
  }

  function applyInfo(info, models) {
    state.info = info;
    state.models = models;
    state.device = info.device || '';
    if ($('#deviceName')) { $('#deviceName').textContent = info.device || ''; }
    if (topDeviceEl) { topDeviceEl.textContent = info.device || ''; }

    const roots = Array.isArray(info.roots) ? info.roots : [];
    rootSelect.replaceChildren();
    roots.forEach(root => {
      const option = document.createElement('option');
      option.value = root.path;
      option.textContent = root.label || root.path;
      option.title = root.label + ' · ' + root.path;
      rootSelect.append(option);
    });

    const saved = state.saved || {};
    state.rootWorkdirs = Object.assign({}, saved.rootWorkdirs || {});
    populateBackends(info, saved);
    let root = roots.length ? roots[0].path : '';
    if (saved.root) {
      const found = roots.find(item => item.path === saved.root);
      if (found) { root = found.path; }
    }
    state.root = root;
    rootSelect.value = root;
    const savedWorkdir = saved.root === root && typeof saved.workdir === 'string'
      ? saved.workdir
      : (state.rootWorkdirs[root] || '');
    applyWorkdir(savedWorkdir);

    const note = $('#rootNote');
    if (!roots.length) {
      note.hidden = false;
      note.textContent = '没有可用的同步目录。请回到 smac 控制台选择目录后重新启动 Agent。';
    } else if (Array.isArray(info.problems) && info.problems.length) {
      note.hidden = false;
      note.textContent = info.problems.join('；');
    } else {
      note.hidden = true;
    }

    const sameBackend = !saved.backend || saved.backend === state.backend;
    populateProviders(sameBackend ? saved.provider : '');
    populateReasoning(sameBackend ? saved.reasoning : '');
    if (sameBackend && saved.fast && !fastField.hidden) {
      state.fast = true;
      fastToggle.checked = true;
    }
    if (info.authError) {
      setStatus(info.authError, 'warn');
    } else if (models && models.error) {
      setStatus(models.error, 'warn');
    } else if (state.backend === 'codex' && !info.codex) {
      setStatus('远端没有找到 Codex CLI。', 'err');
    } else if (state.backend === 'claude' && !info.claude) {
      setStatus('远端没有找到 Claude Code CLI。', 'err');
    } else if (state.backend === 'agy' && !info.agy) {
      setStatus('远端没有找到 Gemini / Antigravity CLI。', 'err');
    } else if (state.backend === 'hermes' && !info.hermes) {
      setStatus('远端没有找到 Hermes 可执行文件。', 'err');
    }

    const canRestore = sameBackend && saved.sessionName && saved.messages && saved.messages.length
      && (!saved.root || roots.some(item => item.path === saved.root));
    if (canRestore) {
      state.sessionName = saved.sessionName;
      state.messages = saved.messages.map(msg => Object.assign({}, msg));
      const hasProvider = saved.provider
        && Array.from(providerSelect.options).some(option => option.value === saved.provider);
      if (hasProvider) {
        state.provider = saved.provider;
        providerSelect.value = saved.provider;
        populateModels(saved.provider, saved.model || '');
      } else if (saved.model) {
        state.model = saved.model;
        if (Array.from(modelSelect.options).some(option => option.value === saved.model)) {
          modelSelect.value = saved.model;
        }
      }
      populateReasoning(saved.reasoning || '');
      if (saved.fast && !fastField.hidden) {
        state.fast = true;
        fastToggle.checked = true;
      }
    } else {
      state.sessionName = newSessionName();
      state.messages = [];
    }
    updateSession();
    state.ready = true;
    renderAll();
    setRunning(Boolean(info.busy && info.turn && info.turn.sessionName === state.sessionName));
  }

  /* ---------------- images ---------------- */

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });
  }

  function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function isImageFile(file) {
    if (!file) return false;
    if (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(String(file.type || ''))) return true;
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(file.name || ''));
  }

  function readAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name || 'upload.bin',
        type: file.type || '',
        isImage: isImageFile(file),
        dataUrl: String(reader.result),
        size: file.size
      });
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  function addAttachment(file) {
    if (!file) { return; }
    if (state.attachments.length >= MAX_ATTACH) { toast('单次最多添加 ' + MAX_ATTACH + ' 个文件/图片'); return; }
    const img = isImageFile(file);
    const limit = (img && imageSupported()) ? MAX_IMAGE_BYTES : MAX_ATTACH_BYTES;
    if (file.size > limit) {
      toast((img && imageSupported()) ? '单张图片不能超过 12MB' : '单个文件不能超过 40MB', 'err');
      return;
    }
    readAttachment(file).then(item => {
      state.attachments.push(item);
      renderAttachments();
      inputEl.focus();
    }).catch(error => toast(error.message, 'err'));
  }

  function renderAttachments() {
    attachmentsEl.replaceChildren();
    attachmentsEl.hidden = state.attachments.length === 0;
    state.attachments.forEach((item, index) => {
      const box = document.createElement('div');
      const showThumb = item.isImage && imageSupported();
      box.className = showThumb ? 'att' : 'att att-file';
      if (showThumb) {
        const img = document.createElement('img');
        img.src = item.dataUrl;
        img.alt = item.name;
        box.append(img);
      } else {
        const ext = (item.name && item.name.includes('.') ? item.name.split('.').pop() : 'FILE').toUpperCase().slice(0, 6);
        const badge = document.createElement('span');
        badge.className = 'att-ext';
        badge.textContent = ext;
        const meta = document.createElement('div');
        meta.className = 'att-meta';
        const nm = document.createElement('span');
        nm.className = 'att-name';
        nm.textContent = item.name;
        nm.title = item.name;
        const sz = document.createElement('span');
        sz.className = 'att-size';
        sz.textContent = formatFileSize(item.size);
        meta.append(nm, sz);
        box.append(badge, meta);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        state.attachments.splice(index, 1);
        renderAttachments();
      });
      box.append(remove);
      attachmentsEl.append(box);
    });
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  function isJpegDataUrl(value) {
    return /^data:image\/jpe?g/i.test(String(value || ''));
  }

  async function normalizeImage(item) {
    const img = await loadImage(item.dataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) { throw new Error('图片尺寸无效'); }
    if (Math.max(width, height) <= 2200 && item.dataUrl.length < 6 * 1024 * 1024) {
      return { dataUrl: item.dataUrl, name: item.name };
    }
    const scale = Math.min(1, 2200 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = isJpegDataUrl(item.dataUrl);
    return {
      dataUrl: canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.92 : undefined),
      name: jpeg ? 'image.jpg' : 'image.png'
    };
  }

  async function composeImageItems(items) {
    if (!items.length) { return null; }
    if (items.length === 1) { return normalizeImage(items[0]); }

    const loaded = await Promise.all(items.map(async item => ({ img: await loadImage(item.dataUrl) })));
    const targetWidth = 1400;
    const gap = 14;
    const pad = 14;
    const entries = loaded.map(({ img }) => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const scale = Math.min(1, targetWidth / Math.max(1, width));
      return { img, width: Math.round(width * scale), height: Math.round(height * scale) };
    });
    let totalHeight = pad * 2 + entries.reduce((sum, entry) => sum + entry.height, 0) + gap * (entries.length - 1);
    const shrink = Math.min(1, 7000 / Math.max(1, totalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(targetWidth * shrink));
    canvas.height = Math.max(1, Math.round(totalHeight * shrink));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    let y = pad;
    entries.forEach(entry => {
      context.drawImage(entry.img, pad * shrink, y * shrink,
        Math.round(entry.width * shrink), Math.round(entry.height * shrink));
      y += entry.height + gap;
    });
    return { dataUrl: canvas.toDataURL('image/png'), name: 'images.png' };
  }

  /* ---------------- sending ---------------- */

  async function send() {
    if (state.sending) { return; }
    const text = inputEl.value.trim();
    if (!text && !state.attachments.length) { return; }
    if (!state.root) { toast('没有可用的工作目录', 'err'); return; }

    const interrupting = state.running;
    state.sending = true;
    updateComposer();

    let imagePath = '';
    let imageData = '';
    const uploadedFiles = [];
    try {
      const useVision = imageSupported();
      const imageItems = useVision ? state.attachments.filter(x => x.isImage) : [];
      const fileItems = useVision ? state.attachments.filter(x => !x.isImage) : state.attachments.slice();

      if (imageItems.length) {
        setStatus('正在上传图片…');
        const composed = await composeImageItems(imageItems);
        if (composed) {
          imageData = composed.dataUrl;
          const uploaded = await api('/api/upload', {
            method: 'POST',
            body: JSON.stringify({ kind: 'image', name: composed.name, data: composed.dataUrl })
          });
          imagePath = uploaded.path || '';
        }
      }
      if (fileItems.length) {
        for (let i = 0; i < fileItems.length; i += 1) {
          const item = fileItems[i];
          setStatus('正在上传文件 (' + (i + 1) + '/' + fileItems.length + ')：' + item.name + '…');
          const uploaded = await api('/api/upload', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'file',
              root: state.root,
              workdir: state.workdir,
              name: item.name,
              data: item.dataUrl
            })
          });
          uploadedFiles.push({
            name: uploaded.name || item.name,
            relPath: uploaded.relPath || '',
            path: uploaded.path || '',
            size: uploaded.size || item.size || 0
          });
        }
      }
      const prompt = text || (uploadedFiles.length && !imagePath
        ? '请读取并分析刚刚上传的文件。'
        : (uploadedFiles.length ? '请结合上传的文件与图片进行分析。' : '请查看并分析这张图片。'));
      const userMsg = {
        role: 'user',
        text,
        prompt,
        image: imageData,
        files: uploadedFiles,
        at: Date.now()
      };
      addMessage(userMsg);
      inputEl.value = '';
      autoGrow();
      clearAttachments();
      stickToBottom = true;
      scrollToBottom(true);
      if (interrupting) {
        setStatus('正在打断上一轮并插入新消息…');
      } else {
        setStatus('');
        setRunning(true);
      }

      const result = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          prompt,
          sessionName: state.sessionName,
          root: state.root,
          workdir: state.workdir,
          backend: state.backend,
          provider: state.provider,
          model: state.model,
          reasoning: state.reasoning,
          fast: state.fast,
          image: imagePath,
          files: uploadedFiles,
          interrupt: interrupting || undefined
        })
      });
      if (result.turn) {
        userMsg.turnId = result.turn.id;
        // 打断后服务端会先发上一轮的 done，再发这一轮的 state；这里直接同步一次，
        // 避免两个请求之间出现“已停止”的闪烁。
        handleState(result.turn);
      }
      saveHistory();
      refreshSessions(150);
    } catch (error) {
      setRunning(false);
      setStatus(error.message || '发送失败', 'err');
      toast(error.message || '发送失败', 'err');
      const msg = addMessage({
        role: 'assistant',
        turnId: 'local-' + Date.now(),
        text: '',
        activity: '',
        status: 'error',
        error: error.message || '发送失败',
        provider: state.provider,
        model: state.model,
        workdir: state.workdir,
        reasoning: state.reasoning,
        fast: state.fast,
        at: Date.now()
      });
      renderAnswerNow(msg);
      renderMeta(msg);
      renderError(msg);
    } finally {
      state.sending = false;
      updateComposer();
    }
  }

  async function cancel() {
    if (!state.running) { return; }
    stopBtn.disabled = true;
    setStatus('正在停止…');
    try {
      await api('/api/cancel', { method: 'POST', body: '{}' });
    } catch (error) {
      toast(error.message, 'err');
    }
    setTimeout(() => {
      if (state.running) {
        setRunning(false);
        setStatus('已请求停止，等待远端结束…', 'warn');
      }
    }, 5000);
  }

  /* ---------------- new chat / controls ---------------- */

  function startNewSession(message) {
    if (state.running) { toast('请先停止当前任务'); return; }
    if (state.sending) { toast('正在发送，请稍候'); return; }
    state.ignoredTurnId = state.currentTurnId;
    state.currentTurnId = '';
    state.lastSeq = 0;
    state.sessionName = newSessionName();
    state.messages = [];
    updateSession();
    renderAll();
    saveHistory();
    updateComposer();
    renderSessions();
    if (message) { setStatus(message); setTimeout(() => { if (statusEl.textContent === message) { setStatus(''); } }, 3000); }
    if (window.innerWidth > 900) { inputEl.focus(); }
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(210, Math.max(42, inputEl.scrollHeight)) + 'px';
  }

  function openLightbox(src) {
    lightboxImg.src = src;
    lightboxEl.hidden = false;
  }

  function closeLightbox() {
    lightboxEl.hidden = true;
    lightboxImg.removeAttribute('src');
  }

  function bind() {
    $('#btnNew').addEventListener('click', () => startNewSession());
    $('#btnNewTop').addEventListener('click', () => startNewSession());
    $('#btnReload').addEventListener('click', () => location.reload());
    const refreshModelsBtn = $('#btnRefreshModels');
    if (refreshModelsBtn) {
      refreshModelsBtn.addEventListener('click', async () => {
        if (state.running) { toast('任务执行中，请稍候再刷新模型'); return; }
        refreshModelsBtn.disabled = true;
        refreshModelsBtn.classList.add('spinning');
        try {
          const [info, models] = await Promise.all([
            api('/api/info?refresh=1'),
            api('/api/models?backend=' + encodeURIComponent(state.backend) + '&refresh=1')
          ]);
          state.info = info;
          state.models = models;
          updateBackendChrome(info);
          populateProviders(state.provider);
          populateReasoning(state.reasoning);
          const curProv = (models.providers || []).find(p => p.id === state.provider) || (models.providers || [])[0];
          const count = curProv && Array.isArray(curProv.models) ? curProv.models.length : 0;
          if (models.error) {
            setStatus(models.error, 'warn');
            toast(models.error, 'err');
          } else {
            setStatus('');
            toast('已同步最新账号与模型（当前可用 ' + count + ' 个模型）');
          }
          saveHistory();
        } catch (error) {
          toast(error.message || '刷新模型失败', 'err');
        } finally {
          refreshModelsBtn.disabled = false;
          refreshModelsBtn.classList.remove('spinning');
        }
      });
    }
    const historyRefresh = $('#btnHistoryRefresh');
    if (historyRefresh) { historyRefresh.addEventListener('click', () => { loadSessions(); }); }
    sendBtn.addEventListener('click', send);
    stopBtn.addEventListener('click', cancel);
    $('#btnAttach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      Array.from(fileInput.files || []).forEach(addAttachment);
      fileInput.value = '';
    });

    inputEl.addEventListener('input', autoGrow);
    inputEl.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });

    rootSelect.addEventListener('change', () => {
      if (state.running) {
        rootSelect.value = state.root;
        toast('请先停止当前任务');
        return;
      }
      const next = rootSelect.value;
      if (next === state.root) { return; }
      state.root = next;
      applyWorkdir(state.rootWorkdirs[next] || '');
      saveHistory();
      startNewSession('已切换工作目录，开始新会话');
    });

    $('#btnWorkdir').addEventListener('click', openWorkdirModal);
    $('#wdClose').addEventListener('click', closeWorkdirModal);
    $('#wdCancel').addEventListener('click', closeWorkdirModal);
    $('#wdUse').addEventListener('click', selectBrowsedWorkdir);
    $('#wdNewForm').addEventListener('submit', createWorkdir);
    $('#wdUp').addEventListener('click', () => {
      if (state.wdParent == null) { toast('已经在同步目录根'); return; }
      loadWorkdirs(state.wdParent);
    });
    $('#wdRoot').addEventListener('click', () => { loadWorkdirs(''); });

    reasoningSelect.addEventListener('change', () => {
      state.reasoning = reasoningSelect.value || '';
      saveHistory();
    });
    fastToggle.addEventListener('change', () => {
      state.fast = Boolean(fastToggle.checked);
      saveHistory();
    });

    providerSelect.addEventListener('change', () => {
      state.provider = providerSelect.value;
      populateModels(state.provider, '');
      saveHistory();
    });

    backendSelect.addEventListener('change', async () => {
      if (state.running) {
        backendSelect.value = state.backend;
        toast('请先停止当前任务');
        return;
      }
      const next = backendSelect.value;
      if (!next || next === state.backend) { return; }
      backendSelect.disabled = true;
      setStatus('正在切换后端…');
      try {
        const result = await api('/api/backend', {
          method: 'POST',
          body: JSON.stringify({ backend: next })
        });
        state.saved = null;
        const info = await api('/api/info');
        const models = result.models || await api('/api/models');
        applyInfo(info, models);
        setStatus('已切换到 ' + backendLabel(state.backend) + '，开始新会话');
        setTimeout(() => {
          if (statusEl.textContent && statusEl.textContent.indexOf('已切换到') === 0) { setStatus(''); }
        }, 3000);
        saveHistory();
        updateComposer();
        refreshSessions(0);
      } catch (error) {
        backendSelect.value = state.backend;
        toast(error.message, 'err');
        setStatus(error.message, 'err');
      } finally {
        backendSelect.disabled = false;
      }
    });

    modelSelect.addEventListener('change', () => {
      state.model = modelSelect.value;
      populateReasoning(state.reasoning);
      saveHistory();
    });

    messagesEl.addEventListener('scroll', () => {
      stickToBottom = nearBottom();
      jumpBtn.hidden = stickToBottom || state.messages.length === 0;
    });
    jumpBtn.addEventListener('click', () => {
      stickToBottom = true;
      scrollToBottom(true);
      jumpBtn.hidden = true;
    });

    document.addEventListener('paste', event => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) { return; }
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) { files.push(file); }
        }
      }
      if (files.length) {
        event.preventDefault();
        files.forEach(addAttachment);
      }
    });

    composerEl.addEventListener('dragover', event => {
      event.preventDefault();
      composerEl.classList.add('drag');
    });
    composerEl.addEventListener('dragleave', event => {
      if (!composerEl.contains(event.relatedTarget)) { composerEl.classList.remove('drag'); }
    });
    composerEl.addEventListener('drop', event => {
      event.preventDefault();
      composerEl.classList.remove('drag');
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
      if (files.length) {
        files.forEach(addAttachment);
      }
    });

    lightboxEl.addEventListener('click', event => {
      if (event.target === lightboxEl) { closeLightbox(); }
    });
    $('#lbClose').addEventListener('click', closeLightbox);
    $('#previewClose').addEventListener('click', closePreview);
    previewEl.addEventListener('click', event => {
      if (event.target === previewEl) { closePreview(); }
    });
    wdModal.addEventListener('click', event => {
      if (event.target === wdModal) { closeWorkdirModal(); }
    });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (event.key === 'Escape') {
        closeLightbox();
        closeMobileSidebar();
        if (!previewEl.hidden) { closePreview(); }
        else if (!wdModal.hidden) { closeWorkdirModal(); }
      }
    });

    if ($('#btnCollapseSidebar')) { $('#btnCollapseSidebar').addEventListener('click', toggleSidebar); }
    if ($('#btnToggleSidebar')) { $('#btnToggleSidebar').addEventListener('click', toggleSidebar); }
    if ($('#btnSettings')) { $('#btnSettings').addEventListener('click', toggleSidebar); }
    if (sidebarScrimEl) { sidebarScrimEl.addEventListener('click', closeMobileSidebar); }
    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) { closeMobileSidebar(); }
    });

    try {
      if (window.innerWidth > 900 && localStorage.getItem(LS_SIDEBAR_KEY) === '1') {
        setSidebarCollapsed(true);
      }
    } catch { }

    window.addEventListener('beforeunload', saveHistory);
  }

  async function init() {
    bind();
    const params = new URLSearchParams(location.search);
    state.token = params.get('token') || sessionStorage.getItem('smac-agent-token') || '';
    if (!state.token) {
      showFatal('缺少访问 token。请回到 smac 控制台，在「远程 Agent」里点击「打开对话」进入。');
      return;
    }
    sessionStorage.setItem('smac-agent-token', state.token);
    state.saved = loadSaved();

    try {
      const results = await Promise.all([api('/api/info'), api('/api/models')]);
      applyInfo(results[0], results[1]);
      await loadSessions();
      // 历史记录以远端为准：同一会话在别的浏览器 / 刷新后也能看到完整对话。
      if (state.sessions.some(item => item.sessionName === state.sessionName)) {
        try {
          const data = await api('/api/session?name=' + encodeURIComponent(state.sessionName));
          if (data.session) {
            applyRecord(data.session);
            updateSession();
            renderAll();
            updateComposer();
          }
        } catch { }
      }
      setRunning(Boolean(results[0].busy && results[0].turn && results[0].turn.sessionName === state.sessionName));
      if (results[0].turn) { handleState(results[0].turn); }
      openEvents();
      if (state.root) { inputEl.focus(); }
    } catch (error) {
      showFatal(error.message || '无法连接到远端 Agent。');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
