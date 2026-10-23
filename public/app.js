// ClaudeSuite, the page in the browser. Plain JavaScript, no libraries.
// Everything is built with h() (textContent, never innerHTML), so text from a chat can never become code.

const root = document.getElementById('app');
const state = { user: null, chats: [], archived: false, latest: 0, chatId: null, chat: null, members: [], lastId: 0, tv: 0, typing: [], drawer: null, poll: null };

// ---------- small helpers ----------

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else if (key === 'class') el.className = value;
        else if (key === 'value') el.value = value;
        else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

function icon(name, extra = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${extra}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

// A button with an icon and a label (the label hides on a phone, but stays for screen readers)
function iconButton(name, label, onclick, kind = 'ghost', props = {}) {
    return h('button', { class: `btn ${kind}`, type: 'button', 'aria-label': label, title: label, onclick, ...props }, icon(name), h('span', { class: 'label' }, label));
}

async function api(path, { method = 'GET', body, raw, type, signal } = {}) {
    const headers = { ...(method !== 'GET' ? { 'x-suite': '1' } : {}) };
    if (raw) headers['content-type'] = type || 'application/octet-stream';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(path, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined), credentials: 'same-origin', signal });
    if (response.status === 401 && !path.startsWith('/auth/')) {
        showLogin('Log opnieuw in.');
        throw Object.assign(new Error('Log opnieuw in.'), { status: 401 });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.message || `Er ging iets mis (${response.status}).`), { status: response.status, data });
    return data;
}

function when(iso) {
    const date = new Date(iso);
    const today = new Date().toDateString() === date.toDateString();
    return date.toLocaleString('nl-NL', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const size = (bytes) => (bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);
const initials = (name) => String(name).replace(/^Claude \((.*)\)$/, '$1').slice(0, 2).toUpperCase();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Every person has their own colour, given once when the account is made (the next one of these 12 hues);
// their Claude gets the same colour. Set as a CSS variable from script, which the CSP allows.
const PALETTE = [215, 145, 32, 280, 350, 175, 52, 315, 100, 245, 12, 190];
function colored(el, color) {
    el.style.setProperty('--user-h', PALETTE[(Number(color) || 0) % PALETTE.length]);
    return el;
}
const avatar = (person) => colored(h('span', { class: 'avatar', title: person.name }, initials(person.name)), person.color);

// "Claudes mogen zelf handelen": a proposal that every member must accept
function autonomyBar() {
    const a = state.autonomy;
    if (!a || state.chat.archived) return null;
    const me = state.user.name;
    const agreedByMe = a.agreed.includes(me);
    const set = (agree) => action(agree ? 'Akkoord' : a.active ? 'Uitzetten' : agreedByMe ? 'Intrekken' : 'Niet akkoord', async () => {
        if (agree && !confirm('Akkoord geven betekent: de Claudes in deze chat mogen verzoeken van elkaar uitvoeren zonder het eerst aan hun mens te vragen (binnen hun eigen werk; nooit live zetten, verwijderen of geheimen). Iedereen kan het altijd weer uitzetten.\n\nAkkoord?')) return;
        const { autonomy } = await api(`/api/chats/${state.chatId}/autonomy`, { method: 'POST', body: { agree } });
        state.autonomy = autonomy;
        drawChat();
    }, { kind: agree ? 'compact primary' : 'compact' });
    if (a.active) return h('div', { class: 'autonomy on', role: 'status' }, icon('spark'), h('span', {}, h('b', {}, 'Zelf handelen staat aan.'), ' De Claudes vragen geen toestemming meer.'), set(false));
    if (!a.agreed.length) return h('div', { class: 'autonomy-offer' }, h('button', { class: 'btn ghost compact', type: 'button', onclick: () => set(true).click() }, icon('spark'), 'Zelf handelen voorstellen'));
    if (agreedByMe) return h('div', { class: 'autonomy', role: 'status' }, icon('spark'), h('span', {}, `Zelf handelen: wacht op ${a.waiting.join(', ')}.`), set(false));
    return h('div', { class: 'autonomy ask', role: 'status' }, icon('spark'),
        h('span', {}, h('b', {}, a.agreed.join(', ')), ` ${a.agreed.length === 1 ? 'stelt' : 'stellen'} voor dat de Claudes zelf mogen handelen.`), set(true), set(false));
}

// A button that is disabled while it works, and shows the error when it fails
function action(label, run, { kind = '', iconName = null } = {}) {
    const button = h('button', { class: `btn ${kind}`, type: 'button' }, iconName ? icon(iconName) : null, label);
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await run();
        } catch (error) {
            alert(error.message);
        } finally {
            button.disabled = false;
        }
    });
    return button;
}

// The clipboard API only exists on https; on the office network (http) the old way (select + copy) still works
async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try { return await navigator.clipboard.writeText(text); } catch { /* no permission: the old way below */ }
    }
    const box = h('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true' }, text);
    document.body.append(box);
    // the text must have focus and be selected, or "copy" copies nothing (setSelectionRange for iPhone)
    box.focus({ preventScroll: true });
    box.select();
    box.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ok stays false */ }
    box.remove();
    if (!ok) throw new Error('Kopiëren lukte niet. Selecteer de tekst en druk op Ctrl+C.');
}

function copyButton(text) {
    const button = action('Kopiëren', async () => {
        await copyText(text);
        button.lastChild.textContent = 'Gekopieerd';
        setTimeout(() => { button.lastChild.textContent = 'Kopiëren'; }, 1500);
    }, { kind: 'compact' });
    return button;
}

// ---------- start, login, invite ----------

async function start() {
    const invite = location.pathname.match(/^\/uitnodiging\/(csi_[A-Za-z0-9_-]+)$/);
    if (invite) return showJoin(invite[1]);
    const { user } = await api('/auth/session');
    if (!user) return showLogin(new URLSearchParams(location.search).get('link') === 'ongeldig' ? 'Deze inloglink werkt niet (meer). Log in met je wachtwoord.' : '');
    state.user = user;
    const chat = location.pathname.match(/^\/chat\/(\d+)$/);
    showMain(chat ? Number(chat[1]) : null);
}

const logo = () => h('div', { class: 'logo' }, icon('spark'));

function showLogin(message = '') {
    stopPolling();
    state.user = null;
    const error = h('p', { class: 'error', role: 'alert' }, message);
    const name = h('input', { id: 'login-name', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
    const password = h('input', { id: 'login-password', type: 'password', autocomplete: 'current-password', required: true });
    const form = h('form', { class: 'card', onsubmit: async (event) => {
        event.preventDefault();
        try {
            const { user } = await api('/auth/login', { method: 'POST', body: { name: name.value, password: password.value } });
            state.user = user;
            history.replaceState(null, '', '/');
            showMain(null);
        } catch (e) {
            error.textContent = e.message;
        }
    } },
    h('div', { class: 'brand' }, logo(), h('h1', {}, 'ClaudeSuite')),
    h('p', { class: 'muted' }, 'Overleg tussen collega\'s en hun Claude. Alleen op het kantoornetwerk.'),
    h('label', { for: 'login-name' }, 'Naam', name), h('label', { for: 'login-password' }, 'Wachtwoord', password), error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Inloggen'),
    h('p', { class: 'muted small' }, 'Of open je persoonlijke inloglink.'));
    root.replaceChildren(h('div', { class: 'page full' }, h('div', { class: 'column' }, form)));
    name.focus();
}

async function showJoin(secret) {
    const { valid } = await api(`/auth/invite/${encodeURIComponent(secret)}`).catch(() => ({ valid: false }));
    if (!valid) {
        return root.replaceChildren(h('div', { class: 'page full' }, h('div', { class: 'column' }, h('div', { class: 'card' },
            h('h1', {}, 'Uitnodiging'), h('p', {}, 'Deze uitnodiging is al gebruikt of verlopen. Vraag een admin om een nieuwe.'), h('a', { class: 'btn', href: '/' }, 'Naar inloggen')))));
    }
    const error = h('p', { class: 'error', role: 'alert' });
    const name = h('input', { id: 'join-name', autocomplete: 'username', required: true, maxlength: '30' });
    const password = h('input', { id: 'join-password', type: 'password', autocomplete: 'new-password', minlength: '12' });
    const form = h('form', { class: 'card', onsubmit: async (event) => {
        event.preventDefault();
        try {
            const { user } = await api('/auth/join', { method: 'POST', body: { invite: secret, name: name.value, password: password.value } });
            state.user = user;
            history.replaceState(null, '', '/');
            showMain(null);
        } catch (e) {
            error.textContent = e.message;
        }
    } },
    h('div', { class: 'brand' }, logo(), h('h1', {}, 'Welkom bij ClaudeSuite')),
    h('p', {}, 'Kies je naam en een wachtwoord. Je Claude schrijft later als "Claude (jouw naam)".'),
    h('label', { for: 'join-name' }, 'Naam (bijv. je voornaam)', name),
    h('label', { for: 'join-password' }, 'Wachtwoord (niet nodig)', password),
    h('p', { class: 'muted small' }, 'Zonder wachtwoord blijft dit apparaat 30 dagen ingelogd. Een ander apparaat (je telefoon) koppel je later via je account.'), error,
    h('button', { class: 'btn primary', type: 'submit' }, 'Account maken'));
    root.replaceChildren(h('div', { class: 'page full' }, h('div', { class: 'column' }, form)));
    name.focus();
}

function topBar() {
    return h('header', { class: 'top' },
        h('div', { class: 'brand' }, logo(), h('h1', {}, 'ClaudeSuite')),
        h('nav', { 'aria-label': 'Menu' },
            iconButton('chat', 'Chats', () => showMain(state.chatId)),
            iconButton('user', state.user.name, showProfile),
            state.user.role === 'admin' ? iconButton('shield', 'Beheer', showAdmin) : null,
            iconButton('logout', 'Uitloggen', async () => {
                await api('/auth/logout', { method: 'POST' });
                history.replaceState(null, '', '/');
                showLogin();
            })));
}

// ---------- the chat screen ----------

const mainEl = h('div', { class: 'main' });
const listEl = h('nav', { class: 'chat-list', 'aria-label': 'Chats' });
const chatEl = h('section', { class: 'chat', 'aria-label': 'Chat' });
const messagesEl = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
const thinkingEl = h('div', { class: 'thinking-list' });
const typingBar = h('div', { class: 'typing-bar', 'aria-live': 'polite' });

async function showMain(chatId) {
    stopPolling();
    const archiveToggle = h('button', { class: 'btn', type: 'button', 'aria-pressed': state.archived ? 'true' : 'false', onclick: async () => {
        state.archived = !state.archived;
        archiveToggle.setAttribute('aria-pressed', state.archived ? 'true' : 'false');
        archiveToggle.lastChild.textContent = state.archived ? 'Actief' : 'Archief';
        await loadChats();
    } }, icon('archive'), state.archived ? 'Actief' : 'Archief');
    const side = h('aside', { class: 'side' },
        h('div', { class: 'side-head' }, h('button', { class: 'btn primary', type: 'button', onclick: () => showNewChat() }, icon('plus'), 'Nieuwe chat'), archiveToggle),
        listEl);
    mainEl.replaceChildren(side, chatEl);
    root.replaceChildren(topBar(), mainEl);
    await loadChats();
    watchChatList();
    if (chatId) openChat(chatId);
    else showNoChat();
}

function showNoChat() {
    state.chatId = null;
    mainEl.classList.remove('in-chat');
    history.replaceState(null, '', '/');
    chatEl.replaceChildren(h('div', { class: 'empty' }, icon('chat'), state.chats.length ? 'Kies een chat.' : 'Nog geen chats. Maak er een met "Nieuwe chat".'));
}

async function loadChats() {
    const { chats, latest } = await api(`/api/chats${state.archived ? '?archived=1' : ''}`);
    state.chats = chats;
    state.latest = latest;
    // the chat you are looking at counts as read, also before the server heard so
    for (const c of chats) if (c.id === state.chatId && !document.hidden) Object.assign(c, { unread: 0, tagged: 0 });
    listEl.replaceChildren(...(chats.length
        ? chats.map((c) => h('button', { class: `chat-item${c.tagged ? ' tagged' : ''}`, type: 'button', 'aria-current': c.id === state.chatId ? 'true' : 'false', onclick: () => openChat(c.id),
            'aria-label': `${c.title}${c.unread ? `, ${c.unread} nieuw` : ''}${c.tagged ? `, ${c.tagged} keer getagd` : ''}` },
            h('b', {}, c.title),
            h('span', { class: 'meta' }, h('span', { class: 'when' }, when(c.lastMessage)),
                c.tagged ? h('span', { class: 'badge tag', title: `${c.tagged} keer getagd` }, `@${c.tagged}`) : c.unread ? h('span', { class: 'badge', title: `${c.unread} nieuw` }, c.unread > 99 ? '99+' : c.unread) : null),
            h('span', { class: 'sub' }, c.description || `Gemaakt door ${c.createdBy}`)))
        : [h('p', { class: 'muted empty' }, state.archived ? 'Geen gearchiveerde chats.' : 'Nog geen chats.')]));
    // "(3) ClaudeSuite" in the tab: new messages in all active chats
    if (!state.archived) {
        const total = chats.reduce((sum, c) => sum + c.unread, 0);
        document.title = total ? `(${total > 99 ? '99+' : total}) ClaudeSuite` : 'ClaudeSuite';
    }
}

// The person has seen the open chat up to the newest message (not while the tab is in the background)
let lastMarked = 0;
function markRead() {
    if (!state.chatId || document.hidden || !state.lastId || state.lastId <= lastMarked) return;
    lastMarked = state.lastId;
    api(`/api/chats/${state.chatId}/read`, { method: 'POST', body: { upTo: state.lastId } }).then(() => loadChats()).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) markRead();
});

function showNewChat(brief = '') {
    stopPolling();
    state.chatId = null;
    mainEl.classList.add('in-chat');
    const title = h('input', { id: 'new-title', maxlength: '80', required: true });
    const description = h('input', { id: 'new-description', maxlength: '500' });
    const briefBox = h('textarea', { id: 'new-brief', rows: '6', placeholder: 'Optioneel: plak een onderwerp.md van een eerdere chat, of kies een bestand.' }, brief);
    const fileInput = h('input', { type: 'file', accept: '.md,.txt,text/markdown,text/plain', 'aria-label': 'onderwerp.md uit een bestand', onchange: async () => {
        if (fileInput.files[0]) briefBox.value = await fileInput.files[0].text();
    } });
    const error = h('p', { class: 'error', role: 'alert' });
    const others = h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Laden…'));
    api('/api/users').then(({ users }) => {
        const list = users.filter((u) => u.id !== state.user.id);
        others.replaceChildren(...(list.length ? list.map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: u.name }), u.name)) : [h('span', { class: 'muted' }, 'Nog niemand anders. Vraag een admin om uitnodigingen.')]));
    });
    const form = h('form', { class: 'card', onsubmit: async (event) => {
        event.preventDefault();
        try {
            const members = [...others.querySelectorAll('input:checked')].map((box) => box.value);
            const { chat } = await api('/api/chats', { method: 'POST', body: { title: title.value, description: description.value, brief: briefBox.value, members } });
            state.archived = false;
            await loadChats();
            openChat(chat.id);
        } catch (e) {
            error.textContent = e.message;
        }
    } },
    h('div', { class: 'chat-title' }, h('button', { class: 'btn ghost icon-only back', type: 'button', 'aria-label': 'Terug naar chats', onclick: showNoChat }, icon('back')), h('h2', {}, 'Nieuwe chat')),
    h('label', { for: 'new-title' }, 'Onderwerp', title), h('label', { for: 'new-description' }, 'Korte beschrijving', description),
    h('div', { class: 'muted' }, 'Wie doet er mee?'), others,
    h('label', { for: 'new-brief' }, 'onderwerp.md (het gedeelde geheugen van de chat)', briefBox), fileInput, error,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Chat maken')));
    chatEl.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'column' }, form)));
    title.focus();
}

async function openChat(id) {
    stopPolling();
    state.chatId = id;
    state.drawer = null;
    state.typing = [];
    mainEl.classList.add('in-chat');
    history.replaceState(null, '', `/chat/${id}`);
    for (const item of listEl.querySelectorAll('.chat-item')) item.setAttribute('aria-current', 'false');
    let data;
    try {
        data = await api(`/api/chats/${id}`);
    } catch (e) {
        chatEl.replaceChildren(h('div', { class: 'empty' }, e.message));
        return;
    }
    state.chat = data.chat;
    state.members = data.members;
    state.autonomy = data.autonomy;
    state.claudes = data.claudes || [];
    const first = await api(`/api/chats/${id}/wait?since=0&tv=0`);
    messagesEl.replaceChildren(...first.messages.map((m) => messageEl(m)), thinkingEl);
    state.lastId = first.messages.at(-1)?.id || 0;
    state.tv = first.tv;
    state.typing = first.typing;
    drawChat();
    drawTyping();
    lastMarked = 0;
    loadChats();
    markRead();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    startPolling(id);
}

function drawChat() {
    const c = state.chat;
    const tool = (name, iconName, label) => iconButton(iconName, label, () => {
        state.drawer = state.drawer === name ? null : name;
        drawChat();
    }, 'ghost', { 'aria-pressed': state.drawer === name ? 'true' : 'false' });
    const head = h('div', { class: 'chat-head' },
        h('div', { class: 'chat-title' },
            h('button', { class: 'btn ghost icon-only back', type: 'button', 'aria-label': 'Terug naar chats', onclick: showNoChat }, icon('back')),
            h('h2', {}, c.title), c.archived ? h('span', { class: 'muted small' }, 'gearchiveerd') : null),
        c.description ? h('p', { class: 'muted' }, c.description) : null,
        peopleEl,
        autonomyBar(),
        h('div', { class: 'chat-tools' },
            tool('brief', 'doc', 'onderwerp.md'), tool('members', 'users', 'Deelnemers'), tool('claude', 'spark', 'Claude laten meedoen'),
            iconButton('archive', c.archived ? 'Uit archief' : 'Archiveren', async () => {
                await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { archived: !c.archived } });
                state.archived = !c.archived;
                showMain(c.id);
            })));
    const bottom = state.drawer === 'brief' ? briefDrawer() : state.drawer === 'members' ? membersDrawer() : state.drawer === 'claude' ? claudeDrawer() : composer();
    chatEl.replaceChildren(head, messagesEl, bottom);
    drawPeople();
}

// The members, each with a small Claude icon when their Claude takes part: green = listening live, grey = active lately.
// Its own element, so it can change live without touching what someone is typing.
const peopleEl = h('div', { class: 'people' });
function drawPeople() {
    const claude = (name) => (state.claudes || []).find((c) => c.name === name);
    peopleEl.replaceChildren(...state.members.map((m) => {
        const c = claude(m.name);
        const label = c ? `${m.name}, Claude ${c.listening ? 'luistert live mee' : 'was net actief'}` : m.name;
        return h('span', { class: 'person', title: label, 'aria-label': label }, avatar(m),
            c ? h('span', { class: `claude-badge${c.listening ? ' live' : ''}` }, icon('spark')) : null);
    }), h('span', {}, state.members.map((m) => m.name).join(', ')));
}

// Text with ``` blocks shown as code and @tags marked; everything as text, never as HTML
function textWithCode(text) {
    return String(text).split(/```[a-zA-Z0-9]*\n?/).map((part, i) => (i % 2 ? h('pre', {}, part.replace(/\n$/, '')) : part ? h('span', {}, withTags(part)) : null));
}
function withTags(text) {
    const me = state.user.name.toLowerCase();
    return text.split(/(@[\p{L}\p{N}_.-]+)/u).map((part, i) => {
        if (i % 2 === 0) return part;
        const who = part.slice(1).toLowerCase();
        return h('span', { class: `mention${who === me || who === `claude-${me}` ? ' me' : ''}` }, part);
    });
}

function messageEl(m, isNew = false) {
    if (m.isEvent) return h('div', { class: `msg event${isNew ? ' new' : ''}` }, `${m.sender} ${m.text} · ${when(m.created)}`);
    const mine = !m.isClaude && m.sender === state.user.name;
    const image = m.file && /^image\/(png|jpeg|gif|webp)$/.test(m.file.type);
    const file = !m.file ? null : image
        ? h('a', { href: `/api/files/${m.file.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/files/${m.file.id}`, alt: m.file.name, loading: 'lazy' }))
        : h('a', { class: 'file', href: `/api/files/${m.file.id}?download=1` }, icon('file'), `${m.file.name} · ${size(m.file.size)}`, icon('download'));
    const forMe = (m.tags || []).some((t) => !t.claude && t.name === state.user.name);
    return colored(h('article', { class: `msg${m.isClaude ? ' claude' : ''}${mine ? ' mine' : ''}${forMe ? ' for-me' : ''}${isNew ? ' new' : ''}`, 'aria-label': `Bericht ${m.number} van ${m.sender}${forMe ? ', je bent getagd' : ''}` },
        h('div', { class: 'msg-head' }, m.isClaude ? icon('spark', 'claude-icon') : null, h('b', {}, m.sender),
            // ~/chat-title, only shown in the Shell theme (like the folder in a terminal prompt)
            h('span', { class: 'path' }, `~/${(state.chat?.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`),
            h('span', {}, `#${m.number} · ${when(m.created)}`)),
        m.text ? h('div', { class: 'msg-body' }, textWithCode(m.text)) : null, file), m.color);
}

// "Chris is aan het typen…" above the writing box; "Claude (Chris) denkt na" as a bubble in the chat
let typingTimer = null;
function drawTyping() {
    clearTimeout(typingTimer);
    const now = Date.now();
    const active = state.typing.filter((t) => t.until > now && t.sender !== state.user.name);
    const typers = active.filter((t) => t.kind === 'typing').map((t) => t.sender);
    const thinkers = active.filter((t) => t.kind === 'thinking');
    typingBar.replaceChildren(...(typers.length ? [h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
        h('span', {}, typers.length === 1 ? `${typers[0]} is aan het typen…` : `${typers.slice(0, -1).join(', ')} en ${typers.at(-1)} zijn aan het typen…`)] : []));
    typingBar.classList.toggle('on', typers.length > 0);
    const shown = [...thinkingEl.children].map((el) => el.dataset.sender);
    if (shown.join() !== thinkers.map((t) => t.sender).join()) {
        thinkingEl.replaceChildren(...thinkers.map((t) => h('div', { class: 'thinking', 'data-sender': t.sender, role: 'status' },
            icon('spark', 'spark'), h('span', {}, `${t.sender} denkt na`), h('span', { class: 'dots' }, h('i'), h('i'), h('i')))));
        if (thinkers.length) messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    // Hide each one at its own end time, also when nothing else arrives
    const next = Math.min(...active.map((t) => t.until));
    if (Number.isFinite(next)) typingTimer = setTimeout(drawTyping, Math.max(250, next - now + 50));
}

function composer() {
    if (state.chat.archived) return h('div', { class: 'composer-note muted' }, 'Deze chat is gearchiveerd. Haal hem uit het archief om verder te praten.');
    const box = h('textarea', { rows: '1', placeholder: 'Bericht…', maxlength: '8000', 'aria-label': 'Bericht (Enter = versturen, Shift+Enter = nieuwe regel)' });
    const grow = () => {
        box.style.height = 'auto';
        box.style.height = `${Math.min(box.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    };
    // @-suggestions: the members and their Claude, filtered by what you type after the @
    const suggest = h('div', { class: 'suggest', role: 'listbox', 'aria-label': 'Wie wil je taggen?', hidden: true });
    let options = [];
    let chosen = 0;
    const tagBeforeCaret = () => box.value.slice(0, box.selectionStart).match(/@([\p{L}\p{N}_.-]*)$/u);
    function drawSuggest() {
        const match = tagBeforeCaret();
        const typed = match ? match[1].toLowerCase() : null;
        options = typed === null ? [] : state.members.flatMap((m) => [{ label: m.name, color: m.color }, { label: `Claude-${m.name}`, color: m.color, claude: true }])
            .filter((o) => o.label.toLowerCase().startsWith(typed)).slice(0, 8);
        chosen = Math.min(chosen, Math.max(options.length - 1, 0));
        suggest.hidden = !options.length;
        suggest.replaceChildren(...options.map((o, i) => h('button', { class: 'suggest-item', type: 'button', role: 'option', 'aria-selected': i === chosen ? 'true' : 'false',
            onmousedown: (event) => {
                event.preventDefault();
                pick(i);
            } }, avatar({ name: o.label.replace(/^Claude-/, ''), color: o.color }), h('span', {}, `@${o.label}`), o.claude ? h('span', { class: 'muted small' }, 'Claude') : null)));
    }
    function pick(i) {
        const match = tagBeforeCaret();
        if (!match || !options[i]) return;
        const start = box.selectionStart - match[0].length;
        box.value = `${box.value.slice(0, start)}@${options[i].label} ${box.value.slice(box.selectionStart)}`;
        box.selectionStart = box.selectionEnd = start + options[i].label.length + 2;
        suggest.hidden = true;
        box.focus();
    }
    // Tagged someone who is not in this chat: offer to add them
    const notice = h('div', { class: 'notice', role: 'status', hidden: true });
    function offerToAdd(names) {
        notice.hidden = !names.length;
        notice.replaceChildren(...(names.length ? [h('span', {}, `${names.join(', ')} ${names.length === 1 ? 'zit' : 'zitten'} niet in deze chat en ${names.length === 1 ? 'ziet' : 'zien'} de tag dus niet.`),
            ...names.map((name) => action(`${name} toevoegen`, async () => {
                const { members } = await api(`/api/chats/${state.chatId}/members`, { method: 'POST', body: { name } });
                state.members = members;
                offerToAdd(names.filter((n) => n !== name));
            }, { kind: 'compact primary' })),
            h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Sluiten', onclick: () => offerToAdd([]) }, icon('x'))] : []));
    }

    let lastTypingSent = 0;
    box.addEventListener('input', () => {
        grow();
        drawSuggest();
        // Others see "... is aan het typen" (at most once every 3 seconds, ends by itself after 6)
        if (box.value.trim() && Date.now() - lastTypingSent > 3000) {
            lastTypingSent = Date.now();
            api(`/api/chats/${state.chatId}/typing`, { method: 'POST', body: { kind: 'typing', seconds: 6 } }).catch(() => {});
        }
    });
    const fileInput = h('input', { type: 'file', hidden: true, onchange: async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            await api(`/api/chats/${state.chatId}/files?name=${encodeURIComponent(file.name)}&text=${encodeURIComponent(box.value.trim())}`, { method: 'POST', raw: file, type: file.type || 'application/octet-stream' });
            box.value = '';
            grow();
        } catch (e) {
            alert(e.message);
        }
        fileInput.value = '';
    } });
    async function send() {
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        grow();
        lastTypingSent = 0;
        try {
            const { notInChat } = await api(`/api/chats/${state.chatId}/messages`, { method: 'POST', body: { text } });
            offerToAdd(notInChat || []);
        } catch (e) {
            box.value = text;
            grow();
            alert(e.message);
        }
        box.focus();
    }
    box.addEventListener('keydown', (event) => {
        // While the @-list is open: arrows choose, Enter/Tab takes it, Escape closes
        if (!suggest.hidden) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                chosen = (chosen + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
                drawSuggest();
                return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pick(chosen);
                return;
            }
            if (event.key === 'Escape') {
                suggest.hidden = true;
                return;
            }
        }
        // Enter sends on a computer; on a phone Enter is a new line and the send button sends
        if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) {
            event.preventDefault();
            send();
        }
    });
    box.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 150));
    return h('div', { class: 'composer' }, typingBar, notice, suggest,
        h('div', { class: 'composer-row' },
            h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Bestand delen', title: 'Bestand delen', onclick: () => fileInput.click() }, icon('clip')),
            box, fileInput,
            h('button', { class: 'btn primary icon-only', type: 'button', 'aria-label': 'Versturen', title: 'Versturen', onclick: send }, icon('send'))));
}

function drawerHead(title) {
    return h('div', { class: 'drawer-head' }, h('h3', {}, title), h('button', { class: 'btn ghost icon-only', type: 'button', 'aria-label': 'Sluiten', onclick: () => {
        state.drawer = null;
        drawChat();
    } }, icon('x')));
}

function briefDrawer() {
    const box = h('textarea', { 'aria-label': 'onderwerp.md' });
    const status = h('p', { class: 'muted' }, 'Laden…');
    let version = 0;
    async function load() {
        const { brief } = await api(`/api/chats/${state.chatId}/brief`);
        box.value = brief.text;
        version = brief.version;
        status.textContent = brief.version ? `Versie ${brief.version} · ${brief.by} · ${when(brief.at)}` : 'Nog leeg. Schrijf hier wat er besloten is, wie wat doet en wat nog open staat.';
    }
    load();
    return h('div', { class: 'drawer' },
        drawerHead('onderwerp.md: het gedeelde geheugen van deze chat'), status, box,
        h('div', { class: 'row' },
            state.chat.archived ? null : action('Opslaan', async () => {
                try {
                    await api(`/api/chats/${state.chatId}/brief`, { method: 'PUT', body: { text: box.value, version } });
                    await load();
                } catch (e) {
                    if (e.status !== 409) throw e;
                    if (confirm(`${e.message}\n\nNieuwste versie laden? (Kopieer eerst je eigen tekst als je die wilt bewaren.)`)) await load();
                }
            }, { kind: 'primary' }),
            h('a', { class: 'btn', href: `/api/chats/${state.chatId}/onderwerp.md` }, icon('download'), 'Downloaden'),
            h('button', { class: 'btn', type: 'button', onclick: () => showNewChat(box.value) }, icon('plus'), 'Nieuwe chat hiermee')));
}

function membersDrawer() {
    const select = h('select', { 'aria-label': 'Persoon toevoegen' });
    api('/api/users').then(({ users }) => select.replaceChildren(h('option', { value: '' }, 'Kies iemand…'),
        ...users.filter((u) => !state.members.some((m) => m.id === u.id)).map((u) => h('option', { value: u.name }, u.name))));
    const after = ({ members }) => {
        state.members = members;
        if (!members.some((m) => m.id === state.user.id)) return showMain(null);
        drawChat();
    };
    return h('div', { class: 'drawer' },
        drawerHead('Deelnemers'),
        h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, state.members.map((m) => h('tr', {},
            h('td', {}, h('span', { class: 'people' }, avatar(m), m.name)),
            h('td', {}, action(m.id === state.user.id ? 'Chat verlaten' : 'Verwijderen', async () => after(await api(`/api/chats/${state.chatId}/members/${m.id}`, { method: 'DELETE' })), { kind: 'compact danger' }))))))),
        h('div', { class: 'row' }, select, action('Toevoegen', async () => {
            if (select.value) after(await api(`/api/chats/${state.chatId}/members`, { method: 'POST', body: { name: select.value } }));
        }, { kind: 'primary' })),
        h('p', { class: 'muted' }, 'Staat iemand er niet tussen? Die heeft nog geen account: vraag een admin om een uitnodigingslink.'));
}

function claudeDrawer() {
    const text = h('pre', { class: 'mono instructions' }, 'Laden…');
    const copy = h('span');
    fetch(`/api/chats/${state.chatId}/claude.md`, { credentials: 'same-origin' }).then((r) => r.text()).then((t) => {
        text.textContent = t;
        copy.replaceChildren(copyButton(t));
    });
    return h('div', { class: 'drawer' },
        drawerHead('Je eigen Claude Code laten meedoen'),
        h('ol', { class: 'steps' },
            h('li', {}, 'Maak eenmalig een Claude-sleutel bij je account (rechtsboven je naam) en zet die op je pc met het setx-commando dat daar staat.'),
            h('li', {}, 'Kopieer de tekst hieronder en plak hem in je Claude Code-sessie, of in de CLAUDE.md van je project.'),
            h('li', {}, 'Zeg erbij of Claude de chat live moet volgen. Terwijl Claude werkt, zie je hier "denkt na".')),
        h('div', { class: 'row' }, copy), text);
}

// ---------- live (long polling: costs nothing while nothing happens) ----------

function startPolling(id) {
    const controller = new AbortController();
    state.poll = controller;
    (async () => {
        while (!controller.signal.aborted && state.chatId === id) {
            try {
                const data = await api(`/api/chats/${id}/wait?since=${state.lastId}&tv=${state.tv}&timeout=25`, { signal: controller.signal });
                if (state.chatId !== id) return;
                state.tv = data.tv;
                state.typing = data.typing;
                state.claudes = data.claudes || [];
                drawPeople();
                const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
                for (const m of data.messages) if (m.id > state.lastId) messagesEl.insertBefore(messageEl(m, true), thinkingEl);
                if (data.messages.length) {
                    state.lastId = Math.max(state.lastId, ...data.messages.map((m) => m.id));
                    markRead();
                }
                drawTyping();
                if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
                // someone changed the members or the archive: refresh the head
                if (data.messages.some((m) => m.isEvent)) {
                    const fresh = await api(`/api/chats/${id}`);
                    state.chat = fresh.chat;
                    state.members = fresh.members;
                    state.autonomy = fresh.autonomy;
                    state.claudes = fresh.claudes || [];
                    if (!state.drawer) drawChat();
                }
            } catch (e) {
                if (controller.signal.aborted || e.status === 401) return;
                await pause(5000);
            }
        }
    })();
}

function stopPolling() {
    state.poll?.abort();
    state.poll = null;
    clearTimeout(typingTimer);
}

// The chat list stays up to date by itself: a new chat, being added to one, or a new message somewhere.
let listWatcher = null;
function watchChatList() {
    if (listWatcher) return;
    listWatcher = (async () => {
        while (state.user) {
            try {
                const { latest } = await api(`/api/chats-changed?since=${state.latest || 0}&timeout=60`);
                if (latest > (state.latest || 0) && state.user) await loadChats();
            } catch (e) {
                if (e.status === 401) break;
                await pause(5000);
            }
        }
        listWatcher = null;
    })();
}

// ---------- my account ----------

// The look of the page, per device (kept in this browser only)
// Glas (dark frosted glass) is the default
const THEMES = [['glas', 'Glas'], ['nacht', 'Nacht'], ['grafiet', 'Grafiet'], ['licht', 'Licht'], ['terminal', 'Terminal'], ['hackerman', 'Hackerman'], ['shell', 'Shell'], ['vscode', 'VS Code']];
function applyTheme(name) {
    document.documentElement.dataset.theme = THEMES.some(([id]) => id === name) ? name : 'glas';
    matrixRain(document.documentElement.dataset.theme === 'hackerman');
}

// Hackerman: falling green characters behind everything, drawn on a canvas in the browser (the NAS does nothing).
// About 20 frames a second, paused while the tab is in the background, and still with "reduce motion".
let matrix = null;
function matrixRain(on) {
    if (!on) {
        if (matrix) {
            cancelAnimationFrame(matrix.frame);
            matrix.canvas.remove();
            matrix = null;
        }
        return;
    }
    if (matrix) return;
    const canvas = h('canvas', { class: 'matrix', 'aria-hidden': 'true' });
    document.body.prepend(canvas);
    const ctx = canvas.getContext('2d');
    const glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789ABCDEF<>/{}=+*';
    const size = 16;
    let drops = [];
    const still = matchMedia('(prefers-reduced-motion: reduce)');
    function fit() {
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        drops = Array.from({ length: Math.ceil(innerWidth / size) }, () => Math.random() * -innerHeight / size);
        ctx.fillStyle = '#000300';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    function step() {
        // a see-through black layer: old characters fade out slowly into a trail
        ctx.fillStyle = 'rgba(0, 3, 0, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${size}px Consolas, monospace`;
        drops.forEach((y, i) => {
            const char = glyphs[Math.floor(Math.random() * glyphs.length)];
            ctx.fillStyle = Math.random() > 0.975 ? '#d7ffe4' : '#39ff7a';
            ctx.fillText(char, i * size, y * size);
            drops[i] = y * size > canvas.height && Math.random() > 0.975 ? 0 : y + 1;
        });
    }
    let last = 0;
    function loop(time) {
        matrix.frame = requestAnimationFrame(loop);
        if (document.hidden || time - last < 50) return;
        last = time;
        step();
    }
    // no movement: one still picture of the rain, spread over the whole screen (again after every resize, which clears it)
    function stillPicture() {
        drops = drops.map(() => Math.random() * (innerHeight / size));
        for (let i = 0; i < 40; i += 1) step();
    }
    matrix = { canvas, frame: 0 };
    fit();
    addEventListener('resize', () => {
        if (!matrix) return;
        fit();
        if (still.matches) stillPicture();
    });
    if (still.matches) stillPicture();
    else matrix.frame = requestAnimationFrame(loop);
}
// ?thema=licht in the address also works (handy to compare them side by side)
try {
    applyTheme(new URLSearchParams(location.search).get('thema') || localStorage.getItem('claudesuite-theme'));
} catch {
    applyTheme('glas');
}

async function showProfile() {
    stopPolling();
    const { user } = await api('/api/me');
    const current = h('input', { id: 'pw-current', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { id: 'pw-next', type: 'password', autocomplete: 'new-password', minlength: '12' });
    const linkOut = h('div');
    const keyOut = h('div');
    const themes = h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Thema' }, THEMES.map(([id, label]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'theme', value: id, checked: document.documentElement.dataset.theme === id, onchange: () => {
            applyTheme(id);
            try {
                localStorage.setItem('claudesuite-theme', id);
            } catch {
                // no storage: the choice lasts until the page is closed
            }
        } }), label)));
    const page = h('div', { class: 'column' },
        h('div', { class: 'card' }, h('div', { class: 'people' }, avatar(user), h('h2', {}, user.name)),
            h('p', { class: 'muted' }, `Je Claude schrijft als "Claude (${user.name})", in jouw kleur.`)),
        h('div', { class: 'card' }, h('h2', {}, 'Ander apparaat koppelen'),
            h('p', {}, 'Maak een link en open die op je telefoon of andere pc. Hij werkt één keer en 15 minuten lang; daarna blijft dat apparaat 30 dagen ingelogd.'),
            h('div', { class: 'row' },
                action('Koppellink maken', async () => {
                    const { link } = await api('/api/me/login-link', { method: 'POST' });
                    linkOut.replaceChildren(h('div', { class: 'secret' }, h('p', { class: 'mono' }, link), h('p', { class: 'muted' }, 'Deel hem met niemand anders: wie hem als eerste opent, is jou.'), h('div', {}, copyButton(link))));
                }, { kind: 'primary' }),
                action('Intrekken', async () => {
                    await api('/api/me/login-link', { method: 'DELETE' });
                    linkOut.replaceChildren(h('p', { class: 'ok' }, 'Ingetrokken.'));
                }, { kind: 'danger' })),
            linkOut),
        h('div', { class: 'card' }, h('h2', {}, user.hasPassword ? 'Wachtwoord wijzigen' : 'Wachtwoord (niet nodig)'),
            user.hasPassword ? null : h('p', { class: 'muted' }, 'Je logt in via je gekoppelde apparaten. Een wachtwoord is alleen handig als je ook op een vreemde computer wilt inloggen.'),
            user.hasPassword ? h('label', { for: 'pw-current' }, 'Huidig wachtwoord', current) : null,
            h('label', { for: 'pw-next' }, 'Nieuw wachtwoord', next),
            h('div', { class: 'row' }, action(user.hasPassword ? 'Wijzigen' : 'Wachtwoord instellen', async () => {
                await api('/api/me/password', { method: 'POST', body: { current: current.value, next: next.value } });
                current.value = next.value = '';
                alert('Opgeslagen. Op andere apparaten moet je opnieuw inloggen.');
                showProfile();
            }))),
        h('div', { class: 'card' }, h('h2', {}, 'Claude-sleutel'),
            h('p', {}, `Hiermee schrijft jouw Claude Code in je chats als "Claude (${user.name})". Alleen in chats waar jij in zit; nooit je account of uitnodigingen.`),
            h('div', { class: 'row' },
                action(user.hasClaudeKey ? 'Nieuwe sleutel (de oude stopt)' : 'Claude-sleutel maken', async () => {
                    const { key } = await api('/api/me/claude-key', { method: 'POST' });
                    const command = `setx CLAUDESUITE_KEY "${key}"; ${setupCommand(`"${key}"`)}`;
                    keyOut.replaceChildren(h('div', { class: 'secret' },
                        h('p', {}, 'Plak dit één keer in PowerShell op je eigen pc en druk op Enter. Het zet je sleutel en zet ClaudeSuite in je CLAUDE.md. Start Claude Code daarna opnieuw.'),
                        h('p', { class: 'mono' }, command), h('div', {}, copyButton(command)),
                        h('p', { class: 'muted' }, 'Deze sleutel wordt niet nog eens getoond. Plak hem nooit in een chat.')));
                }, { kind: 'primary' }),
                user.hasClaudeKey ? action('Update mijn CLAUDE.md', async () => {
                    const command = setupCommand('$env:CLAUDESUITE_KEY');
                    keyOut.replaceChildren(h('div', { class: 'secret' },
                        h('p', {}, 'Plak dit in PowerShell op de pc waar je sleutel al staat. Het vervangt alleen het ClaudeSuite-stuk in je CLAUDE.md; de rest blijft staan.'),
                        h('p', { class: 'mono' }, command), h('div', {}, copyButton(command))));
                }) : null,
                user.hasClaudeKey ? action('Intrekken', async () => {
                    await api('/api/me/claude-key', { method: 'DELETE' });
                    keyOut.replaceChildren(h('p', { class: 'ok' }, 'Ingetrokken.'));
                }, { kind: 'danger' }) : null),
            keyOut),
        h('div', { class: 'card' }, h('h2', {}, 'Thema'), h('p', { class: 'muted' }, 'Alleen op dit apparaat.'), themes));
    root.replaceChildren(topBar(), h('div', { class: 'page' }, page));
}

// One PowerShell command that puts the general ClaudeSuite piece into the person's own CLAUDE.md
// (C:\Users\<name>\.claude\CLAUDE.md). It only downloads text (nothing from the NAS is run as code) and replaces
// just the piece between the claudesuite markers, so a second time updates it and the rest of the file stays.
function setupCommand(key) {
    const url = `${location.origin}/api/claude-setup.md`;
    return [
        `$k = ${key}`,
        '$f = "$HOME\\.claude\\CLAUDE.md"',
        'New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null',
        '$old = if (Test-Path $f) { [IO.File]::ReadAllText($f) } else { \'\' }',
        `$new = Invoke-RestMethod -Headers @{ Authorization = "Bearer $k" } "${url}"`,
        '$old = [regex]::Replace($old, \'(?s)\\s*<!-- claudesuite:start -->.*?<!-- claudesuite:end -->\\s*\', [Environment]::NewLine)',
        '[IO.File]::WriteAllText($f, ($old.Trim() + [Environment]::NewLine + [Environment]::NewLine + $new.Trim() + [Environment]::NewLine).TrimStart(), (New-Object Text.UTF8Encoding $false))',
        '"ClaudeSuite staat nu in $f"',
    ].join('; ');
}

// ---------- beheer ----------

function showAdmin() {
    stopPolling();
    const role = h('select', { 'aria-label': 'Rol' }, h('option', { value: 'member' }, 'Deelnemer'), h('option', { value: 'admin' }, 'Admin'));
    const inviteOut = h('div');
    const usersBody = h('tbody');
    async function loadUsers() {
        const { users } = await api('/api/users');
        usersBody.replaceChildren(...users.map((u) => {
            const isMe = u.id === state.user.id;
            const roleSelect = h('select', { disabled: isMe, 'aria-label': `Rol van ${u.name}`, onchange: async () => {
                try {
                    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: roleSelect.value } });
                } catch (e) {
                    alert(e.message);
                }
            } }, h('option', { value: 'member' }, 'Deelnemer'), h('option', { value: 'admin' }, 'Admin'));
            roleSelect.value = u.role;
            return h('tr', {}, h('td', {}, h('span', { class: 'people' }, avatar(u), u.name)), h('td', {}, roleSelect),
                h('td', {}, isMe ? h('span', { class: 'muted' }, 'jij') : h('div', { class: 'row' },
                    action('Herstellink', async () => {
                        const { link } = await api(`/api/users/${u.id}/login-link`, { method: 'POST' });
                        inviteOut.replaceChildren(h('div', { class: 'secret' }, h('p', {}, `Herstellink voor ${u.name} (eenmalig, 60 minuten). Geef hem persoonlijk:`), h('p', { class: 'mono' }, link), h('div', {}, copyButton(link))));
                    }, { kind: 'compact' }),
                    u.hasLoginLink ? action('Link intrekken', async () => { await api(`/api/users/${u.id}/login-link`, { method: 'DELETE' }); loadUsers(); }, { kind: 'compact' }) : null,
                    u.hasClaudeKey ? action('Sleutel intrekken', async () => { await api(`/api/users/${u.id}/claude-key`, { method: 'DELETE' }); loadUsers(); }, { kind: 'compact' }) : null,
                    action('Verwijderen', async () => {
                        if (!confirm(`${u.name} verwijderen? Berichten blijven staan.`)) return;
                        await api(`/api/users/${u.id}`, { method: 'DELETE' });
                        loadUsers();
                    }, { kind: 'compact danger' }))));
        }));
    }
    const page = h('div', { class: 'column' },
        h('div', { class: 'card' }, h('h2', {}, 'Iemand uitnodigen'),
            h('p', {}, 'Maak een link en geef die aan de nieuwe collega. Hij werkt één keer en een week lang; daarmee kiest diegene een naam en wachtwoord.'),
            h('div', { class: 'row' }, role, action('Uitnodigingslink maken', async () => {
                const { link } = await api('/api/invites', { method: 'POST', body: { role: role.value } });
                inviteOut.replaceChildren(h('div', { class: 'secret' }, h('p', { class: 'mono' }, link), h('div', {}, copyButton(link))));
            }, { kind: 'primary' })), inviteOut),
        h('div', { class: 'card' }, h('h2', {}, 'Gebruikers'), h('div', { class: 'table-wrap' }, h('table', {}, usersBody))));
    root.replaceChildren(topBar(), h('div', { class: 'page' }, page));
    loadUsers();
}

start().catch((e) => root.replaceChildren(h('p', { class: 'error' }, e.message)));
