import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiGuard, humanOnly } from '../suite/guard.js';
import { claudeDetails, claudeInstructions, claudeSetup } from '../suite/claudeInstructions.js';

// The chats. People and their Claude (with the person's Claude key) only see the chats they are a member of.
//
//   GET    /api/chats?archived=1                 my chats (or my archived chats)
//   POST   /api/chats                            { title, description, brief, members: [names] }    (person)
//   GET    /api/chats/:id                        the chat, its members and the onderwerp.md status
//   PATCH  /api/chats/:id                        { title, description, archived }                   (person)
//   POST   /api/chats/:id/members                { name }                                           (person)
//   DELETE /api/chats/:id/members/:userId                                                            (person)
//   POST   /api/chats/:id/autonomy               { agree: true|false }: "Claudes mogen zelf handelen" (person);
//                                                  only on when every member agreed, a new member must agree too
//   GET    /api/chats/:id/messages?since=&before=&limit=&format=text
//   POST   /api/chats/:id/messages               JSON { text }, or the plain text as body (text/plain)
//   GET    /api/chats/:id/wait?since=&tv=&timeout=  waits (max 300 s) until there is a message after "since", or
//                                                  who is typing changed (tv = the typing version you have);
//                                                  &wake=claude&bundle=20&format=text for a Claude listener
//   POST   /api/chats/:id/typing                 { kind: typing | thinking | stop, seconds }: "X is aan het typen",
//                                                  "Claude (X) denkt na"; ends by itself, or when X posts
//   POST   /api/chats/:id/files?name=&text=      the file itself as body; becomes a message
//   GET    /api/files/:id                        download a shared file
//   GET    /api/chats/:id/brief                  onderwerp.md: { text, version, by, at }
//   PUT    /api/chats/:id/brief                  { text, version } (or text/plain with ?version=); refused when someone saved in between
//   GET    /api/chats/:id/onderwerp.md           onderwerp.md as a download
//   GET    /api/chats/:id/claude.md              how a Claude Code session joins this chat
//   GET    /api/claude-setup.md                  the general piece for the person's own CLAUDE.md

const MAX_TEXT = 8000;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 500;
const MAX_BRIEF = 200_000;
// Shown in the browser itself; anything else is always a download (an HTML or SVG file never runs as a page)
const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Messages as plain text for a Claude (?format=text): far fewer tokens than JSON, and still easy to read.
// "me" is the person whose Claude reads it: messages that tag that Claude get [VOOR JOU].
const DAY = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
export function asText(messages, { chat, me, next }) {
    const lines = [`# Chat ${chat.id} "${chat.title}": ${messages.length} bericht${messages.length === 1 ? '' : 'en'}`];
    if (messages[0]?.number > 1) lines.push(`(oudere berichten: ?before=${messages[0].id})`);
    let day = '';
    for (const m of messages) {
        const at = new Date(m.created);
        if (DAY.format(at) !== day) lines.push('', `-- ${(day = DAY.format(at))} --`);
        const forMe = (m.tags || []).some((t) => t.claude && t.name === me) ? ' [VOOR JOU]' : '';
        const file = m.file ? ` [bestand ${m.file.id}: ${m.file.name}, ${Math.max(1, Math.round(m.file.size / 1024))} kB]` : '';
        const [first, ...rest] = `${m.text}${file}`.trim().split('\n');
        lines.push(`#${m.number} ${TIME.format(at)} ${m.isEvent ? `· ${m.sender}` : `${m.sender}:`}${forMe} ${first}`.trimEnd(), ...rest.map((line) => `    ${line}`));
    }
    if (next) lines.push('', `(nieuwe berichten: ?since=${next})`);
    return `${lines.join('\n')}\n`;
}

const bad = (res, message, status = 400) => res.status(status).json({ message });
const clean = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
// A file name without folders or control characters
const safeName = (name) => String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 120) || 'bestand';

export function chatsRoute({ store, sessions, waiters, maxFileBytes }) {
    const router = express.Router();
    const guard = apiGuard({ store, sessions });
    router.use(['/chats', '/chats-changed', '/files', '/claude-setup.md'], guard);
    const json = express.json({ limit: '300kb' });
    const text = express.text({ limit: '300kb', type: 'text/plain' });

    // Every /chats/:id route: the chat exists and you are a member (same answer for both, so ids tell nothing)
    router.param('id', (req, res, next, id) => {
        const chat = /^\d{1,9}$/.test(id) ? store.chat(id) : null;
        if (!chat || !store.isMember(chat.id, req.user.id)) return bad(res, 'Deze chat bestaat niet, of je bent geen deelnemer.', 404);
        req.chat = chat;
        if (req.isClaude) claudeSeen(chat.id, req.user.id);
        next();
    });
    const open = (req, res, next) => (req.chat.archived ? bad(res, 'Deze chat is gearchiveerd. Haal hem eerst uit het archief.') : next());

    // Who is typing or thinking, per chat, only in memory (small, and gone after a restart, which is fine).
    // Every entry carries its own end time, so nothing has to run to clean up: old ones are skipped when read.
    const typing = new Map(); // chatId -> { version, who: Map(sender -> { kind, isClaude, until }) }
    const typingOf = (chatId) => {
        if (!typing.has(chatId)) typing.set(chatId, { version: 0, who: new Map() });
        return typing.get(chatId);
    };
    const typingNow = (chatId) => {
        const entry = typingOf(chatId);
        const list = [...entry.who].filter(([, t]) => t.until > Date.now()).map(([sender, t]) => ({ sender, ...t }));
        return { tv: entry.version, typing: list, claudes: claudesNow(chatId) };
    };
    const bump = (chatId) => {
        typingOf(chatId).version += 1;
        waiters.notify(chatId, { all: false });
    };

    // Which Claudes take part, per chat, only in memory: "listening" while its live listener waits (plus 15 s, the
    // gap between two waits), "recent" when it used the chat in the last 15 minutes. Shown as an icon at the person.
    const LISTEN_GAP = 15_000;
    const RECENT = 15 * 60_000;
    const presence = new Map(); // chatId -> Map(userId -> { waiting, waitEnded, seen })
    const presenceOf = (chatId, userId) => {
        if (!presence.has(chatId)) presence.set(chatId, new Map());
        const chat = presence.get(chatId);
        if (!chat.has(userId)) chat.set(userId, { waiting: 0, waitEnded: 0, seen: 0 });
        return chat.get(userId);
    };
    const isListening = (p) => p.waiting > 0 || Date.now() - p.waitEnded < LISTEN_GAP;
    function claudesNow(chatId) {
        const list = [];
        for (const [userId, p] of presence.get(chatId) || []) {
            if (!isListening(p) && Date.now() - p.seen > RECENT) continue;
            const person = store.user(userId);
            if (person) list.push({ name: person.name, color: person.color, listening: isListening(p) });
        }
        return list;
    }
    function claudeSeen(chatId, userId) {
        const p = presenceOf(chatId, userId);
        const wasShown = isListening(p) || Date.now() - p.seen <= RECENT;
        p.seen = Date.now();
        if (!wasShown) bump(chatId);
    }
    function setTyping(chatId, sender, value) {
        const entry = typingOf(chatId);
        if (!value && !entry.who.has(sender)) return;
        if (value) entry.who.set(sender, value);
        else entry.who.delete(sender);
        entry.version += 1;
        waiters.notify(chatId, { all: false });
    }

    router.get('/chats', (req, res) => res.json({ chats: store.chatsFor(req.user.id, { archived: req.query.archived === '1' }), latest: store.latestFor(req.user.id) }));

    // For the chat list: waits (max 300 s) until one of my chats has a message after "since" (a new chat, being
    // added to one, or a new message), then answers the newest id. Something elsewhere wakes it up too: then it
    // simply waits again until the time is up.
    router.get('/chats-changed', async (req, res) => {
        const since = Number(req.query.since) || 0;
        const until = Date.now() + Math.min(Math.max(Number(req.query.timeout) || 60, 1), 300) * 1000;
        let latest = store.latestFor(req.user.id);
        while (latest <= since && Date.now() < until && !res.destroyed) {
            await waiters.wait('all', (until - Date.now()) / 1000, res);
            latest = store.latestFor(req.user.id);
        }
        if (!res.writableEnded && !res.destroyed) res.json({ latest });
    });

    router.post('/chats', humanOnly, json, (req, res) => {
        const title = clean(req.body?.title, MAX_TITLE);
        if (!title) return bad(res, 'Geef de chat een titel.');
        const chat = store.createChat({ title, description: clean(req.body?.description, MAX_DESCRIPTION), brief: clean(req.body?.brief, MAX_BRIEF), by: req.user });
        const tags = [];
        for (const name of [].concat(req.body?.members || []).slice(0, 50)) {
            const member = store.userByName(name);
            if (member && member.id !== req.user.id) {
                store.addMember(chat.id, member.id);
                tags.push({ userId: member.id, claude: false });
            }
        }
        // the people added are tagged, so the new chat lights up in their list
        store.addMessage({ chatId: chat.id, user: req.user, isEvent: true, text: `heeft de chat "${title}" gemaakt.`, tags });
        // the chat lists of the members show it at once
        waiters.notify(chat.id);
        res.json({ chat });
    });

    router.get('/chats/:id', (req, res) => {
        const { text: briefText, ...brief } = store.brief(req.chat.id);
        res.json({ chat: req.chat, members: store.members(req.chat.id), brief: { ...brief, length: briefText.length }, autonomy: store.autonomy(req.chat.id), claudes: claudesNow(req.chat.id) });
    });

    router.post('/chats/:id/autonomy', humanOnly, open, json, (req, res) => {
        const agree = req.body?.agree === true;
        const before = store.autonomy(req.chat.id);
        const had = before.agreed.includes(req.user.name);
        if (agree === had) return res.json({ autonomy: before });
        store.setAutonomy(req.chat.id, req.user.id, agree);
        const after = store.autonomy(req.chat.id);
        if (agree && !before.agreed.length) note(req, `stelt voor dat de Claudes in deze chat zelf mogen handelen, zonder eerst toestemming te vragen. Dat gaat pas aan als iedereen akkoord geeft (${after.waiting.join(', ')}).`);
        else if (agree) note(req, 'gaat akkoord met zelf handelen.');
        else note(req, before.active ? 'heeft zelf handelen uitgezet. De Claudes vragen weer eerst toestemming.' : 'gaat niet akkoord met zelf handelen.');
        if (after.active && !before.active) note(req, 'Zelf handelen staat nu AAN: iedereen is akkoord. De Claudes mogen verzoeken van elkaar uitvoeren zonder eerst te vragen.');
        res.json({ autonomy: after });
    });

    router.patch('/chats/:id', humanOnly, json, (req, res) => {
        const changes = {};
        if (req.body?.title !== undefined) changes.title = clean(req.body.title, MAX_TITLE) || req.chat.title;
        if (req.body?.description !== undefined) changes.description = clean(req.body.description, MAX_DESCRIPTION);
        if (req.body?.archived !== undefined) changes.archived = Boolean(req.body.archived);
        store.updateChat(req.chat.id, changes);
        if (changes.archived !== undefined && changes.archived !== req.chat.archived) note(req, changes.archived ? 'heeft de chat gearchiveerd.' : 'heeft de chat uit het archief gehaald.');
        res.json({ chat: store.chat(req.chat.id) });
    });

    router.post('/chats/:id/members', humanOnly, json, (req, res) => {
        const member = store.userByName(req.body?.name);
        if (!member) return bad(res, 'Deze persoon heeft nog geen account. Vraag een admin om een uitnodiging.', 404);
        if (!store.isMember(req.chat.id, member.id)) {
            const wasActive = store.autonomy(req.chat.id).active;
            store.addMember(req.chat.id, member.id);
            note(req, `heeft ${member.name} toegevoegd.`, [{ userId: member.id, claude: false }]);
            if (wasActive) note(req, `Zelf handelen staat uit tot ook ${member.name} akkoord geeft.`);
        }
        res.json({ members: store.members(req.chat.id) });
    });

    router.delete('/chats/:id/members/:userId', humanOnly, (req, res) => {
        const member = store.user(req.params.userId);
        if (member && store.isMember(req.chat.id, member.id)) {
            store.removeMember(req.chat.id, member.id);
            note(req, member.id === req.user.id ? 'heeft de chat verlaten.' : `heeft ${member.name} verwijderd.`);
        }
        res.json({ members: store.members(req.chat.id) });
    });

    router.get('/chats/:id/messages', (req, res) => {
        const messages = store.messages(req.chat.id, { since: req.query.since, before: req.query.before, limit: req.query.limit });
        if (req.query.format !== 'text') return res.json({ messages });
        res.type('text/plain; charset=utf-8').send(asText(messages, { chat: req.chat, me: req.user.name, next: req.query.before ? 0 : messages.at(-1)?.id || req.query.since }));
    });

    router.post('/chats/:id/messages', open, json, text, (req, res) => {
        const body = typeof req.body === 'string' ? req.body : req.body?.text;
        const message = clean(body, MAX_TEXT);
        if (!message) return bad(res, 'Leeg bericht.');
        const { tags, outside } = findTags(message, req.chat.id);
        res.json({ message: post(req.chat.id, req.user, req.isClaude, message, null, false, tags), notInChat: outside });
    });

    // The person (not their Claude) has seen the chat up to this message
    router.post('/chats/:id/read', humanOnly, json, (req, res) => {
        store.markRead(req.chat.id, req.user.id, Number(req.body?.upTo) || 0);
        res.json({ ok: true });
    });

    router.get('/chats/:id/wait', async (req, res) => {
        const since = Number(req.query.since) || 0;
        // Without tv the asker does not care about typing (a Claude listener): only messages wake it up
        const tv = req.query.tv === undefined ? null : Number(req.query.tv) || 0;
        const until = Date.now() + Math.min(Math.max(Number(req.query.timeout) || 60, 1), 300) * 1000;
        // wake=claude (a Claude listener): only a message that tags this Claude, or one of another Claude, wakes it up;
        // the human messages in between come along. bundle=20: then wait 20 s more, so a quick reply comes in the same go.
        const mine = `Claude (${req.user.name})`;
        const wakeOnTags = req.query.wake === 'claude';
        const bundle = Math.min(Math.max(Number(req.query.bundle) || 0, 0), 60);
        const wakes = (list) => (wakeOnTags
            ? list.some((m) => m.sender !== mine && !m.isEvent && (m.isClaude || (m.tags || []).some((t) => t.claude && t.name === req.user.name)))
            : list.length > 0);
        // shortcut: a listener sees at most 500 messages since its last wake-up; more in between would hide a tag after them
        const limit = wakeOnTags ? 500 : 200;
        let messages = store.messages(req.chat.id, { since, limit });
        // A Claude that waits here is "listening live" (the others see its icon turn green)
        const p = req.isClaude ? presenceOf(req.chat.id, req.user.id) : null;
        if (p) {
            if (!isListening(p)) bump(req.chat.id);
            p.waiting += 1;
        }
        try {
            while (!wakes(messages) && since > 0 && (tv === null || typingNow(req.chat.id).tv === tv) && Date.now() < until && !res.destroyed) {
                await waiters.wait(req.chat.id, (until - Date.now()) / 1000, res);
                messages = store.messages(req.chat.id, { since, limit });
            }
            if (bundle && wakes(messages) && !res.destroyed) {
                await new Promise((resolve) => setTimeout(resolve, bundle * 1000));
                messages = store.messages(req.chat.id, { since, limit });
            }
        } finally {
            if (p) Object.assign(p, { waiting: p.waiting - 1, waitEnded: Date.now() });
        }
        // Nothing woke the listener: send nothing, so the messages so far come along next time
        if (!wakes(messages)) messages = [];
        if (res.writableEnded || res.destroyed) return;
        if (req.query.format !== 'text') return res.json({ messages, ...typingNow(req.chat.id) });
        // A Claude knows what it wrote itself
        const others = messages.filter((m) => m.sender !== mine);
        res.type('text/plain; charset=utf-8').send(others.length ? asText(others, { chat: req.chat, me: req.user.name, next: messages.at(-1).id }) : '');
    });

    router.post('/chats/:id/typing', open, json, (req, res) => {
        const sender = req.isClaude ? `Claude (${req.user.name})` : req.user.name;
        const kind = ['typing', 'thinking', 'stop'].includes(req.body?.kind) ? req.body.kind : 'typing';
        const seconds = Math.min(Math.max(Number(req.body?.seconds) || (kind === 'thinking' ? 120 : 6), 1), 300);
        setTyping(req.chat.id, sender, kind === 'stop' ? null : { kind, isClaude: req.isClaude, until: Date.now() + seconds * 1000 });
        res.json({ ok: true });
    });

    // The file goes straight to disk while it comes in: it is never held in memory as a whole
    router.post('/chats/:id/files', open, (req, res) => {
        const declared = Number(req.get('content-length'));
        if (declared > maxFileBytes) return bad(res, `Bestand te groot (max ${Math.round(maxFileBytes / 1_048_576)} MB).`, 413);
        const stored = crypto.randomBytes(16).toString('hex');
        const target = store.filePath(stored);
        const out = fs.createWriteStream(target, { mode: 0o600 });
        let size = 0;
        let failed = false;
        const fail = (status, message) => {
            if (failed) return;
            failed = true;
            req.unpipe(out);
            out.destroy();
            fs.rm(target, { force: true }, () => {});
            if (!res.headersSent) bad(res, message, status);
        };
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxFileBytes) fail(413, `Bestand te groot (max ${Math.round(maxFileBytes / 1_048_576)} MB).`);
        });
        req.on('aborted', () => fail(400, 'Uploaden afgebroken.'));
        out.on('error', () => fail(500, 'Opslaan lukte niet.'));
        out.on('finish', () => {
            if (failed) return;
            if (!size) return fail(400, 'Leeg bestand.');
            const name = safeName(req.query.name);
            const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase().slice(0, 100) || 'application/octet-stream';
            const fileId = store.addFile({ chatId: req.chat.id, userId: req.user.id, name, type, size, stored });
            const caption = clean(req.query.text, MAX_TEXT);
            const { tags, outside } = findTags(caption, req.chat.id);
            res.json({ message: post(req.chat.id, req.user, req.isClaude, caption, fileId, false, tags), notInChat: outside });
        });
        req.pipe(out);
    });

    router.get('/files/:fileId', (req, res) => {
        const file = /^\d{1,9}$/.test(req.params.fileId) ? store.file(req.params.fileId) : null;
        if (!file || !store.isMember(file.chat_id, req.user.id)) return bad(res, 'Dit bestand bestaat niet, of je bent geen deelnemer.', 404);
        const inline = INLINE_TYPES.includes(file.type) && req.query.download !== '1';
        res.set({
            'Content-Type': inline ? file.type : 'application/octet-stream',
            'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            'Content-Length': file.size,
        });
        fs.createReadStream(store.filePath(file.stored)).on('error', () => res.destroy()).pipe(res);
    });

    router.get('/chats/:id/brief', (req, res) => res.json({ brief: store.brief(req.chat.id) }));

    router.put('/chats/:id/brief', open, json, text, (req, res) => {
        const body = typeof req.body === 'string' ? { text: req.body, version: req.query.version } : req.body || {};
        if (body.text === undefined || body.version === undefined) return bad(res, 'Stuur de tekst en de versie waar je mee begon.');
        const newText = String(body.text).replace(/\r\n/g, '\n').slice(0, MAX_BRIEF);
        const by = req.isClaude ? `Claude (${req.user.name})` : req.user.name;
        if (!store.setBrief(req.chat.id, { text: newText, version: body.version, by })) {
            return res.status(409).json({ message: 'Iemand anders heeft onderwerp.md intussen aangepast. Lees hem opnieuw en pas je wijziging daarop toe.', brief: store.brief(req.chat.id) });
        }
        const brief = store.brief(req.chat.id);
        note(req, `heeft onderwerp.md bijgewerkt (versie ${brief.version}).`);
        res.json({ brief });
    });

    router.get('/chats/:id/onderwerp.md', (req, res) => {
        const brief = store.brief(req.chat.id);
        const name = `${req.chat.title.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'onderwerp'}.md`;
        const header = `# ${req.chat.title}\n\n${req.chat.description ? `${req.chat.description}\n\n` : ''}`;
        res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
        res.send(brief.text.startsWith('#') ? brief.text : header + brief.text);
    });

    // The general piece for the person's own CLAUDE.md (every new Claude Code session then knows ClaudeSuite)
    router.get('/claude-setup.md', (req, res) => {
        res.type('text/markdown; charset=utf-8').send(claudeSetup({ address: `${req.protocol}://${req.get('host')}`, name: req.user.name }));
    });

    router.get('/chats/:id/claude.md', (req, res) => {
        if (req.query.deel === 'meer') return res.type('text/markdown; charset=utf-8').send(claudeDetails({ address: `${req.protocol}://${req.get('host')}`, chat: req.chat }));
        res.type('text/markdown; charset=utf-8').send(claudeInstructions({ address: `${req.protocol}://${req.get('host')}`, chat: req.chat, name: req.user.name, autonomy: store.autonomy(req.chat.id) }));
    });

    // A message, and wake up everyone waiting on this chat
    function post(chatId, user, isClaude, message, fileId = null, isEvent = false, tags = []) {
        const saved = store.addMessage({ chatId, user, isClaude, isEvent, text: message, fileId, tags });
        // whoever posts is no longer typing or thinking
        const entry = typingOf(chatId);
        if (entry.who.delete(saved.sender)) entry.version += 1;
        waiters.notify(chatId);
        return saved;
    }
    // A short note of the app itself ("heeft Chris toegevoegd"), in the name of whoever did it
    const note = (req, message, tags = []) => post(req.chat.id, req.user, req.isClaude, message, null, true, tags);

    // @Name tags a person, @Claude-Name their Claude (no matter the capitals). Tags only count for members;
    // names of people who are not in the chat come back, so the page can offer to add them.
    function findTags(text, chatId) {
        const lower = String(text).toLowerCase();
        // the name must end there: "@Pe" is not a tag in "@Pepijn"
        const has = (token) => {
            for (let i = lower.indexOf(token); i !== -1; i = lower.indexOf(token, i + 1)) {
                if (!/[\p{L}\p{N}_.-]/u.test(lower[i + token.length] || '')) return true;
            }
            return false;
        };
        const tags = [];
        const outside = [];
        if (!lower.includes('@')) return { tags, outside };
        for (const person of store.users()) {
            const name = person.name.toLowerCase();
            const asPerson = has(`@${name}`);
            const asClaude = has(`@claude-${name}`);
            if (!asPerson && !asClaude) continue;
            if (!store.isMember(chatId, person.id)) {
                outside.push(person.name);
                continue;
            }
            if (asPerson) tags.push({ userId: person.id, claude: false });
            if (asClaude) tags.push({ userId: person.id, claude: true });
        }
        return { tags, outside };
    }

    return router;
}
