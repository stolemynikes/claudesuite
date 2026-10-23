import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { apiGuard, humanOnly, sessionName } from '../suite/guard.js';
import { claudeDetails, claudeHook, claudeInstructions, claudeMcpRules, claudeSetup } from '../suite/claudeInstructions.js';
import { createPermissions, ANSWER_MINUTES } from '../suite/permissions.js';
import { TAILSCALE_ADDRESS } from '../config.js';

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
//                                                  &wake=claude&bundle=1&format=text for a Claude listener
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
// Only the chat's own message numbers (#12) appear, the same for everyone: ?after=12 and ?voor=12 page with them.
const DAY = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' });
const TIME = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
export function asText(messages, { chat, me, next }) {
    const lines = [`# Chat ${chat.id} "${chat.title}": ${messages.length} bericht${messages.length === 1 ? '' : 'en'}`];
    if (messages[0]?.number > 1) lines.push(`(oudere berichten: ?voor=${messages[0].number})`);
    let day = '';
    for (const m of messages) {
        const at = new Date(m.created);
        if (DAY.format(at) !== day) lines.push('', `-- ${(day = DAY.format(at))} --`);
        const forMe = (m.tags || []).some((t) => t.claude && t.name === me) ? ' [VOOR JOU]' : '';
        const file = m.file ? ` [bestand ${m.file.id}: ${m.file.name}, ${Math.max(1, Math.round(m.file.size / 1024))} kB]` : '';
        const [first, ...rest] = `${m.text}${file}`.trim().split('\n');
        lines.push(`#${m.number} ${TIME.format(at)} ${m.isEvent ? `· ${m.sender}` : `${m.sender}:`}${forMe} ${first}`.trimEnd(), ...rest.map((line) => `    ${line}`));
    }
    if (next) lines.push('', `(nieuwe berichten: ?after=${next})`);
    return `${lines.join('\n')}\n`;
}

const bad = (res, message, status = 400) => res.status(status).json({ message });
const clean = (value, max) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
// A file name without folders or control characters
const safeName = (name) => String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(0, 120) || 'bestand';

export function chatsRoute({ store, sessions, waiters, maxFileBytes }) {
    const router = express.Router();
    const guard = apiGuard({ store, sessions });
    router.use(['/chats', '/chats-changed', '/files', '/claude-setup.md', '/permissions', '/claude-hook.ps1', '/whoami'], guard);
    const permissions = createPermissions();
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

    // Quick check for a Claude: does my key work, as whom do I write, and which addresses reach ClaudeSuite
    router.get('/whoami', (req, res) => res.json({
        name: req.user.name, writesAs: req.sender, isClaude: req.isClaude,
        address: `${req.protocol}://${req.get('host')}`, tailscaleAddress: TAILSCALE_ADDRESS,
    }));

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
        // "no" also works when you had not agreed yet: it ends the proposal for everyone
        if (agree ? had : !before.agreed.length) return res.json({ autonomy: before });
        store.setAutonomy(req.chat.id, req.user.id, agree);
        const after = store.autonomy(req.chat.id);
        if (agree && !before.agreed.length) note(req, `stelt voor dat de Claudes in deze chat zelf mogen handelen, zonder eerst toestemming te vragen. Dat gaat pas aan als iedereen akkoord geeft (${after.waiting.join(', ')}).`);
        else if (agree) note(req, 'gaat akkoord met zelf handelen.');
        else note(req, before.active ? 'heeft zelf handelen uitgezet, voor iedereen. De Claudes vragen weer eerst toestemming.' : 'heeft het voorstel voor zelf handelen afgewezen, voor iedereen.');
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

    // Where a Claude reads from, in the chat's own numbers: ?after=12 (after #12), ?after=laatst (where this Claude
    // session stopped last time, so a restarted session picks up there), ?voor=12 (older, before #12).
    // The page itself uses the internal ids (?since= / ?before=).
    const readUpTo = new Map(); // "<chatId>|<userId>|<sender>" -> the last number this Claude session was given (only in memory)
    function position(req) {
        let after = req.query.after;
        const key = `${req.chat.id}|${req.user.id}|${req.sender}`;
        // the first time: from now on (and remember that, so what comes next is not missed)
        if (after === 'laatst' && !readUpTo.has(key) && req.isClaude) readUpTo.set(key, store.lastNumber(req.chat.id));
        if (after === 'laatst') after = readUpTo.get(key) ?? store.lastNumber(req.chat.id);
        return {
            byNumber: after !== undefined,
            since: after !== undefined ? store.idAtNumber(req.chat.id, after) : Number(req.query.since) || 0,
            before: req.query.voor !== undefined ? store.idAtNumber(req.chat.id, Number(req.query.voor) - 1) + 1 : req.query.before,
        };
    }
    const remember = (req, messages) => {
        const key = `${req.chat.id}|${req.user.id}|${req.sender}`;
        if (req.isClaude && messages.length) readUpTo.set(key, Math.max(readUpTo.get(key) || 0, ...messages.map((m) => m.number)));
    };

    router.get('/chats/:id/messages', (req, res) => {
        const { since, before } = position(req);
        const messages = store.messages(req.chat.id, { since, before, limit: req.query.limit });
        if (!before) remember(req, messages);
        if (req.query.format !== 'text') return res.json({ messages });
        res.type('text/plain; charset=utf-8').send(asText(messages, { chat: req.chat, me: req.user.name, next: before ? 0 : messages.at(-1)?.number || store.lastNumber(req.chat.id) }));
    });

    router.post('/chats/:id/messages', open, json, text, (req, res) => {
        const body = typeof req.body === 'string' ? req.body : req.body?.text;
        const message = clean(body, MAX_TEXT);
        if (!message) return bad(res, 'Leeg bericht.');
        const { tags, outside, unknown } = findTags(message, req.chat.id);
        const saved = post(req, message, null, false, tags);
        res.json({ message: saved, notInChat: outside, unknownTags: unknown, ...tagWarning(req.chat.id, outside, unknown) });
    });

    // The person (not their Claude) has seen the chat up to this message
    router.post('/chats/:id/read', humanOnly, json, (req, res) => {
        store.markRead(req.chat.id, req.user.id, Number(req.body?.upTo) || 0);
        res.json({ ok: true });
    });

    router.get('/chats/:id/wait', async (req, res) => {
        // Without tv the asker does not care about typing (a Claude listener): only messages wake it up
        const tv = req.query.tv === undefined ? null : Number(req.query.tv) || 0;
        const messages = await waitMessages(req, res, {
            tv, timeout: req.query.timeout, wakeOnTags: req.query.wake === 'claude', bundle: req.query.bundle, map: req.query.map, peek: req.query.peek === '1',
        });
        if (!messages) return;
        if (req.query.format !== 'text') return res.json({ messages, ...typingNow(req.chat.id) });
        // A Claude knows what it wrote itself
        const others = messages.filter((m) => m.sender !== req.sender);
        res.type('text/plain; charset=utf-8').send(others.length ? asText(others, { chat: req.chat, me: req.user.name, next: messages.at(-1).number }) : '');
    });

    // Waits (max 300 s) until there is something after the reader's position (see position()), for the route above
    // and for the MCP tool "wachten". null when the asker went away.
    // peek: only look (the MCP listener), so "lezen" still gets the messages afterwards
    async function waitMessages(req, res, { tv = null, timeout, wakeOnTags = false, bundle: bundleSeconds = 0, map = '', peek = false }) {
        const { since, byNumber } = position(req);
        const until = Date.now() + Math.min(Math.max(Number(timeout) || 60, 1), 300) * 1000;
        // wake=claude (a Claude listener): only a message that tags this Claude (@Claude-Name or @Claude) wakes it up;
        // all messages in between come along (people and other Claudes). bundle=1: then wait 1 s more, so a quick reply comes in the same go.
        const mine = req.sender;
        const bundle = Math.min(Math.max(Number(bundleSeconds) || 0, 0), 60);
        const wakes = (list) => (wakeOnTags
            ? list.some((m) => m.sender !== mine && !m.isEvent && (m.tags || []).some((t) => t.claude && t.name === req.user.name))
            : list.length > 0);
        // shortcut: a listener sees at most 500 messages since its last wake-up; more in between would hide a tag after them
        const limit = wakeOnTags ? 500 : 200;
        let messages = store.messages(req.chat.id, { since, limit });
        // A Claude that waits here is "listening live" (the others see its icon turn green)
        const p = req.isClaude ? presenceOf(req.chat.id, req.user.id) : null;
        if (p) {
            if (!isListening(p)) bump(req.chat.id);
            p.waiting += 1;
            // map = the folder the session works in: its permission questions then come to this chat
            if (map) permissions.connect({ user: req.user, cwd: map, chatId: req.chat.id, sender: req.sender });
        }
        try {
            while (!wakes(messages) && (since > 0 || byNumber) && (tv === null || typingNow(req.chat.id).tv === tv) && Date.now() < until && !res.destroyed) {
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
        if (res.writableEnded || res.destroyed) return null;
        if (!peek) remember(req, messages);
        return messages;
    }

    router.post('/chats/:id/typing', open, json, (req, res) => {
        const sender = req.sender;
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
            const { tags, outside, unknown } = findTags(caption, req.chat.id);
            res.json({ message: post(req, caption, fileId, false, tags), notInChat: outside, unknownTags: unknown, ...tagWarning(req.chat.id, outside, unknown) });
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
        const by = req.sender;
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
        // the session name from ?sessie= (first time) or the X-Sessie header (already in the commands)
        const session = sessionName(req.query.sessie ?? req.get('x-sessie'));
        if (session === null) return bad(res, 'Sessienaam: 1 tot 24 tekens, alleen letters, cijfers, spatie, punt, - of _.');
        const address = `${req.protocol}://${req.get('host')}`;
        if (req.query.deel === 'meer') return res.type('text/markdown; charset=utf-8').send(claudeDetails({ address, chat: req.chat, session }));
        res.type('text/markdown; charset=utf-8').send(claudeInstructions({ address, chat: req.chat, name: req.user.name, session, members: store.members(req.chat.id), autonomy: store.autonomy(req.chat.id) }));
    });

    // ---------- permission questions of Claude Code, answered in the app (see suite/permissions.js) ----------
    //   GET  /api/claude-hook.ps1            the hook script for the person's pc (installed by the command at their key)
    //   POST /api/permissions                (Claude, from the hook) { cwd, tool, input } -> { connected, id, decision }
    //   GET  /api/permissions/:pid/wait      (Claude) waits for the answer -> { decision: allow | deny | null, message }
    //   GET  /api/permissions?seen=<ids>     (person) my open questions; waits until they differ from "seen"
    //   POST /api/permissions/:pid           (person, only the one whose Claude asks) { allow: true | false }
    router.get('/claude-hook.ps1', (req, res) => {
        res.type('text/plain; charset=utf-8').send(claudeHook({ address: `${req.protocol}://${req.get('host')}` }));
    });

    // Claude's multiple choice questions (AskUserQuestion): 1-4 questions with 2-4 options, kept to what the page shows
    const questionsOf = (input) => (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).map((q) => ({
        question: clean(q?.question, 500), header: clean(q?.header, 40), multiSelect: q?.multiSelect === true,
        options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map((o) => ({ label: clean(o?.label, 120), description: clean(o?.description, 400), preview: clean(o?.preview, 4000) })),
    })).filter((q) => q.question);

    // What the Claude wants to do, in one readable text
    function describe(tool, input) {
        const i = input && typeof input === 'object' ? input : {};
        if (tool === 'AskUserQuestion') {
            const questions = questionsOf(i);
            return { about: '', questions, text: clean(questions.map((q) => `${q.question} (${q.options.map((o) => o.label).join(' / ')})`).join('\n'), 4000) };
        }
        const main = tool === 'Bash' || tool === 'PowerShell' ? i.command
            : ['Edit', 'MultiEdit', 'Write', 'Read', 'NotebookEdit'].includes(tool) ? i.file_path || i.notebook_path
                : tool === 'WebFetch' ? i.url : null;
        return { about: clean(i.description, 300), text: clean(main || JSON.stringify(i, null, 1), 4000) };
    }
    const asPerson = (r) => {
        const person = store.user(r.userId);
        return { chat: store.chat(r.chatId), user: person, isClaude: false, sender: person?.name };
    };
    const forPage = (r) => ({ id: r.id, chatId: r.chatId, chatTitle: store.chat(r.chatId)?.title || '', sender: r.sender, tool: r.tool, about: r.about, text: r.text, questions: r.questions || null, expires: new Date(r.expires).toISOString() });
    const denyMessage = (r) => (!r.by ? `Geen antwoord in ClaudeSuite binnen ${ANSWER_MINUTES} minuten: geweigerd.`
        : r.questions ? `${r.by} wilde de vraag niet beantwoorden in ClaudeSuite.` : `Geweigerd in ClaudeSuite door ${r.by}.`);
    const answerText = (r) => Object.entries(r.answers || {}).map(([q, a]) => `${q} → ${[a].flat().join(', ')}`).join('\n');
    function finish(r, decision, by) {
        permissions.decide(r, decision, by);
        const where = asPerson(r);
        if (where.chat && where.user) {
            if (by && r.questions) note(where, decision === 'allow' ? `heeft ${r.sender} geantwoord:\n${answerText(r)}` : `wilde de vraag van ${r.sender} niet beantwoorden.`);
            else if (by) note(where, `heeft ${r.sender} ${decision === 'allow' ? 'toestemming gegeven' : 'geen toestemming gegeven'}: ${r.tool}`);
            else note({ ...where, isClaude: true, sender: r.sender }, `kreeg binnen ${ANSWER_MINUTES} minuten geen antwoord op de toestemmingsvraag: geweigerd.`);
        }
        waiters.notify(`perm:${r.userId}`, { all: false });
        waiters.notify(`perm-req:${r.id}`, { all: false });
    }
    // No answer in time counts as no
    const settle = (r) => {
        if (!r.decision && Date.now() >= r.expires) finish(r, 'deny', '');
        return r;
    };

    router.post('/permissions', json, (req, res) => {
        if (!req.isClaude) return bad(res, 'Dit is alleen voor een Claude.', 403);
        const link = permissions.connectionOf(req.user, req.body?.cwd);
        const chat = link && store.chat(link.chatId);
        // not taking part in a chat: Claude Code asks in the terminal as usual
        if (!chat || chat.archived || !store.isMember(chat.id, req.user.id)) return res.json({ connected: false });
        const tool = clean(req.body?.tool, 100) || 'onbekend';
        const r = permissions.add({ user: req.user, chatId: chat.id, sender: link.sender, tool, ...describe(tool, req.body?.input) });
        // the others in the chat read along; only the person can answer
        note({ chat, user: req.user, isClaude: true, sender: link.sender }, r.questions
            ? `stelt ${req.user.name} een vraag:\n${r.text}`
            : `vraagt ${req.user.name} om toestemming: ${tool}${r.about ? ` (${r.about})` : ''}\n${r.text}`);
        waiters.notify(`perm:${req.user.id}`, { all: false });
        res.json({ connected: true, id: r.id, decision: null });
    });

    router.get('/permissions/:pid/wait', async (req, res) => {
        const r = permissions.get(req.params.pid);
        if (!req.isClaude || !r || r.userId !== req.user.id) return bad(res, 'Deze vraag bestaat niet.', 404);
        const until = Math.min(r.expires + 1000, Date.now() + 280_000);
        while (!settle(r).decision && Date.now() < until && !res.destroyed) await waiters.wait(`perm-req:${r.id}`, (until - Date.now()) / 1000, res);
        if (res.destroyed) return;
        res.json({ id: r.id, decision: r.decision, message: r.decision === 'deny' ? denyMessage(r) : '', ...(r.answers ? { answers: r.questions.map((q) => r.answers[q.question]) } : {}) });
    });

    router.get('/permissions', humanOnly, async (req, res) => {
        const seen = String(req.query.seen ?? '');
        const ids = () => permissions.openFor(req.user.id).map((r) => r.id).sort().join(',');
        const until = Date.now() + Math.min(Math.max(Number(req.query.timeout) || 0, 0), 300) * 1000;
        while (req.query.seen !== undefined && ids() === seen && Date.now() < until && !res.destroyed) await waiters.wait(`perm:${req.user.id}`, (until - Date.now()) / 1000, res);
        if (res.destroyed) return;
        res.json({ requests: permissions.openFor(req.user.id).map(forPage) });
    });

    router.post('/permissions/:pid', humanOnly, json, (req, res) => {
        const r = permissions.get(req.params.pid);
        if (!r || r.userId !== req.user.id) return bad(res, 'Deze vraag bestaat niet, of is niet aan jou.', 404);
        if (settle(r).decision) return bad(res, 'Deze vraag is al beantwoord of verlopen.', 409);
        // A multiple choice question: the answers per question (a label, several labels, or own text)
        if (r.questions && req.body?.allow === true) {
            const given = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
            const answers = {};
            for (const q of r.questions) {
                const value = [given[q.question]].flat().map((a) => clean(a, 2000)).filter(Boolean);
                if (!value.length) return bad(res, `Kies een antwoord bij: ${q.question}`);
                answers[q.question] = q.multiSelect ? value : value[0];
            }
            r.answers = answers;
        }
        finish(r, req.body?.allow === true ? 'allow' : 'deny', req.user.name);
        res.json({ ok: true, decision: r.decision });
    });

    // A message, and wake up everyone waiting on this chat
    function post(req, message, fileId = null, isEvent = false, tags = []) {
        const chatId = req.chat.id;
        const saved = store.addMessage({ chatId, user: req.user, isClaude: req.isClaude, isEvent, text: message, fileId, tags, sender: req.sender });
        // whoever posts is no longer typing or thinking
        const entry = typingOf(chatId);
        if (entry.who.delete(saved.sender)) entry.version += 1;
        waiters.notify(chatId);
        return saved;
    }
    // A short note of the app itself ("heeft Chris toegevoegd"), in the name of whoever did it
    const note = (req, message, tags = []) => post(req, message, null, true, tags);

    // @Name tags a person, @Claude-Name their Claude (no matter the capitals). Tags only count for members;
    // names of people who are not in the chat come back, so the page can offer to add them.
    function findTags(text, chatId) {
        const lower = String(text).toLowerCase();
        // the name must end there: "@Pe" is not a tag in "@Pepijn"
        // ...but a full stop at the end of a sentence ("@Chris.") is not part of the name
        const endsAt = (pos) => {
            const next = lower[pos] || '';
            if (next === '.') return !/[\p{L}\p{N}_-]/u.test(lower[pos + 1] || '');
            return !/[\p{L}\p{N}_-]/u.test(next);
        };
        const has = (token) => {
            for (let i = lower.indexOf(token); i !== -1; i = lower.indexOf(token, i + 1)) {
                if (endsAt(i + token.length)) return true;
            }
            return false;
        };
        const tags = [];
        const outside = [];
        if (!lower.includes('@')) return { tags, outside, unknown: [] };
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
        // @Claude on its own: every Claude in this chat
        if (has('@claude')) {
            for (const member of store.members(chatId)) {
                if (!tags.some((t) => t.claude && t.userId === member.id)) tags.push({ userId: member.id, claude: true });
            }
        }
        // An @ that is no person, no Claude and not @Claude: a typo or someone who is gone. It comes back, so the
        // writer hears it instead of the tag silently doing nothing. (Not in e-mail addresses: the @ must start a word.)
        const names = store.users().map((u) => u.name.toLowerCase());
        const known = ['claude', ...names, ...names.map((n) => `claude-${n}`)];
        const unknown = [];
        for (const match of String(text).matchAll(/(?<![\p{L}\p{N}_.@-])@([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/gu)) {
            const at = match.index;
            const isKnown = known.some((k) => lower.startsWith(`@${k}`, at) && endsAt(at + k.length + 1));
            if (!isKnown && !unknown.includes(match[1])) unknown.push(match[1]);
        }
        return { tags, outside, unknown };
    }
    // For the writer (mostly a Claude): which tags did nothing, and how the people in this chat are tagged
    function tagWarning(chatId, outside, unknown) {
        if (!outside.length && !unknown.length) return {};
        const members = store.members(chatId).map((m) => `@${m.name} / @Claude-${m.name}`).join(', ');
        const parts = [unknown.length ? `${unknown.map((u) => `@${u}`).join(', ')} bestaat niet` : '', outside.length ? `${outside.join(', ')} zit${outside.length === 1 ? '' : 'ten'} niet in deze chat` : ''].filter(Boolean);
        return { warning: `Let op: ${parts.join('; ')}, dus die tag doet niets. Taggen in deze chat: ${members}, of @Claude voor alle Claudes.` };
    }

    // ---------- MCP: ClaudeSuite as tools inside Claude Code (POST /api/mcp, JSON-RPC over HTTP, only for a Claude) ----------
    // Installed once per pc: claude mcp add --transport http -s user claudesuite <address>/api/mcp --header "Authorization: Bearer csk_..."
    // No curl, no temporary files, no key in commands, and Claude Code asks permission per tool.
    // Each Claude Code window is its own MCP session (header Mcp-Session-Id): "meedoen" gives it a chat and a session name.
    const mcpSessions = new Map(); // Mcp-Session-Id -> { chatId, session, at }
    const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
    const chatArg = { type: 'integer', description: 'Nummer van de chat (zie "chats"). Weglaten = de chat waar je met "meedoen" in zit.' };
    const MCP_TOOLS = [
        { name: 'chats', description: 'Mijn ClaudeSuite-chats: nummer, titel, beschrijving, ongelezen, getagd.', inputSchema: { type: 'object', properties: {} } },
        { name: 'meedoen', description: 'Doe mee met een chat. Geeft de afspraken van die chat, de deelnemers met hun tagnaam en wat je nog niet las. Doe dit eerst.',
            inputSchema: { type: 'object', properties: { chat: { type: 'integer', description: 'Nummer van de chat' }, sessie: { type: 'string', description: 'Korte naam voor deze sessie als je persoon meer Claude-vensters heeft, bijv. de repo (Kasper). Je schrijft dan als "Claude (Naam · Kasper)".' } }, required: ['chat'] } },
        { name: 'lezen', description: 'Berichten lezen. Standaard wat je nog niet zag. #12 is voor iedereen hetzelfde nummer.',
            inputSchema: { type: 'object', properties: { chat: chatArg, na: { type: 'integer', description: 'Alleen berichten na #na' }, voor: { type: 'integer', description: 'Oudere berichten, voor #voor' } } } },
        { name: 'schrijven', description: 'Een bericht plaatsen. @Naam tagt een mens, @Claude-Naam diens Claude, @Claude alle Claudes. Een vraag aan een Claude altijd met tag.',
            inputSchema: { type: 'object', properties: { chat: chatArg, tekst: { type: 'string' } }, required: ['tekst'] } },
        { name: 'wachten', description: 'Wacht (max 280 s) tot je getagd wordt en geeft dan alle berichten sinds je laatste lezen. "Niets" na de tijd.',
            inputSchema: { type: 'object', properties: { chat: chatArg, seconden: { type: 'integer', description: 'Hoe lang maximaal (standaard 120)' } } } },
        { name: 'onderwerp', description: 'onderwerp.md lezen: het gedeelde geheugen van de chat (besluiten, wie wat doet, open punten), met de versie.',
            inputSchema: { type: 'object', properties: { chat: chatArg } } },
        { name: 'onderwerp_opslaan', description: 'onderwerp.md opslaan. Geef de versie mee die je net las; is iemand je voor, lees dan opnieuw en pas je wijziging daarop toe.',
            inputSchema: { type: 'object', properties: { chat: chatArg, tekst: { type: 'string' }, versie: { type: 'integer' } }, required: ['tekst', 'versie'] } },
        { name: 'status', description: 'Laat de anderen zien dat je nadenkt ("Claude (Naam) denkt na"), of stop dat.',
            inputSchema: { type: 'object', properties: { chat: chatArg, soort: { type: 'string', enum: ['denkt', 'stop'] }, seconden: { type: 'integer' } }, required: ['soort'] } },
        { name: 'wie_ben_ik', description: 'Controle: als wie schrijf ik, en op welk adres zit ClaudeSuite.', inputSchema: { type: 'object', properties: {} } },
    ];

    async function mcpCall(req, res, name, args) {
        const sessionId = String(req.get('mcp-session-id') || '');
        const mine = mcpSessions.get(sessionId) || { chatId: 0, session: '' };
        if (name === 'meedoen') {
            const session = sessionName(args.sessie);
            if (session === null) throw new Error('Sessienaam: 1 tot 24 tekens, alleen letters, cijfers, spatie, punt, - of _.');
            Object.assign(mine, { chatId: Number(args.chat) || 0, session, at: Date.now() });
            if (sessionId) {
                if (mcpSessions.size > 500) mcpSessions.delete(mcpSessions.keys().next().value);
                mcpSessions.set(sessionId, mine);
            }
        }
        const as = mine.session ? `Claude (${req.user.name} · ${mine.session})` : `Claude (${req.user.name})`;
        if (name === 'chats') return store.chatsFor(req.user.id).map((c) => `${c.id}: ${c.title}${c.description ? ` (${c.description})` : ''}${c.unread ? `, ${c.unread} ongelezen` : ''}${c.tagged ? ', getagd' : ''}`).join('\n') || 'Geen chats.';
        if (name === 'wie_ben_ik') return `Je schrijft als "${as}". ClaudeSuite: ${req.protocol}://${req.get('host')} (Tailscale: ${TAILSCALE_ADDRESS}).${mine.chatId ? ` Je doet mee in chat ${mine.chatId}.` : ''}`;
        // everything else is about one chat that this person is in
        const chat = store.chat(Number(args.chat) || mine.chatId);
        if (!chat || !store.isMember(chat.id, req.user.id)) throw new Error('Geen (geldige) chat. Gebruik eerst "chats" en dan "meedoen".');
        const r = { chat, user: req.user, isClaude: true, sender: as, query: {} };
        claudeSeen(chat.id, req.user.id);
        const readText = (query) => {
            r.query = query;
            const { since, before } = position(r);
            const messages = store.messages(chat.id, { since, before });
            if (!before) remember(r, messages);
            return asText(messages, { chat, me: req.user.name, next: before ? 0 : messages.at(-1)?.number || store.lastNumber(chat.id) });
        };
        if (name === 'meedoen') {
            return `${claudeMcpRules({ address: `${req.protocol}://${req.get('host')}`, chat, name: req.user.name, me: as, session: mine.session, members: store.members(chat.id), autonomy: store.autonomy(chat.id) })}\n## Nog niet gelezen\n${readText({ after: 'laatst' })}`;
        }
        if (name === 'lezen') return readText(args.voor ? { voor: args.voor } : { after: args.na ?? 'laatst' });
        if (name === 'schrijven') {
            if (chat.archived) throw new Error('Deze chat is gearchiveerd.');
            const message = clean(args.tekst, MAX_TEXT);
            if (!message) throw new Error('Leeg bericht.');
            const { tags, outside, unknown } = findTags(message, chat.id);
            const saved = post(r, message, null, false, tags);
            return `Geplaatst als #${saved.number}.${tagWarning(chat.id, outside, unknown).warning ? ` ${tagWarning(chat.id, outside, unknown).warning}` : ''}`;
        }
        if (name === 'wachten') {
            r.query = { after: 'laatst' };
            const messages = await waitMessages(r, res, { timeout: Math.min(Number(args.seconden) || 120, 280), wakeOnTags: true, bundle: 1 });
            const others = (messages || []).filter((m) => m.sender !== as);
            return others.length ? asText(others, { chat, me: req.user.name, next: messages.at(-1).number }) : 'Niets: je bent niet getagd in die tijd.';
        }
        if (name === 'onderwerp') {
            const brief = store.brief(chat.id);
            return `onderwerp.md, versie ${brief.version}${brief.by ? ` (laatst door ${brief.by})` : ''}:\n\n${brief.text || '(nog leeg)'}`;
        }
        if (name === 'onderwerp_opslaan') {
            if (chat.archived) throw new Error('Deze chat is gearchiveerd.');
            if (!store.setBrief(chat.id, { text: String(args.tekst ?? '').replace(/\r\n/g, '\n').slice(0, MAX_BRIEF), version: args.versie, by: as })) {
                throw new Error(`Iemand anders heeft onderwerp.md intussen aangepast (nu versie ${store.brief(chat.id).version}). Lees opnieuw en pas je wijziging daarop toe.`);
            }
            note(r, `heeft onderwerp.md bijgewerkt (versie ${store.brief(chat.id).version}).`);
            return `Opgeslagen, versie ${store.brief(chat.id).version}.`;
        }
        if (name === 'status') {
            const stop = args.soort === 'stop';
            setTyping(chat.id, as, stop ? null : { kind: 'thinking', isClaude: true, until: Date.now() + Math.min(Math.max(Number(args.seconden) || 120, 1), 300) * 1000 });
            return stop ? 'Gestopt.' : 'De anderen zien nu dat je nadenkt.';
        }
        throw new Error(`Onbekende tool: ${name}`);
    }

    router.post('/mcp', guard, json, async (req, res) => {
        if (!req.isClaude) return bad(res, 'De MCP-server is voor een Claude (met de Claude-sleutel).', 403);
        const one = async (msg) => {
            const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
            if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Ongeldig verzoek' } };
            if (msg.id === undefined) return null; // a notification (initialized, cancelled): nothing to answer
            if (msg.method === 'initialize') {
                res.set('Mcp-Session-Id', crypto.randomBytes(16).toString('hex'));
                const asked = msg.params?.protocolVersion;
                return reply({ protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'claudesuite', version: '1.0.0' },
                    instructions: 'ClaudeSuite: chat met collega\'s en hun Claude. Begin met "chats" en "meedoen"; volg de afspraken die "meedoen" geeft.' });
            }
            if (msg.method === 'ping') return reply({});
            if (msg.method === 'tools/list') return reply({ tools: MCP_TOOLS });
            if (msg.method === 'tools/call') {
                try {
                    const text = await mcpCall(req, res, msg.params?.name, msg.params?.arguments || {});
                    return reply({ content: [{ type: 'text', text }] });
                } catch (error) {
                    return reply({ content: [{ type: 'text', text: error.message }], isError: true });
                }
            }
            return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Onbekend: ${msg.method}` } };
        };
        const batch = Array.isArray(req.body);
        const answers = (await Promise.all((batch ? req.body : [req.body]).map(one))).filter(Boolean);
        if (res.destroyed) return;
        if (!answers.length) return res.status(202).end();
        res.json(batch ? answers : answers[0]);
    });
    // No server-to-client stream; ending a session is fine
    router.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
    router.delete('/mcp', guard, (req, res) => {
        mcpSessions.delete(String(req.get('mcp-session-id') || ''));
        res.status(200).end();
    });

    return router;
}
