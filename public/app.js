var t = (typeof i18n !== 'undefined' && i18n.t) ? i18n.t : function (k) { return k; };
function applyStaticI18n() {
    if (typeof document === 'undefined')
        return;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
        el.placeholder = t(el.getAttribute('data-i18n-ph'));
    });
}
applyStaticI18n();
var $sessionList = document.getElementById('sessionList');
var $welcomeView = document.getElementById('welcomeView');
var $chatView = document.getElementById('chatView');
var $chatMessages = document.getElementById('chatMessages');
var $chatInputArea = document.getElementById('chatInputArea');
var $chatSessionId = document.getElementById('chatSessionId');
var $chatSessionMeta = document.getElementById('chatSessionMeta');
var $pendingContext = document.getElementById('pendingContext');
var $quickReplyBar = document.getElementById('quickReplyBar');
var $replyInput = document.getElementById('replyInput');
var $sendBtn = document.getElementById('sendBtn');
var $extendBtn = document.getElementById('extendBtn');
var $cancelBtn = document.getElementById('cancelBtn');
var $waitCountdown = document.getElementById('waitCountdown');
var $settingsView = document.getElementById('settingsView');
var $authHint = document.getElementById('authHint');
var $apiKeyInput = document.getElementById('apiKeyInput');
var $mcpEndpointUrl = document.getElementById('mcpEndpointUrl');
var $setupGuideContent = document.getElementById('setupGuideContent');
var $sessionFilter = document.getElementById('sessionFilter');
var $webhookUrlInput = document.getElementById('webhookUrlInput');
var API_KEY_STORAGE = 'turn-mcp-web.apiKey';
var NOTIF_STORAGE = 'turn-mcp-web.notif';
var TEMPLATES_STORAGE = 'turn-mcp-web.templates';
var SESSION_NAMES_KEY = 'turn-mcp-web.sessionNames';
var REFRESH_INTERVAL = 15000;
var REFRESH_INTERVAL_FAST = 1500;
var FALLBACK_POLL_INTERVAL = 5000;
var SESSION_LIST_MAX = 100;
var SSE_BACKOFF_BASE = 1500;
var SSE_BACKOFF_MAX = 30000;
var DEFAULT_TEMPLATES = null;
function getDefaultTemplates() {
    return [t('tpl.continue'), t('tpl.proceed'), t('tpl.pause')];
}
var requireApiKey = false;
var apiKey = localStorage.getItem(API_KEY_STORAGE) || '';
var currentRole = 'none';
function syncApiKeyCookie() {
    if (apiKey)
        document.cookie = 'turn_mcp_key=' + encodeURIComponent(apiKey) + '; Path=/; SameSite=Strict';
    else
        document.cookie = 'turn_mcp_key=; Path=/; Max-Age=0; SameSite=Strict';
}
var serverTimeoutEnabled = true;
var webhookUrl = '';
var webhookEvents = '';
var sessionMap = new Map();
var selectedSessionId = null;
var sessionTimeline = [];
var sessionPendingWaits = [];
var sessionPendingWait = null;
var sessionNames = {};
try {
    sessionNames = JSON.parse(localStorage.getItem(SESSION_NAMES_KEY) || '{}');
}
catch (e) { }
function getSessionName(id) { return sessionNames[id] || ''; }
function setSessionName(id, name) {
    if (name && name.trim())
        sessionNames[id] = name.trim();
    else
        delete sessionNames[id];
    try {
        localStorage.setItem(SESSION_NAMES_KEY, JSON.stringify(sessionNames));
    }
    catch (e) { }
}
function sessionsArray() {
    return Array.from(sessionMap.values()).sort(function (a, b) {
        if (a.status === 'pending' && b.status !== 'pending')
            return -1;
        if (a.status !== 'pending' && b.status === 'pending')
            return 1;
        return b.lastActivity - a.lastActivity;
    });
}
var sseConnected = false;
var sseEverConnected = false;
var sseReconnectTimer = null;
var sseReconnectDelay = SSE_BACKOFF_BASE;
var timelineCache = new Map();
var notifSettings = { desktop: true, sound: true };
try {
    var saved = JSON.parse(localStorage.getItem(NOTIF_STORAGE) || 'null');
    if (saved && typeof saved === 'object') {
        notifSettings.desktop = saved.desktop !== false;
        notifSettings.sound = saved.sound !== false;
    }
}
catch (e) { }
var replyTemplates = null;
try {
    var savedTpl = JSON.parse(localStorage.getItem(TEMPLATES_STORAGE) || 'null');
    if (Array.isArray(savedTpl) && savedTpl.length > 0) {
        replyTemplates = savedTpl.filter(function (s) { return typeof s === 'string' && s.trim(); });
    }
}
catch (e) { }
function getTemplates() {
    return replyTemplates || getDefaultTemplates();
}
function saveTemplates() {
    try {
        localStorage.setItem(TEMPLATES_STORAGE, JSON.stringify(replyTemplates || getDefaultTemplates()));
    }
    catch (e) { }
}
function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDateTime(ms) {
    return new Date(ms).toLocaleString();
}
function shortId(id) {
    if (!id)
        return '';
    return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
async function apiRequest(url, method, body) {
    var headers = {};
    if (body !== undefined)
        headers['content-type'] = 'application/json';
    if (apiKey)
        headers['x-turn-mcp-api-key'] = apiKey;
    var res = await fetch(url, {
        method: method || 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok)
        throw new Error(data.error || 'HTTP ' + res.status);
    return data;
}
function svgIcon(paths, size) {
    size = size || 18;
    return '<svg class="ui-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
var ICONS = {
    bellOn: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    bellOff: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/>'),
    soundOn: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'),
    soundOff: svgIcon('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'),
    globe: svgIcon('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    clock: svgIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', 14),
    xCircle: svgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>', 14),
    loader: svgIcon('<path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/>', 16),
    send: svgIcon('<path d="m22 2-7 20-4-9-9-4z"/><path d="m22 2-11 11"/>', 16),
    copy: svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 13),
};
function showErrorToast(message) {
    if (!$toastContainer)
        return;
    var timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var toast = document.createElement('div');
    toast.className = 'toast toast-error';
    toast.innerHTML =
        '<div class="toast-icon">' +
            svgIcon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>') +
            '</div>' +
            '<div class="toast-body">' +
            '<div class="toast-title">' + esc(t('error.title')) + '</div>' +
            (message ? '<div class="toast-subtitle">' + esc(message) + '</div>' : '') +
            '</div>' +
            '<span class="toast-time">' + esc(timeStr) + '</span>';
    $toastContainer.appendChild(toast);
    toast._dismissTimer = setTimeout(function () { dismissToast(toast); }, 5000);
}
function showConfirm(message, onConfirm) {
    var modal = document.getElementById('confirmModal');
    var msgEl = document.getElementById('confirmMsg');
    var okBtn = document.getElementById('confirmOk');
    var cancelEl = document.getElementById('confirmCancel');
    if (!modal || !msgEl || !okBtn || !cancelEl) {
        if (window.confirm(message))
            onConfirm();
        return;
    }
    msgEl.textContent = message;
    modal.classList.remove('hidden');
    function cleanup() {
        modal.classList.add('hidden');
        okBtn.removeEventListener('click', handleOk);
        cancelEl.removeEventListener('click', handleCancel);
        modal.removeEventListener('click', handleBackdrop);
    }
    function handleOk() { cleanup(); onConfirm(); }
    function handleCancel() { cleanup(); }
    function handleBackdrop(e) { if (e.target === modal)
        cleanup(); }
    okBtn.addEventListener('click', handleOk);
    cancelEl.addEventListener('click', handleCancel);
    modal.addEventListener('click', handleBackdrop);
}
function renderSessionNameInHeader(sessionId) {
    var nameEl = document.getElementById('chatSessionName');
    var idEl = document.getElementById('chatSessionId');
    if (!nameEl || !idEl)
        return;
    var name = getSessionName(sessionId);
    if (name) {
        nameEl.textContent = name;
        nameEl.classList.remove('hidden');
        idEl.style.opacity = '0.4';
        idEl.style.fontSize = '11px';
    }
    else {
        nameEl.classList.add('hidden');
        idEl.style.opacity = '';
        idEl.style.fontSize = '';
    }
}
function startEditSessionName(sessionId) {
    var nameEl = document.getElementById('chatSessionName');
    var idEl = document.getElementById('chatSessionId');
    var editBtn = document.getElementById('editNameBtn');
    if (!nameEl)
        return;
    var current = getSessionName(sessionId);
    var input = document.createElement('input');
    input.className = 'session-name-input text-input';
    input.value = current;
    input.placeholder = t('session.namePlaceholder');
    input.maxLength = 40;
    var headerInfo = document.querySelector('.chat-header-info');
    if (!headerInfo)
        return;
    if (editBtn)
        editBtn.classList.add('hidden');
    headerInfo.appendChild(input);
    input.focus();
    input.select();
    function commit() {
        setSessionName(sessionId, input.value);
        if (input.parentNode)
            input.parentNode.removeChild(input);
        if (editBtn)
            editBtn.classList.remove('hidden');
        renderSessionNameInHeader(sessionId);
        renderSessionList();
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
        if (e.key === 'Escape') {
            input.value = current;
            input.blur();
        }
    });
}
function copyCode(btn) {
    var wrap = btn.closest('.code-wrap');
    if (!wrap)
        return;
    var codeEl = wrap.querySelector('code') || wrap.querySelector('pre');
    var text = codeEl ? (codeEl.textContent || '') : '';
    var originalHTML = btn.innerHTML;
    navigator.clipboard.writeText(text).then(function () {
        btn.setAttribute('data-copied', '1');
        btn.innerHTML = svgIcon('<polyline points="20 6 9 17 4 12"/>', 13) + ' ' + esc(t('btn.copied'));
        btn.title = t('btn.copied');
        setTimeout(function () {
            btn.removeAttribute('data-copied');
            btn.innerHTML = originalHTML;
            btn.title = t('btn.copy');
        }, 2000);
    }).catch(function () {
        if (codeEl) {
            var sel = window.getSelection();
            var range = document.createRange();
            range.selectNodeContents(codeEl);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        showErrorToast(t('copy.failed'));
    });
}
function codeWrap(preContent) {
    return '<div class="code-wrap"><button class="copy-btn" type="button" title="' + t('btn.copy') + '">' + ICONS.copy + '</button>' + preContent + '</div>';
}
function syntaxHighlight(code, lang) {
    var l = (lang || '').toLowerCase();
    var LANGS = ['json', 'python', 'javascript', 'js', 'typescript', 'ts', 'bash', 'shell', 'sh'];
    if (LANGS.indexOf(l) < 0)
        return esc(code);
    var parts = [];
    var s = code;
    function extract(re, cls) {
        s = s.replace(re, function (m) {
            var idx = parts.length;
            parts.push('<span class="tok-' + cls + '">' + esc(m) + '</span>');
            return '\x01' + idx + '\x02';
        });
    }
    if (l === 'json') {
        extract(/"(?:[^"\\]|\\.)*"(?=\s*:)/g, 'key');
        extract(/"(?:[^"\\]|\\.)*"/g, 'str');
        extract(/\b-?\d+\.?\d*(?:[eE][+-]?\d+)?\b/g, 'num');
        extract(/\b(?:true|false|null)\b/g, 'kw');
    }
    else if (l === 'python') {
        extract(/#[^\n]*/g, 'cmt');
        extract(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, 'str');
        extract(/\b(?:def|class|import|from|return|if|elif|else|for|while|with|as|in|not|and|or|is|None|True|False|pass|break|continue|raise|try|except|finally|lambda|yield|global|nonlocal|del|assert|async|await)\b/g, 'kw');
        extract(/\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g, 'num');
    }
    else if (l === 'javascript' || l === 'js' || l === 'typescript' || l === 'ts') {
        extract(/\/\/[^\n]*/g, 'cmt');
        extract(/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, 'str');
        extract(/\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|default|typeof|instanceof|in|of|void|delete|throw|try|catch|finally|async|await|true|false|null|undefined|this|super|yield|from|as|static)\b/g, 'kw');
        extract(/\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/g, 'num');
    }
    else {
        extract(/#[^\n]*/g, 'cmt');
        extract(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'str');
        extract(/\b(?:if|then|else|elif|fi|for|do|done|while|case|esac|in|function|return|exit|echo|export|source|local|readonly)\b/g, 'kw');
    }
    return s.replace(/\x01(\d+)\x02|[^\x01\x02]+|[\x01\x02]/g, function (m, idx) {
        if (idx !== undefined)
            return parts[parseInt(idx, 10)];
        return esc(m);
    });
}
function microMd(text) {
    if (!text)
        return '';
    text = String(text);
    var blocks = [];
    text = text.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, function (_, lang, code) {
        var i = blocks.length;
        blocks.push({ lang: lang || '', code: code.trimEnd() });
        return '\x02' + i + '\x03';
    });
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    text = text.replace(/`([^`\n]{1,300})`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]{1,300})\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\n]{1,300})\*/g, '<em>$1</em>');
    var lines = text.split('\n');
    var out = '';
    var inUl = false, inOl = false;
    var tableRows = [];
    function cl() {
        if (inUl) {
            out += '</ul>';
            inUl = false;
        }
        if (inOl) {
            out += '</ol>';
            inOl = false;
        }
    }
    function flushTable() {
        if (tableRows.length === 0)
            return;
        var hasSep = tableRows.some(function (r) {
            return r.split('|').slice(1, -1).every(function (c) { return /^[-: ]+$/.test(c.trim()); });
        });
        out += '<table class="md-table"><tbody>';
        var isFirst = true;
        tableRows.forEach(function (row) {
            var cells = row.split('|').slice(1, -1).map(function (c) { return c.trim(); });
            if (cells.every(function (c) { return /^[-: ]+$/.test(c); })) {
                isFirst = false;
                return;
            }
            var tag = (hasSep && isFirst) ? 'th' : 'td';
            out += '<tr>' + cells.map(function (c) { return '<' + tag + '>' + c + '</' + tag + '>'; }).join('') + '</tr>';
            if (isFirst)
                isFirst = false;
        });
        out += '</tbody></table>';
        tableRows = [];
    }
    lines.forEach(function (line) {
        var cm = line.match(/^\x02(\d+)\x03$/);
        if (cm) {
            cl();
            if (tableRows.length > 0)
                flushTable();
            var b = blocks[+cm[1]];
            var sc = syntaxHighlight(b.code, b.lang);
            out += codeWrap('<pre><code>' + sc + '</code></pre>');
            return;
        }
        var tblRow = /^\|.+\|$/.test(line);
        if (!tblRow && tableRows.length > 0)
            flushTable();
        if (tblRow) {
            cl();
            tableRows.push(line);
            return;
        }
        var hm = line.match(/^(#{1,3})\s+(.*)/);
        if (hm) {
            cl();
            out += '<h' + hm[1].length + ' class="md-h">' + hm[2] + '</h' + hm[1].length + '>';
            return;
        }
        if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
            cl();
            out += '<hr class="md-hr">';
            return;
        }
        var ulm = line.match(/^[-*+]\s+(.*)/);
        if (ulm) {
            if (inOl) {
                out += '</ol>';
                inOl = false;
            }
            if (!inUl) {
                out += '<ul>';
                inUl = true;
            }
            out += '<li>' + ulm[1] + '</li>';
            return;
        }
        var olm = line.match(/^\d+[.)]\s+(.*)/);
        if (olm) {
            if (inUl) {
                out += '</ul>';
                inUl = false;
            }
            if (!inOl) {
                out += '<ol>';
                inOl = true;
            }
            out += '<li>' + olm[1] + '</li>';
            return;
        }
        cl();
        if (!line.trim()) {
            out += '<div class="md-gap"></div>';
            return;
        }
        out += '<p>' + line + '</p>';
    });
    cl();
    flushTable();
    return out;
}
function relativeTime(ms) {
    var diff = Date.now() - ms;
    if (diff < 90000)
        return t('time.justNow');
    if (diff < 3600000)
        return t('time.minsAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86400000)
        return t('time.hrsAgo', { n: Math.floor(diff / 3600000) });
    return t('time.daysAgo', { n: Math.floor(diff / 86400000) });
}
function toggleExpand(btn) {
    var ctx = btn.previousElementSibling;
    while (ctx && ctx.tagName === 'BUTTON')
        ctx = ctx.previousElementSibling;
    if (!ctx)
        return;
    var expanded = ctx.classList.toggle('expanded');
    btn.textContent = expanded ? t('chat.showLess') : t('chat.showMore');
}
function buildContextHtml(text, waitId) {
    if (!text)
        return '';
    var md = microMd(text);
    var isLong = text.length > 500;
    var isTruncated = Boolean(waitId) && text.length >= 5000;
    if (isLong || isTruncated) {
        var ctxClass = 'msg-context md-content' + (isLong ? ' collapsible' : '');
        var html = '<div class="' + ctxClass + '">' + md + '</div>';
        if (isTruncated) {
            html += '<button class="expand-btn" type="button" data-action="load-full" data-wait-id="' + esc(waitId) + '">' + t('chat.loadFullContext') + '</button>';
        }
        if (isLong) {
            html += '<button class="expand-btn" type="button" data-action="toggle-expand">' + t('chat.showMore') + '</button>';
        }
        return html;
    }
    return '<div class="msg-context md-content">' + md + '</div>';
}
async function loadFullContext(btn, waitId) {
    try {
        btn.disabled = true;
        btn.textContent = t('chat.loading');
        var data = await apiRequest('/api/waits/' + encodeURIComponent(waitId));
        if (data.wait && data.wait.context) {
            var ctx = btn.previousElementSibling;
            while (ctx && ctx.tagName === 'BUTTON')
                ctx = ctx.previousElementSibling;
            if (ctx) {
                ctx.innerHTML = microMd(data.wait.context);
                ctx.classList.remove('collapsible');
                ctx.classList.remove('expanded');
            }
            var next = btn.nextElementSibling;
            if (next && next.classList.contains('expand-btn'))
                next.parentNode.removeChild(next);
            btn.parentNode.removeChild(btn);
        }
    }
    catch (e) {
        btn.disabled = false;
        btn.textContent = t('chat.loadFullContext');
    }
}
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(function () { });
}
function playChime() {
    try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        var now = ctx.currentTime;
        var notes = [1047, 1319];
        var durations = [0.12, 0.18];
        var delays = [0, 0.1];
        notes.forEach(function (freq, i) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, now + delays[i]);
            gain.gain.linearRampToValueAtTime(0.18, now + delays[i] + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, now + delays[i] + durations[i]);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + delays[i]);
            osc.stop(now + delays[i] + durations[i] + 0.05);
        });
    }
    catch (e) { }
}
var $toastContainer = document.getElementById('toastContainer');
var toastDismissTimer = null;
function showToast(title, subtitle, sessionId) {
    if (!$toastContainer)
        return;
    var now = new Date();
    var timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
        '<div class="toast-icon">' +
            svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>') +
            '</div>' +
            '<div class="toast-body">' +
            '<div class="toast-title">' + esc(title) + '</div>' +
            (subtitle ? '<div class="toast-subtitle">' + esc(subtitle) + '</div>' : '') +
            '</div>' +
            '<span class="toast-time">' + esc(timeStr) + '</span>';
    if (sessionId) {
        toast.addEventListener('click', function () {
            dismissToast(toast);
            selectSession(sessionId);
        });
    }
    $toastContainer.appendChild(toast);
    var timer = setTimeout(function () { dismissToast(toast); }, 4500);
    toast._dismissTimer = timer;
}
function dismissToast(el) {
    if (!el || !el.parentNode)
        return;
    if (el._dismissTimer)
        clearTimeout(el._dismissTimer);
    el.classList.add('toast-exiting');
    setTimeout(function () {
        if (el.parentNode)
            el.parentNode.removeChild(el);
    }, 320);
}
var titleFlashTimer = null;
var ORIGINAL_TITLE = document.title || 'Turn MCP Web Console';
var pendingNewWaits = 0;
function startTitleFlash() {
    if (titleFlashTimer)
        return;
    var toggle = false;
    titleFlashTimer = setInterval(function () {
        toggle = !toggle;
        document.title = toggle ? '(' + pendingNewWaits + ') ' + t('notif.newTask') : ORIGINAL_TITLE;
    }, 1000);
}
function stopTitleFlash() {
    if (titleFlashTimer) {
        clearInterval(titleFlashTimer);
        titleFlashTimer = null;
    }
    document.title = ORIGINAL_TITLE;
    pendingNewWaits = 0;
}
document.addEventListener('visibilitychange', function () { if (!document.hidden)
    stopTitleFlash(); });
window.addEventListener('focus', function () { stopTitleFlash(); });
function onNewWaitCreated(data) {
    var sid = data?.sessionId || '';
    var notifBody = sid ? t('notif.session') + shortId(sid) : '';
    showToast(t('notif.title'), notifBody, sid);
    if (notifSettings.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
            new Notification(t('notif.title'), { body: notifBody, tag: 'turn-mcp-wait' });
        }
        catch (e) { }
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'WAIT_CREATED',
            data: data,
            notifTitle: t('notif.title'),
            notifBody: notifBody,
        });
    }
    if (notifSettings.sound)
        playChime();
    if (document.hidden) {
        pendingNewWaits++;
        startTitleFlash();
    }
}
function updateNotifButtons() {
    var nb = document.getElementById('notifToggleBtn');
    var sb = document.getElementById('soundToggleBtn');
    if (nb)
        nb.innerHTML = notifSettings.desktop ? ICONS.bellOn : ICONS.bellOff;
    if (sb)
        sb.innerHTML = notifSettings.sound ? ICONS.soundOn : ICONS.soundOff;
}
function updateLangButton() {
    var lb = document.getElementById('langToggleBtn');
    if (!lb)
        return;
    var lang = (typeof i18n !== 'undefined') ? i18n.getLang() : 'en';
    var label = lang === 'zh' ? 'EN' : '中';
    lb.innerHTML = ICONS.globe + ' <span>' + label + '</span>';
}
updateNotifButtons();
updateLangButton();
var _mcpUrl = '';
var _hasAuth = false;
function updateConnStatus(state) {
    var el = document.getElementById('connStatus');
    if (!el)
        return;
    el.className = 'conn-status ' + state;
    var labels = { connecting: t('conn.connecting'), live: t('conn.live'), polling: t('conn.polling'), disconnected: t('conn.disconnected') };
    el.textContent = labels[state] || labels.connecting;
}
async function loadPublicConfig() {
    var data = await fetch('/api/public-config').then(function (r) { return r.json(); }).catch(function () { return {}; });
    requireApiKey = Boolean(data.requireApiKey);
    var authSection = document.getElementById('authSection');
    if (authSection) {
        if (!requireApiKey)
            authSection.classList.add('hidden');
        else
            authSection.classList.remove('hidden');
    }
    if (!requireApiKey) {
        currentRole = 'operator';
        if ($authHint)
            $authHint.textContent = '';
    }
    else {
        if ($authHint)
            $authHint.textContent = apiKey ? t('auth.saved') : t('auth.required');
    }
    serverTimeoutEnabled = data.timeoutEnabled !== false;
    var $timeoutToggle = document.getElementById('timeoutToggle');
    if ($timeoutToggle)
        $timeoutToggle.checked = serverTimeoutEnabled;
    updateTimeoutHint();
    var mcpUrl = window.location.origin + (data.mcpPath || '/mcp');
    _mcpUrl = mcpUrl;
    _hasAuth = Boolean(data.requireApiKey);
    if ($mcpEndpointUrl)
        $mcpEndpointUrl.textContent = mcpUrl;
    renderSetupGuide(mcpUrl, requireApiKey);
}
async function refreshAuthRole() {
    if (!requireApiKey) {
        currentRole = 'operator';
        return;
    }
    if (!apiKey) {
        currentRole = 'none';
        return;
    }
    try {
        var info = await apiRequest('/api/auth-check');
        currentRole = String(info.role || 'none');
        if ($authHint)
            $authHint.textContent = t('auth.role', { role: currentRole });
    }
    catch (e) {
        currentRole = 'none';
        if ($authHint)
            $authHint.textContent = t('auth.fail', { error: e.message });
    }
}
async function loadSessions() {
    if (requireApiKey && !apiKey) {
        sessionMap = new Map();
        return;
    }
    await refreshAuthRole();
    var data = await apiRequest('/api/sessions');
    webhookUrl = data.webhookUrl || '';
    webhookEvents = data.webhookEvents || '';
    if ($webhookUrlInput && document.activeElement !== $webhookUrlInput)
        $webhookUrlInput.value = webhookUrl;
    var newMap = new Map();
    (data.sessions || []).forEach(function (s) {
        newMap.set(s.sessionId, {
            sessionId: s.sessionId,
            status: s.status,
            lastActivity: s.lastActivity,
            pendingWaits: s.pendingWaits || (s.pendingWait ? [s.pendingWait] : []),
            pendingWait: s.pendingWait || null,
            interactionCount: s.interactionCount,
        });
        var firstWait = (s.pendingWaits && s.pendingWaits[0]) || s.pendingWait;
        if (firstWait && firstWait.agentName && !getSessionName(s.sessionId)) {
            if (!sessionNames[s.sessionId]) {
                setSessionName(s.sessionId, firstWait.agentName);
            }
        }
    });
    sessionMap = newMap;
}
async function loadSessionChat(sessionId) {
    sessionTimeline = [];
    sessionPendingWaits = [];
    sessionPendingWait = null;
    var session = sessionMap.get(sessionId);
    if (session && session.pendingWaits && session.pendingWaits.length > 0) {
        sessionPendingWaits = session.pendingWaits.slice();
        sessionPendingWait = sessionPendingWaits[0];
    }
    if (timelineCache.has(sessionId)) {
        sessionTimeline = timelineCache.get(sessionId);
        return;
    }
    try {
        var data = await apiRequest('/api/history/timeline?sessionId=' + encodeURIComponent(sessionId));
        sessionTimeline = data.timeline || [];
        timelineCache.set(sessionId, sessionTimeline);
    }
    catch (e) {
        sessionTimeline = [];
    }
}
function buildSessionItemHtml(s) {
    var isActive = s.sessionId === selectedSessionId;
    var dotClass = s.status === 'pending' ? 'pending' : s.status === 'timeout' ? 'timeout' : s.status === 'canceled' ? 'canceled' : 'completed';
    var firstPending = s.pendingWaits && s.pendingWaits[0];
    var pendingCount = (s.pendingWaits || []).length;
    var statusText = s.status === 'pending'
        ? (pendingCount > 1 ? pendingCount + ' ' + t('sessions.waitingMulti') : t('sessions.waiting'))
        : s.interactionCount + ' ' + t('sessions.interactions');
    var customName = getSessionName(s.sessionId);
    var displayId = customName ? esc(customName) : esc(shortId(s.sessionId));
    var agentBadge = (firstPending && firstPending.agentName) ? ' <span class="agent-name-badge">' + esc(firstPending.agentName) + '</span>' : '';
    var multiPendingBadge = pendingCount > 1 ? ' <span class="multi-pending-badge">' + pendingCount + '</span>' : '';
    var resBadge = '';
    if (s.status === 'timeout')
        resBadge = ' <span class="session-res-badge res-timeout">' + esc(t('sessions.resBadgeTimeout')) + '</span>';
    if (s.status === 'canceled')
        resBadge = ' <span class="session-res-badge res-canceled">' + esc(t('sessions.resBadgeCanceled')) + '</span>';
    if (s.status === 'interrupted')
        resBadge = ' <span class="session-res-badge res-interrupted">' + esc(t('sessions.resBadgeInterrupted')) + '</span>';
    return '<div class="session-item' + (isActive ? ' active' : '') + '" data-session-id="' + esc(s.sessionId) + '">' +
        '<div class="session-item-header">' +
        '<span class="session-dot ' + dotClass + '"></span>' +
        '<span class="session-id">' + displayId + '</span>' +
        agentBadge + multiPendingBadge + resBadge +
        '</div>' +
        '<div class="session-meta">' + esc(statusText) + ' · ' + esc(relativeTime(s.lastActivity)) + '</div>' +
        '</div>';
}
function renderSessionList() {
    var allSessions = sessionsArray();
    var filterVal = ($sessionFilter ? $sessionFilter.value.trim().toLowerCase() : '');
    if (filterVal) {
        allSessions = allSessions.filter(function (s) {
            var name = getSessionName(s.sessionId).toLowerCase();
            return s.sessionId.toLowerCase().includes(filterVal) || name.includes(filterVal);
        });
    }
    var active = allSessions.filter(function (s) { return s.status === 'pending'; });
    var historical = allSessions.filter(function (s) { return s.status !== 'pending'; });
    var _ftSearchPending = false;
    if (filterVal && filterVal.length >= 2) {
        _ftSearchPending = true;
        apiRequest('/api/history?q=' + encodeURIComponent(filterVal) + '&limit=200').then(function (res) {
            var matchedIds = new Set();
            (res.history || []).forEach(function (h) { matchedIds.add(h.sessionId); });
            var extraSessions = [];
            matchedIds.forEach(function (sid) {
                if (!sessionMap.has(sid))
                    return;
                var s = sessionMap.get(sid);
                if (!active.some(function (a) { return a.sessionId === sid; }) &&
                    !historical.some(function (h) { return h.sessionId === sid; })) {
                    extraSessions.push(Object.assign({}, s, { _contentMatch: true }));
                }
                else {
                    s._contentMatch = true;
                }
            });
            if (extraSessions.length > 0) {
                historical = historical.concat(extraSessions);
                $sessionList.innerHTML = buildSessionListHtml(active, historical, SESSION_LIST_MAX, filterVal);
            }
        }).catch(function () { });
    }
    var $cancelAll = document.getElementById('cancelAllBtn');
    if ($cancelAll) {
        if (active.length > 0)
            $cancelAll.classList.remove('hidden');
        else
            $cancelAll.classList.add('hidden');
    }
    if (active.length === 0 && historical.length === 0) {
        $sessionList.innerHTML = '<div class="session-list-empty">' +
            esc(filterVal ? t('sessions.noMatch') : t('sessions.empty')) + '</div>';
        return;
    }
    $sessionList.innerHTML = buildSessionListHtml(active, historical, SESSION_LIST_MAX, filterVal);
}
function buildSessionListHtml(active, historical, maxItems, _filterVal) {
    var html = '';
    if (active.length > 0) {
        html += '<div class="session-group-hdr">' +
            '<span class="session-group-dot pending"></span>' +
            '<span>' + esc(t('sessions.groupActive')) + '</span>' +
            '<span class="session-group-count">' + active.length + '</span>' +
            '</div>';
        var activeSlice = active.length > maxItems ? active.slice(0, maxItems) : active;
        html += activeSlice.map(buildSessionItemHtml).join('');
        if (active.length > maxItems) {
            html += '<div class="session-list-empty" style="font-size:11px">' + esc(t('sessions.more', { shown: maxItems, total: active.length })) + '</div>';
        }
    }
    if (historical.length > 0) {
        html += '<div class="session-group-hdr session-group-hdr-history">' +
            '<span>' + esc(t('sessions.groupHistory')) + '</span>' +
            '<span class="session-group-count">' + historical.length + '</span>' +
            '</div>';
        var histSlice = historical.length > maxItems ? historical.slice(0, maxItems) : historical;
        html += histSlice.map(buildSessionItemHtml).join('');
        if (historical.length > maxItems) {
            html += '<div class="session-list-empty" style="font-size:11px">' + esc(t('sessions.more', { shown: maxItems, total: historical.length })) + '</div>';
        }
    }
    return html;
}
function buildOptionChipsHtml(options, selectedMsg) {
    if (!options || options.length === 0)
        return '';
    var chips = options.map(function (opt) {
        var isSelected = selectedMsg && selectedMsg.trim() === opt.trim();
        return '<span class="option-chip' + (isSelected ? ' option-chip-selected' : '') + '">' +
            (isSelected ? ICONS.send + ' ' : '') + esc(opt) + '</span>';
    }).join('');
    return '<div class="msg-option-chips"><span class="msg-option-chips-label">' + esc(t('chat.optionsOffered')) + '</span>' + chips + '</div>';
}
function renderChatMessages() {
    var html = '';
    sessionTimeline.forEach(function (item) {
        var selectedMsg = (item.resolution === 'message') ? item.userMessage : null;
        html += '<div class="msg msg-agent">' +
            '<div class="msg-label"><span class="badge badge-agent">' + t('chat.agent') + '</span>' +
            (item.agentName ? ' <span class="agent-name-badge">' + esc(item.agentName) + '</span>' : '') +
            ' ' + esc(formatTime(item.createdAt)) + '</div>' +
            buildContextHtml(item.context || '') +
            (item.question ? '<div class="msg-question md-content">' + microMd(item.question) + '</div>' : '') +
            buildOptionChipsHtml(item.options, selectedMsg) +
            '</div>';
        if (item.resolution === 'message' && item.userMessage) {
            var isOption = item.options && item.options.some(function (o) { return o.trim() === item.userMessage.trim(); });
            html += '<div class="msg msg-user' + (isOption ? ' msg-user-option' : '') + '">' +
                '<div class="msg-label"><span class="badge badge-you">' + t('chat.you') + '</span> ' + esc(formatTime(item.resolvedAt)) + '</div>' +
                (isOption ? '<span class="selected-option-badge">' + ICONS.send + '</span> ' : '') +
                esc(item.userMessage) +
                '</div>';
        }
        else if (item.resolution === 'timeout') {
            html += '<div class="msg msg-system">' + ICONS.clock + ' ' + t('chat.timeout') + '</div>';
        }
        else if (item.resolution === 'canceled') {
            html += '<div class="msg msg-system">' + ICONS.xCircle + ' ' + t('chat.canceled') + '</div>';
        }
        else if (item.resolution === 'interrupted') {
            html += '<div class="msg msg-system">' + ICONS.loader + ' ' + t('chat.interrupted') + '</div>';
        }
    });
    sessionPendingWaits.forEach(function (pw, idx) {
        html += '<div class="msg msg-agent" data-wait-id="' + esc(pw.id) + '">' +
            '<div class="msg-label"><span class="badge badge-agent">' + t('chat.agent') + '</span>' +
            (pw.agentName ? ' <span class="agent-name-badge">' + esc(pw.agentName) + '</span>' : '') +
            ' ' + esc(formatTime(pw.createdAt)) + '</div>' +
            buildContextHtml(pw.context || '', pw.id) +
            (pw.question ? '<div class="msg-question md-content">' + microMd(pw.question) + '</div>' : '') +
            (pw.options && pw.options.length > 0 ? buildOptionChipsHtml(pw.options, null) : '') +
            '</div>';
        if (idx === 0) {
            html += '<div class="msg-pending">' + ICONS.loader + ' ' + t('chat.waitingReply') + '</div>';
        }
    });
    if (!html) {
        html = '<div class="msg msg-system">' + t('chat.noMessages') + '</div>';
    }
    $chatMessages.innerHTML = html;
    $chatMessages.scrollTop = $chatMessages.scrollHeight;
}
function renderInputArea() {
    var banner = document.getElementById('historyReadOnlyBanner');
    if (sessionPendingWaits.length === 0) {
        $chatInputArea.classList.add('hidden');
        if (banner) {
            if (selectedSessionId && sessionTimeline.length > 0) {
                banner.classList.remove('hidden');
                var sess = sessionMap.get(selectedSessionId);
                var meta = sess ? (sess.interactionCount + ' ' + t('sessions.interactions') + ' · ' + relativeTime(sess.lastActivity)) : '';
                var descEl = banner.querySelector('.hrb-desc');
                if (descEl)
                    descEl.textContent = t('history.readOnlyDesc') + (meta ? ' · ' + meta : '');
            }
            else {
                banner.classList.add('hidden');
            }
        }
        return;
    }
    if (banner)
        banner.classList.add('hidden');
    $chatInputArea.classList.remove('hidden');
    var pw = sessionPendingWaits[0];
    sessionPendingWait = pw;
    $pendingContext.textContent = pw.question || '';
    var multiHint = document.getElementById('multiWaitHint');
    if (multiHint) {
        if (sessionPendingWaits.length > 1) {
            multiHint.textContent = t('chat.multiWaitHint', { n: sessionPendingWaits.length });
            multiHint.classList.remove('hidden');
        }
        else {
            multiHint.classList.add('hidden');
        }
    }
    if (pw.options && pw.options.length > 0) {
        $quickReplyBar.innerHTML = '<span class="options-label">' + esc(t('chat.options')) + '</span>' +
            pw.options.map(function (opt) {
                return '<button class="option-btn" data-opt="' + esc(opt) + '">' + esc(opt) + '</button>';
            }).join('');
    }
    else {
        var templates = getTemplates();
        $quickReplyBar.innerHTML = templates.map(function (tpl) {
            return '<button class="quick-reply-btn" data-tpl="' + esc(tpl) + '">' + esc(tpl) + '</button>';
        }).join('');
    }
    var canWrite = currentRole === 'operator';
    $sendBtn.disabled = !canWrite;
    $cancelBtn.disabled = !canWrite;
    $replyInput.disabled = !canWrite;
    if (pw.expiresAt <= 0) {
        $extendBtn.classList.add('hidden');
    }
    else {
        $extendBtn.classList.remove('hidden');
        $extendBtn.disabled = !canWrite;
    }
}
var countdownTimer = null;
function startCountdown() {
    if (countdownTimer)
        clearInterval(countdownTimer);
    countdownTimer = setInterval(function () {
        if (!sessionPendingWait) {
            $waitCountdown.textContent = '';
            return;
        }
        if (sessionPendingWait.expiresAt <= 0) {
            $waitCountdown.textContent = t('chat.noTimeout');
            $waitCountdown.classList.remove('expired');
            return;
        }
        var remaining = Math.max(0, Math.floor((sessionPendingWait.expiresAt - Date.now()) / 1000));
        if (remaining <= 0) {
            $waitCountdown.textContent = t('chat.expired');
            $waitCountdown.classList.add('expired');
        }
        else {
            var min = Math.floor(remaining / 60);
            var sec = remaining % 60;
            $waitCountdown.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
            $waitCountdown.classList.remove('expired');
        }
    }, 1000);
}
startCountdown();
function showWelcome() {
    $welcomeView.classList.remove('hidden');
    $chatView.classList.add('hidden');
    $settingsView.classList.add('hidden');
}
function showChat() {
    $welcomeView.classList.add('hidden');
    $chatView.classList.remove('hidden');
    $settingsView.classList.add('hidden');
}
function showSettings() {
    $settingsView.classList.remove('hidden');
}
function hideSettings() {
    $settingsView.classList.add('hidden');
}
async function selectSession(sessionId) {
    selectedSessionId = sessionId;
    showChat();
    renderSessionList();
    $chatSessionId.textContent = sessionId;
    renderSessionNameInHeader(sessionId);
    var session = sessionMap.get(sessionId);
    var pendingCount = session ? (session.pendingWaits || []).length : 0;
    var meta = session ? (session.interactionCount + ' ' + t('sessions.interactions')) : '';
    if (session && session.status === 'pending') {
        meta = (pendingCount > 1 ? pendingCount + ' ' + t('sessions.waitingMulti') : t('sessions.waiting')) +
            (session.interactionCount > 0 ? ' · ' + session.interactionCount + ' ' + t('sessions.prior') : '');
    }
    $chatSessionMeta.textContent = meta;
    $chatMessages.innerHTML = '<div class="msg msg-system">' + t('chat.loading') + '</div>';
    await loadSessionChat(sessionId);
    renderChatMessages();
    renderInputArea();
}
async function initialLoad() {
    try {
        await loadSessions();
        renderSessionList();
        if (!selectedSessionId && sessionMap.size > 0) {
            var arr = sessionsArray();
            var activeSession = arr.find(function (s) { return s.status === 'pending'; });
            if (activeSession) {
                await selectSession(activeSession.sessionId);
                return;
            }
        }
        if (selectedSessionId) {
            if (!sessionMap.has(selectedSessionId)) {
                selectedSessionId = null;
                showWelcome();
                return;
            }
            await loadSessionChat(selectedSessionId);
            renderChatMessages();
            renderInputArea();
        }
        if (sessionMap.size === 0 && !selectedSessionId) {
            showWelcome();
        }
    }
    catch (e) {
    }
}
async function fallbackPoll() {
    try {
        await loadSessions();
        renderSessionList();
        if (selectedSessionId && !sessionMap.has(selectedSessionId)) {
            selectedSessionId = null;
            showWelcome();
        }
    }
    catch (e) { }
}
async function sendReply() {
    if (sessionPendingWaits.length === 0)
        return;
    var message = ($replyInput.value || '').trim();
    if (!message) {
        showErrorToast(t('chat.emptyReply'));
        return;
    }
    var waitSnapshot = sessionPendingWaits[0];
    try {
        await apiRequest('/api/waits/' + encodeURIComponent(waitSnapshot.id) + '/respond', 'POST', { message: message });
        $replyInput.value = '';
        var optimisticItem = {
            id: waitSnapshot.id,
            sessionId: waitSnapshot.sessionId,
            context: waitSnapshot.context || '',
            question: waitSnapshot.question,
            createdAt: waitSnapshot.createdAt,
            expiresAt: waitSnapshot.expiresAt,
            resolvedAt: Date.now(),
            resolution: 'message',
            userMessage: message,
            finalMessageLength: message.length,
        };
        sessionTimeline = sessionTimeline.concat([optimisticItem]);
        sessionPendingWaits = sessionPendingWaits.filter(function (w) { return w.id !== waitSnapshot.id; });
        sessionPendingWait = sessionPendingWaits[0] || null;
        renderChatMessages();
        renderInputArea();
    }
    catch (e) {
        showErrorToast(e.message);
    }
}
async function extendWait() {
    if (sessionPendingWaits.length === 0)
        return;
    var pw = sessionPendingWaits[0];
    try {
        var extResult = await apiRequest('/api/waits/' + encodeURIComponent(pw.id) + '/extend', 'POST', { seconds: 300 });
        if (extResult && extResult.newExpiresAt) {
            sessionPendingWaits[0].expiresAt = extResult.newExpiresAt;
            sessionPendingWait = sessionPendingWaits[0];
            renderInputArea();
        }
    }
    catch (e) {
        showErrorToast(e.message);
    }
}
async function cancelWait() {
    if (sessionPendingWaits.length === 0)
        return;
    var pw = sessionPendingWaits[0];
    showConfirm(t('chat.confirmCancel'), async function () {
        try {
            await apiRequest('/api/waits/' + encodeURIComponent(pw.id) + '/cancel', 'POST');
            sessionPendingWaits = sessionPendingWaits.filter(function (w) { return w.id !== pw.id; });
            sessionPendingWait = sessionPendingWaits[0] || null;
            renderChatMessages();
            renderInputArea();
        }
        catch (e) {
            showErrorToast(e.message);
        }
    });
}
$sessionList.addEventListener('click', function (e) {
    var item = e.target.closest('.session-item');
    if (!item)
        return;
    var sid = item.getAttribute('data-session-id');
    if (sid)
        selectSession(sid);
});
$sendBtn.addEventListener('click', function () { sendReply(); });
$extendBtn.addEventListener('click', function () { extendWait(); });
$cancelBtn.addEventListener('click', function () { cancelWait(); });
$replyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendReply();
    }
});
$quickReplyBar.addEventListener('click', function (e) {
    var optBtn = e.target.closest('.option-btn');
    if (optBtn) {
        var opt = optBtn.getAttribute('data-opt');
        if (!opt)
            return;
        var allOpts = $quickReplyBar.querySelectorAll('.option-btn');
        allOpts.forEach(function (b) {
            b.disabled = true;
            if (b === optBtn) {
                b.classList.add('option-btn-loading');
                b.innerHTML = ICONS.loader + ' ' + esc(opt);
            }
            else {
                b.style.opacity = '0.3';
            }
        });
        $replyInput.value = opt;
        sendReply().catch(function () {
            allOpts.forEach(function (b) { b.disabled = false; b.style.opacity = ''; });
            renderInputArea();
        });
        return;
    }
    var btn = e.target.closest('.quick-reply-btn');
    if (!btn)
        return;
    var tpl = btn.getAttribute('data-tpl');
    if (tpl) {
        $replyInput.value = tpl;
        $replyInput.focus();
    }
});
document.getElementById('editNameBtn')?.addEventListener('click', function () {
    if (selectedSessionId)
        startEditSessionName(selectedSessionId);
});
document.getElementById('backBtn').addEventListener('click', function () {
    selectedSessionId = null;
    showWelcome();
    renderSessionList();
    var sidebar = document.getElementById('sidebar');
    if (sidebar)
        sidebar.classList.remove('sidebar-hidden');
});
document.getElementById('settingsToggleBtn').addEventListener('click', function () {
    if ($settingsView.classList.contains('hidden'))
        showSettings();
    else
        hideSettings();
});
document.getElementById('closeSettingsBtn').addEventListener('click', function () { hideSettings(); });
document.getElementById('saveApiKeyBtn').addEventListener('click', function () {
    apiKey = ($apiKeyInput.value || '').trim();
    if (apiKey)
        localStorage.setItem(API_KEY_STORAGE, apiKey);
    else
        localStorage.removeItem(API_KEY_STORAGE);
    syncApiKeyCookie();
    if ($authHint)
        $authHint.textContent = apiKey ? t('auth.saved') : t('auth.enterKey');
    initialLoad();
    connectSSE();
});
document.getElementById('clearApiKeyBtn').addEventListener('click', function () {
    apiKey = '';
    $apiKeyInput.value = '';
    localStorage.removeItem(API_KEY_STORAGE);
    syncApiKeyCookie();
    if ($authHint)
        $authHint.textContent = t('auth.cleared');
    currentRole = 'none';
    initialLoad();
    connectSSE();
});
document.getElementById('notifToggleBtn').addEventListener('click', function () {
    notifSettings.desktop = !notifSettings.desktop;
    try {
        localStorage.setItem(NOTIF_STORAGE, JSON.stringify(notifSettings));
    }
    catch (e) { }
    updateNotifButtons();
    if (notifSettings.desktop && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(function () { });
    }
});
document.getElementById('soundToggleBtn').addEventListener('click', function () {
    notifSettings.sound = !notifSettings.sound;
    try {
        localStorage.setItem(NOTIF_STORAGE, JSON.stringify(notifSettings));
    }
    catch (e) { }
    updateNotifButtons();
});
function updateTimeoutHint() {
    var $hint = document.getElementById('timeoutHint');
    if ($hint)
        $hint.textContent = serverTimeoutEnabled ? t('settings.timeoutOn') : t('settings.timeoutOff');
}
document.getElementById('timeoutToggle').addEventListener('change', async function () {
    var enabled = this.checked;
    try {
        await apiRequest('/api/settings', 'POST', { timeoutEnabled: enabled });
        serverTimeoutEnabled = enabled;
    }
    catch (e) {
        this.checked = !enabled;
    }
    updateTimeoutHint();
});
document.getElementById('langToggleBtn').addEventListener('click', function () {
    if (typeof i18n === 'undefined')
        return;
    var next = i18n.getLang() === 'en' ? 'zh' : 'en';
    i18n.setLang(next);
    t = i18n.t;
    updateLangButton();
    applyStaticI18n();
    replyTemplates = null;
    updateTimeoutHint();
    renderTemplateManager();
    if (_mcpUrl)
        renderSetupGuide(_mcpUrl, _hasAuth);
    if (Object.keys(acStatus).length > 0)
        acRenderClientList();
    renderSessionList();
    if (selectedSessionId) {
        renderChatMessages();
        renderInputArea();
    }
    initialLoad();
});
function renderTemplateManager() {
    var container = document.getElementById('templateManager');
    if (!container)
        return;
    var templates = getTemplates();
    var html = '<div class="template-list">';
    templates.forEach(function (tpl, idx) {
        html += '<div class="template-list-item">' +
            '<span>' + esc(tpl) + '</span>' +
            '<button class="btn-sm warning" data-tpl-delete="' + idx + '">' + t('btn.delete') + '</button>' +
            '</div>';
    });
    html += '</div>' +
        '<div class="settings-row" style="margin-top:8px">' +
        '<input id="newTplInput" class="text-input" type="text" placeholder="' + esc(t('ph.newTemplate')) + '" />' +
        '<button id="addTplBtn" class="btn primary">' + t('btn.add') + '</button>' +
        '<button id="resetTplBtn" class="btn secondary">' + t('btn.resetDefault') + '</button>' +
        '</div>';
    container.innerHTML = html;
}
document.getElementById('templateManager')?.addEventListener('click', function (e) {
    var target = e.target;
    if (!(target instanceof HTMLElement))
        return;
    var delIdx = target.getAttribute('data-tpl-delete');
    if (delIdx !== null) {
        var templates = getTemplates().slice();
        templates.splice(Number(delIdx), 1);
        replyTemplates = templates;
        saveTemplates();
        renderTemplateManager();
        return;
    }
    if (target.id === 'addTplBtn') {
        var input = document.getElementById('newTplInput');
        var val = (input && input.value || '').trim();
        if (val) {
            replyTemplates = getTemplates().slice();
            if (!replyTemplates.includes(val))
                replyTemplates.push(val);
            saveTemplates();
            renderTemplateManager();
        }
        if (input)
            input.value = '';
        return;
    }
    if (target.id === 'resetTplBtn') {
        replyTemplates = null;
        try {
            localStorage.removeItem(TEMPLATES_STORAGE);
        }
        catch (e) { }
        renderTemplateManager();
        return;
    }
});
function buildGuideHtml(url, hasAuth) {
    var windsurfSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { serverUrl: url } } }, null, 2);
    var cursorSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: url } } }, null, 2);
    var claudeSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: url } } }, null, 2);
    var vscodeSnippet = JSON.stringify({ servers: { 'turn-mcp-web': { type: 'http', url: url } } }, null, 2);
    var antigravSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: url } } }, null, 2);
    var claudeCodeCmd = 'claude mcp add --transport http turn-mcp-web ' + url;
    var opencodeSnippet = JSON.stringify({ '$schema': 'https://opencode.ai/config.json', mcp: { 'turn-mcp-web': { type: 'remote', url: url, enabled: true } } }, null, 2);
    var openclawSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { type: 'http', url: url } } }, null, 2);
    var warpSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: url } } }, null, 2);
    function block(title, desc, code, isCmd) {
        var inner = isCmd ? codeWrap('<pre><code>' + esc(code) + '</code></pre>') : codeWrap('<pre>' + esc(code) + '</pre>');
        return '<div class="guide-block"><h5>' + title + '</h5><p>' + desc + '</p>' + inner + '</div>';
    }
    var html = '<h4>' + t('tutorial.heading') + '</h4>' +
        '<p>' + t('tutorial.intro') + '</p>' +
        '<div class="guide-cols">' +
        block('Windsurf', t('tutorial.editWindsurf'), windsurfSnippet) +
        block('Cursor', t('tutorial.editCursor'), cursorSnippet) +
        block('Claude Desktop', t('tutorial.editClaude'), claudeSnippet) +
        block('VS Code', t('tutorial.editVSCode'), vscodeSnippet) +
        block('Antigravity', t('tutorial.editAntiGravity'), antigravSnippet) +
        '</div>' +
        '<h4>' + t('tutorial.headingCli') + '</h4>' +
        '<div class="guide-cols">' +
        block('Claude Code', t('tutorial.editClaudeCode'), claudeCodeCmd, true) +
        block('OpenCode', t('tutorial.editOpenCode'), opencodeSnippet) +
        block('Warp', t('tutorial.editWarp'), warpSnippet) +
        block('OpenClaw', t('tutorial.editOpenClaw'), openclawSnippet) +
        '</div>';
    if (hasAuth) {
        var authSnippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: url, headers: { 'x-turn-mcp-api-key': '<YOUR_API_KEY>' } } } }, null, 2);
        html += '<h5>' + t('tutorial.authHeading') + '</h5><p>' + t('tutorial.authIntro') + '</p>' + codeWrap('<pre>' + esc(authSnippet) + '</pre>');
    }
    html += '<h5>' + t('tutorial.notesHeading') + '</h5><ul>' +
        '<li>' + t('tutorial.note1') + '</li>' +
        '<li>' + t('tutorial.note2') + '</li>' +
        '<li>' + t('tutorial.note3') + '</li></ul>';
    return html;
}
function renderSetupGuide(url, hasAuth) {
    var html = buildGuideHtml(url, hasAuth);
    if ($setupGuideContent)
        $setupGuideContent.innerHTML = html;
    var $settingsGuide = document.getElementById('settingsGuideContent');
    var $settingsMcpUrl = document.getElementById('settingsMcpUrl');
    if ($settingsGuide)
        $settingsGuide.innerHTML = html;
    if ($settingsMcpUrl)
        $settingsMcpUrl.textContent = url;
}
var pollTimer = null;
function adjustPolling(fast) {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = setInterval(fallbackPoll, fast ? FALLBACK_POLL_INTERVAL : REFRESH_INTERVAL);
}
var sseSource = null;
function connectSSE() {
    if (typeof EventSource === 'undefined')
        return;
    syncApiKeyCookie();
    if (sseSource) {
        sseSource.onerror = null;
        sseSource.close();
        sseSource = null;
    }
    var source = new EventSource('/api/stream');
    sseSource = source;
    source.onopen = function () {
        sseReconnectDelay = SSE_BACKOFF_BASE;
        if (sseEverConnected) {
            initialLoad();
        }
        sseEverConnected = true;
        sseConnected = true;
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        updateConnStatus('live');
    };
    source.addEventListener('wait_created', function (evt) {
        var data = null;
        try {
            data = JSON.parse(evt.data);
        }
        catch (e) { }
        if (!data || !data.sessionId)
            return;
        onNewWaitCreated(data);
        var newWait = {
            id: data.waitId,
            sessionId: data.sessionId,
            context: data.context || '',
            question: data.question,
            options: data.options || null,
            agentName: data.agentName || null,
            createdAt: data.createdAt,
            expiresAt: data.expiresAt,
        };
        var entry = sessionMap.get(data.sessionId) || {
            sessionId: data.sessionId, status: 'completed', lastActivity: 0,
            pendingWaits: [], pendingWait: null, interactionCount: 0
        };
        entry.status = 'pending';
        entry.pendingWaits = entry.pendingWaits || [];
        if (!entry.pendingWaits.some(function (w) { return w.id === newWait.id; })) {
            entry.pendingWaits.push(newWait);
        }
        entry.pendingWait = entry.pendingWaits[0];
        entry.lastActivity = Math.max(entry.lastActivity || 0, data.createdAt);
        sessionMap.set(data.sessionId, entry);
        renderSessionList();
        if (!selectedSessionId) {
            selectSession(data.sessionId);
            return;
        }
        if (selectedSessionId === data.sessionId) {
            if (!sessionPendingWaits.some(function (w) { return w.id === newWait.id; })) {
                sessionPendingWaits.push(newWait);
                sessionPendingWait = sessionPendingWaits[0];
            }
            renderChatMessages();
            renderInputArea();
        }
    });
    source.addEventListener('wait_resolved', function (evt) {
        var data = null;
        try {
            data = JSON.parse(evt.data);
        }
        catch (e) { }
        if (!data || !data.sessionId)
            return;
        var entry = sessionMap.get(data.sessionId);
        if (entry) {
            entry.pendingWaits = (entry.pendingWaits || []).filter(function (w) { return w.id !== data.waitId; });
            entry.pendingWait = entry.pendingWaits[0] || null;
            if (entry.pendingWaits.length === 0)
                entry.status = data.resolution || 'completed';
            entry.interactionCount = (entry.interactionCount || 0) + 1;
            sessionMap.set(data.sessionId, entry);
        }
        timelineCache.delete(data.sessionId);
        renderSessionList();
        if (selectedSessionId === data.sessionId) {
            sessionPendingWaits = sessionPendingWaits.filter(function (w) { return w.id !== data.waitId; });
            sessionPendingWait = sessionPendingWaits[0] || null;
            apiRequest('/api/history/timeline?sessionId=' + encodeURIComponent(data.sessionId))
                .then(function (res) {
                sessionTimeline = res.timeline || [];
                timelineCache.set(data.sessionId, sessionTimeline);
                renderChatMessages();
                renderInputArea();
            })
                .catch(function () { });
        }
    });
    source.addEventListener('wait_extended', function (evt) {
        var data = null;
        try {
            data = JSON.parse(evt.data);
        }
        catch (e) { }
        if (!data || !data.sessionId)
            return;
        if (selectedSessionId === data.sessionId && sessionPendingWait) {
            sessionPendingWait.expiresAt = data.newExpiresAt;
            renderInputArea();
        }
    });
    source.onerror = function () {
        sseConnected = false;
        updateConnStatus('polling');
        source.close();
        if (sseReconnectTimer)
            clearTimeout(sseReconnectTimer);
        sseReconnectTimer = setTimeout(function () {
            sseReconnectDelay = Math.min(sseReconnectDelay * 2, SSE_BACKOFF_MAX);
            connectSSE();
        }, sseReconnectDelay);
        adjustPolling(true);
    };
}
async function cancelAllWaits() {
    try {
        var result = await apiRequest('/api/waits/cancel-all', 'POST');
        if (result && result.canceled > 0) {
            await initialLoad();
        }
    }
    catch (e) {
        showErrorToast(e.message);
    }
}
document.getElementById('cancelAllBtn').addEventListener('click', function () {
    cancelAllWaits();
});
if ($sessionFilter) {
    $sessionFilter.addEventListener('input', function () { renderSessionList(); });
}
document.getElementById('saveWebhookBtn')?.addEventListener('click', async function () {
    var url = ($webhookUrlInput ? $webhookUrlInput.value.trim() : '');
    try {
        await apiRequest('/api/settings', 'POST', { webhookUrl: url });
        webhookUrl = url;
    }
    catch (e) {
        showErrorToast(e.message);
    }
});
document.getElementById('clearWebhookBtn')?.addEventListener('click', async function () {
    try {
        await apiRequest('/api/settings', 'POST', { webhookUrl: '' });
        webhookUrl = '';
        if ($webhookUrlInput)
            $webhookUrlInput.value = '';
    }
    catch (e) {
        showErrorToast(e.message);
    }
});
var acStatus = {};
var acServerUrl = '';
var AC_CLIENTS = [
    { id: 'windsurf', label: 'Windsurf' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'claude-desktop', label: 'Claude Desktop' },
    { id: 'vscode', label: 'VS Code' },
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'claude-code', label: 'Claude Code' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'openclaw', label: 'OpenClaw' },
];
async function acLoadStatus() {
    try {
        var data = await apiRequest('/api/auto-configure-status');
        acStatus = data.status || {};
        acServerUrl = data.serverUrl || '';
        acRenderClientList();
        acRenderGenericSnippet();
    }
    catch (e) {
        showErrorToast(e.message);
    }
}
function acStatusBadge(status) {
    if (status === 'configured')
        return '<span class="ac-badge ac-badge-ok">' + esc(t('ac.statusOk')) + '</span>';
    if (status === 'not-configured')
        return '<span class="ac-badge ac-badge-no">' + esc(t('ac.statusNo')) + '</span>';
    return '<span class="ac-badge ac-badge-na">' + esc(t('ac.statusNa')) + '</span>';
}
function acRenderClientList() {
    var el = document.getElementById('acClientList');
    if (!el)
        return;
    el.innerHTML = AC_CLIENTS.map(function (c) {
        var s = acStatus[c.id] || 'not-found';
        return '<div class="ac-client-item">' +
            '<span class="ac-client-name">' + esc(c.label) + '</span>' +
            acStatusBadge(s) +
            (s !== 'configured' ?
                '<button class="btn-sm primary ac-configure-btn" data-target="' + esc(c.id) + '">' + esc(t('ac.configure')) + '</button>' :
                '<span class="ac-done-label">' + ICONS.send + '</span>' +
                    '<button class="btn-sm warning ac-clear-btn" data-target="' + esc(c.id) + '">' + esc(t('ac.clear')) + '</button>') +
            '</div>';
    }).join('');
}
function acRenderGenericSnippet() {
    var el = document.getElementById('acGenericSnippet');
    if (!el || !acServerUrl)
        return;
    var snippet = JSON.stringify({ mcpServers: { 'turn-mcp-web': { url: acServerUrl } } }, null, 2);
    el.innerHTML = codeWrap('<pre>' + esc(snippet) + '</pre>');
}
async function acUnconfigureTargets(targets) {
    try {
        var data = await apiRequest('/api/auto-unconfigure', 'POST', { targets: targets });
        var results = data.results || [];
        results.forEach(function (r) {
            if (r.action !== 'error')
                acStatus[r.target] = 'not-configured';
        });
        acRenderClientList();
        var ok = results.filter(function (r) { return r.action !== 'error' && r.action !== 'not-configured' && r.action !== 'not-found'; });
        var err = results.filter(function (r) { return r.action === 'error'; });
        if (ok.length > 0) {
            showToast(t('ac.clearTitle'), ok.map(function (r) { return r.name; }).join(', '), null);
        }
        err.forEach(function (r) { showErrorToast(r.name + ': ' + r.error); });
        return results;
    }
    catch (e) {
        showErrorToast(e.message);
        return [];
    }
}
async function acConfigureTargets(targets) {
    try {
        var data = await apiRequest('/api/auto-configure', 'POST', { targets: targets });
        var results = data.results || [];
        results.forEach(function (r) {
            acStatus[r.target] = r.action === 'error' ? 'not-configured' : 'configured';
        });
        acRenderClientList();
        var ok = results.filter(function (r) { return r.action !== 'error'; });
        var err = results.filter(function (r) { return r.action === 'error'; });
        if (ok.length > 0) {
            showToast(t('ac.successTitle'), ok.map(function (r) { return r.name + ' → ' + r.displayPath; }).join(', '), null);
        }
        err.forEach(function (r) { showErrorToast(r.name + ': ' + r.error); });
        return results;
    }
    catch (e) {
        showErrorToast(e.message);
        return [];
    }
}
document.querySelectorAll('.ac-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-mode');
        document.querySelectorAll('.ac-tab').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        ['acTargeted', 'acGeneric', 'acSystem'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el)
                el.classList.add('hidden');
        });
        var panel = document.getElementById(mode === 'targeted' ? 'acTargeted' : mode === 'generic' ? 'acGeneric' : 'acSystem');
        if (panel)
            panel.classList.remove('hidden');
        if (mode !== 'targeted')
            return;
        if (Object.keys(acStatus).length === 0)
            acLoadStatus();
    });
});
document.getElementById('acConfigAllBtn')?.addEventListener('click', async function () {
    var notConfigured = AC_CLIENTS
        .filter(function (c) { return acStatus[c.id] !== 'configured'; })
        .map(function (c) { return c.id; });
    if (notConfigured.length === 0) {
        showToast(t('ac.successTitle'), t('ac.allAlready'), null);
        return;
    }
    await acConfigureTargets(notConfigured);
});
document.getElementById('acClearAllBtn')?.addEventListener('click', async function () {
    var configured = AC_CLIENTS
        .filter(function (c) { return acStatus[c.id] === 'configured'; })
        .map(function (c) { return c.id; });
    if (configured.length === 0) {
        showToast(t('ac.clearTitle'), t('ac.noneConfigured'), null);
        return;
    }
    await acUnconfigureTargets(configured);
});
document.getElementById('acRefreshBtn')?.addEventListener('click', function () { acLoadStatus(); });
document.getElementById('acClientList')?.addEventListener('click', async function (e) {
    var configBtn = e.target.closest('.ac-configure-btn');
    if (configBtn) {
        var target = configBtn.getAttribute('data-target');
        if (!target)
            return;
        configBtn.disabled = true;
        configBtn.textContent = t('ac.configuring');
        await acConfigureTargets([target]);
        return;
    }
    var clearBtn = e.target.closest('.ac-clear-btn');
    if (clearBtn) {
        var target2 = clearBtn.getAttribute('data-target');
        if (!target2)
            return;
        clearBtn.disabled = true;
        clearBtn.textContent = t('ac.clearing');
        await acUnconfigureTargets([target2]);
    }
});
function acUpdateGenericResult(results) {
    var resultEl = document.getElementById('acGenericResult');
    if (!resultEl || !results.length)
        return;
    var r = results[0];
    resultEl.textContent = r.action === 'error'
        ? t('ac.errorMsg', { msg: r.error })
        : t('ac.writtenTo', { path: r.displayPath });
    resultEl.className = 'ac-result-msg ' + (r.action === 'error' ? 'ac-result-err' : 'ac-result-ok');
}
document.getElementById('acWriteGenericBtn')?.addEventListener('click', async function () {
    var results = await acConfigureTargets(['system-mcp']);
    acUpdateGenericResult(results);
});
document.getElementById('acClearGenericBtn')?.addEventListener('click', async function () {
    var results = await acUnconfigureTargets(['system-mcp']);
    acUpdateGenericResult(results);
});
document.getElementById('acConfigSystemBtn')?.addEventListener('click', async function () {
    var results = await acConfigureTargets(['system-mcp']);
    acRenderSystemResults(results);
});
document.getElementById('acClearSystemBtn')?.addEventListener('click', async function () {
    var results = await acUnconfigureTargets(['system-mcp']);
    acRenderSystemResults(results);
});
document.addEventListener('click', function (e) {
    var copyBtn = e.target.closest && e.target.closest('.copy-btn');
    if (copyBtn) {
        copyCode(copyBtn);
        return;
    }
    var actionBtn = e.target.closest && e.target.closest('[data-action]');
    if (!actionBtn)
        return;
    var action = actionBtn.getAttribute('data-action');
    if (action === 'toggle-expand')
        toggleExpand(actionBtn);
    else if (action === 'load-full')
        loadFullContext(actionBtn, actionBtn.getAttribute('data-wait-id') || '');
});
function acRenderSystemResults(results) {
    var listEl = document.getElementById('acSystemResults');
    if (!listEl)
        return;
    listEl.innerHTML = results.map(function (r) {
        var cls = r.action === 'error' ? 'ac-result-err' : 'ac-result-ok';
        var msg = r.action === 'error' ? r.error : r.displayPath + ' (' + t('ac.action_' + r.action, {}) + ')';
        return '<div class="ac-result-item ' + cls + '">' + esc(r.name) + ': ' + esc(msg) + '</div>';
    }).join('');
    listEl.classList.remove('hidden');
}
document.getElementById('settingsToggleBtn').addEventListener('click', function () {
    if (Object.keys(acStatus).length === 0)
        acLoadStatus();
}, true);
$apiKeyInput.value = apiKey;
renderTemplateManager();
function showLangPicker() {
    var modal = document.getElementById('langPickerModal');
    if (modal)
        modal.classList.remove('hidden');
}
function hideLangPicker(afterFn) {
    var modal = document.getElementById('langPickerModal');
    if (!modal) {
        if (afterFn)
            afterFn();
        return;
    }
    modal.classList.add('lang-picker-exit');
    setTimeout(function () {
        modal.classList.add('hidden');
        modal.classList.remove('lang-picker-exit');
        if (afterFn)
            afterFn();
    }, 260);
}
document.querySelectorAll('.lang-pick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        var lang = btn.getAttribute('data-lang');
        i18n.setLang(lang);
        t = i18n.t;
        applyStaticI18n();
        updateLangButton();
        updateNotifButtons();
        updateTimeoutHint();
        renderTemplateManager();
        if (_mcpUrl)
            renderSetupGuide(_mcpUrl, _hasAuth);
        hideLangPicker(function () {
            connectSSE();
        });
    });
});
loadPublicConfig()
    .then(function () { return initialLoad(); })
    .then(function () {
    document.body.classList.remove('not-ready');
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('loaded');
        setTimeout(function () { if (overlay.parentNode)
            overlay.parentNode.removeChild(overlay); }, 800);
    }
    if (typeof i18n !== 'undefined' && !i18n.hasExplicitSelection()) {
        showLangPicker();
    }
    else {
        connectSSE();
    }
})
    .catch(function () {
    document.body.classList.remove('not-ready');
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('loaded');
        setTimeout(function () { if (overlay.parentNode)
            overlay.parentNode.removeChild(overlay); }, 800);
    }
    updateConnStatus('disconnected');
    if (typeof i18n !== 'undefined' && !i18n.hasExplicitSelection()) {
        showLangPicker();
    }
});
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () { });
}
