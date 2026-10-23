import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../suite/store.js';
import { createSessions } from '../suite/session.js';
import { createServer } from '../server.js';
import { isPrivateAddress } from '../suite/guard.js';

const ADMIN_PASSWORD = 'een-lang-beheer-wachtwoord';

async function start({ maxFileBytes = 1000 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudesuite-'));
    const store = createStore(dir, { firstPassword: ADMIN_PASSWORD });
    const sessions = createSessions({ secret: store.sessionSecret, hours: 1 });
    const server = createServer({ store, sessions, maxFileBytes }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (cookie) => async (method, url, body, headers = {}) => {
        const isText = typeof body === 'string' || body instanceof Buffer;
        const response = await fetch(base + url, {
            method,
            headers: { ...(cookie ? { cookie, 'x-suite': '1' } : {}), ...(body && !isText ? { 'content-type': 'application/json' } : {}), ...headers },
            body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
            redirect: 'manual',
        });
        const type = response.headers.get('content-type') || '';
        return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : await response.text() };
    };
    const login = async (name, password) => {
        const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
        assert.equal(response.status, 200, `login ${name}`);
        return response.headers.get('set-cookie').split(';')[0];
    };
    const claude = (key) => (method, url, body, headers = {}) => call(null)(method, url, body, { authorization: `Bearer ${key}`, ...headers });
    return { store, base, call, login, claude, close: () => { server.close(); store.close(); } };
}

// A new person through an invite link, logged in
async function invitePerson(s, admin, name, role = 'member') {
    const { data } = await admin('POST', '/api/invites', { role });
    const secret = data.link.split('/uitnodiging/')[1];
    const joined = await fetch(`${s.base}/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: secret, name, password: `${name}-wachtwoord-123` }) });
    assert.equal(joined.status, 200);
    return { secret, as: s.call(joined.headers.get('set-cookie').split(';')[0]) };
}

test('office only: private addresses yes, internet and proxies no', async () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.2.41', '10.0.0.5', '172.20.0.3', 'fd12:3456::1', '100.101.102.103', 'fd7a:115c:a1e0::1']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.63.0.1', '100.128.0.1', '::ffff:1.2.3.4', '2001:db8::1', '', 'abc']) assert.ok(!isPrivateAddress(ip), ip);
    const s = await start();
    try {
        assert.equal((await s.call(null)('GET', '/auth/session', undefined, { 'x-forwarded-for': '1.2.3.4' })).status, 403);
        assert.equal((await s.call(null)('GET', '/auth/session', undefined, { 'cf-connecting-ip': '1.2.3.4' })).status, 403);
        assert.equal((await s.call(null)('GET', '/auth/session')).status, 200);
    } finally {
        s.close();
    }
});

test('accounts: invite once, login link, wrong tries blocked, no secrets in the database', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { secret, as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        // an invite works once
        const again = await s.call(null)('POST', '/auth/join', { invite: secret, name: 'Ander', password: 'nog-een-wachtwoord' });
        assert.equal(again.status, 400);
        assert.equal((await pepijn('GET', '/api/me')).data.user.name, 'Pepijn');
        // a member cannot invite or see roles
        assert.equal((await pepijn('POST', '/api/invites', { role: 'admin' })).status, 403);
        // links come with the address in use and the Tailscale address
        assert.deepEqual((await admin('POST', '/api/invites', { role: 'member' })).data.links.map((l) => l.split('/uitnodiging/')[0]), [s.base, 'http://discountserver:8082']);
        // without a password: log in with only the name; with a password, an empty one is wrong
        const { data: invite } = await admin('POST', '/api/invites', { role: 'member' });
        await s.call(null)('POST', '/auth/join', { invite: invite.link.split('/uitnodiging/')[1], name: 'Zonder' });
        assert.equal((await s.call(null)('POST', '/auth/login', { name: 'zonder', password: '' })).status, 200);
        assert.equal((await s.call(null)('POST', '/auth/login', { name: 'Pepijn', password: '' })).status, 401);
        // a new role counts at once, without logging out
        const pepijnId = (await pepijn('GET', '/api/me')).data.user.id;
        assert.equal((await admin('PATCH', `/api/users/${pepijnId}`, { role: 'admin' })).status, 200);
        assert.equal((await pepijn('GET', '/api/invites')).status, 200);
        await admin('PATCH', `/api/users/${pepijnId}`, { role: 'member' });
        assert.equal((await pepijn('GET', '/api/invites')).status, 403);
        assert.equal((await pepijn('GET', '/api/users')).data.users[0].role, undefined);
        // changes need the X-Suite header (no CSRF)
        assert.equal((await pepijn('POST', '/api/me/login-link', undefined, { 'x-suite': '' })).status, 403);

        // personal login link: logs in, a new one replaces the old one
        const link = (await pepijn('POST', '/api/me/login-link')).data.link;
        const viaLink = await fetch(link.replace(/^http:\/\/[^/]+/, s.base), { redirect: 'manual' });
        assert.equal(viaLink.status, 302);
        assert.ok(viaLink.headers.get('set-cookie').startsWith('claudesuite='));
        await pepijn('POST', '/api/me/login-link');
        const old = await fetch(link.replace(/^http:\/\/[^/]+/, s.base), { redirect: 'manual' });
        assert.equal(old.headers.get('location'), '/?link=ongeldig');

        // only hashes in the database
        const db = fs.readFileSync(path.join(path.dirname(s.store.filePath('x')), '..', 'suite.db'));
        assert.ok(!db.includes(Buffer.from(secret)) && !db.includes(Buffer.from(link.split('/l/')[1])));

        // 5 wrong passwords: blocked
        for (let i = 0; i < 5; i += 1) await s.call(null)('POST', '/auth/login', { name: 'pepijn', password: 'fout' });
        assert.equal((await s.call(null)('POST', '/auth/login', { name: 'pepijn', password: 'Pepijn-wachtwoord-123' })).status, 429);
    } finally {
        s.close();
    }
});

test('chats: members only, Claude writes as "Claude (name)", Claude cannot manage, wait wakes up', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        const { as: buiten } = await invitePerson(s, admin, 'Buiten');

        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Update Kasper', description: 'Chat-overname live zetten', members: ['Chris'] })).data;
        assert.equal((await buiten('GET', `/api/chats/${chat.id}`)).status, 404);
        assert.equal((await buiten('GET', '/api/chats')).data.chats.length, 0);
        assert.deepEqual((await chris('GET', `/api/chats/${chat.id}`)).data.members.map((m) => m.name), ['Chris', 'Pepijn']);

        const key = (await pepijn('POST', '/api/me/claude-key')).data.key;
        const claudeP = s.claude(key);
        // Claude: chats yes, own account no
        assert.equal((await claudeP('GET', '/api/me')).status, 403);
        // the person can see the key again, their Claude cannot; not in plain text in the database
        assert.equal((await pepijn('GET', '/api/me/claude-key')).data.key, key);
        assert.equal((await claudeP('GET', '/api/me/claude-key')).status, 403);
        assert.ok(!fs.readFileSync(path.join(path.dirname(s.store.filePath('x')), '..', 'suite.db')).includes(Buffer.from(key)));
        assert.equal((await claudeP('POST', '/api/chats', { title: 'x' })).status, 403);
        assert.equal((await claudeP('GET', '/api/chats')).data.chats.length, 1);
        assert.equal((await s.claude('csk_ditiseenverkeerdesleutel1234')('GET', '/api/chats')).status, 401);

        // a waiting listener wakes up when someone writes
        const last = (await chris('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).id;
        const waiting = claudeP('GET', `/api/chats/${chat.id}/wait?since=${last}&timeout=20`);
        await new Promise((r) => setTimeout(r, 100));
        await chris('POST', `/api/chats/${chat.id}/messages`, { text: 'Kun jij de tests draaien?' });
        const woke = await waiting;
        assert.equal(woke.data.messages[0].sender, 'Chris');

        // plain text (no JSON quoting trouble on Windows), with accents
        const sent = await claudeP('POST', `/api/chats/${chat.id}/messages`, 'Tests: 79/79 geslaagd. Één ding: "quotes" werken.', { 'content-type': 'text/plain; charset=utf-8' });
        assert.equal(sent.data.message.sender, 'Claude (Pepijn)');
        assert.equal(sent.data.message.isClaude, true);
        assert.match(sent.data.message.text, /Één ding: "quotes"/);
        // nothing new: the wait ends empty after the timeout
        const quiet = await chris('GET', `/api/chats/${chat.id}/wait?since=${sent.data.message.id}&timeout=1`);
        assert.deepEqual(quiet.data.messages, []);

        // archived: read yes, write no; back from the archive: write again
        await pepijn('PATCH', `/api/chats/${chat.id}`, { archived: true });
        assert.equal((await chris('GET', '/api/chats?archived=1')).data.chats.length, 1);
        assert.equal((await claudeP('POST', `/api/chats/${chat.id}/messages`, { text: 'hoi' })).status, 400);
        await chris('PATCH', `/api/chats/${chat.id}`, { archived: false });
        assert.equal((await claudeP('POST', `/api/chats/${chat.id}/messages`, { text: 'hoi' })).status, 200);
    } finally {
        s.close();
    }
});

test('files: straight to disk, size limit, members only, never run as a page', async () => {
    const s = await start({ maxFileBytes: 1000 });
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: buiten } = await invitePerson(s, admin, 'Buiten');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Logs' })).data;

        const up = await pepijn('POST', `/api/chats/${chat.id}/files?name=..%2F..%2Fevil%22.html&text=De%20log`, '<script>alert(1)</script>', { 'content-type': 'text/html' });
        assert.equal(up.status, 200);
        const file = up.data.message.file;
        assert.equal(file.name, 'evil.html');
        assert.equal(up.data.message.text, 'De log');

        const down = await pepijn('GET', `/api/files/${file.id}`);
        assert.equal(down.data, '<script>alert(1)</script>');
        assert.equal(down.headers.get('content-type'), 'application/octet-stream');
        assert.match(down.headers.get('content-disposition'), /^attachment;/);
        assert.equal((await buiten('GET', `/api/files/${file.id}`)).status, 404);

        assert.equal((await pepijn('POST', `/api/chats/${chat.id}/files?name=groot.bin`, Buffer.alloc(2000), { 'content-type': 'application/octet-stream' })).status, 413);
        assert.equal(fs.readdirSync(path.dirname(s.store.filePath('x'))).length, 1, 'a refused file leaves nothing behind');
    } finally {
        s.close();
    }
});

test('onderwerp.md: versions, refused when someone saved in between, download', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Facturen afletteren', brief: '# Afletteren\n\n- dagboek MultiSafepay' })).data;
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);

        const first = (await claudeP('GET', `/api/chats/${chat.id}/brief`)).data.brief;
        assert.equal(first.version, 1);
        const saved = await claudeP('PUT', `/api/chats/${chat.id}/brief?version=1`, `${first.text}\n- besloten: bij verzending`, { 'content-type': 'text/plain; charset=utf-8' });
        assert.equal(saved.data.brief.version, 2);
        assert.equal(saved.data.brief.by, 'Claude (Pepijn)');
        // someone started from version 1 too: refused, gets the newest back
        const late = await pepijn('PUT', `/api/chats/${chat.id}/brief`, { text: 'oud', version: 1 });
        assert.equal(late.status, 409);
        assert.equal(late.data.brief.version, 2);

        const md = await pepijn('GET', `/api/chats/${chat.id}/onderwerp.md`);
        assert.match(md.headers.get('content-disposition'), /Facturen-afletteren\.md/);
        assert.match(md.data, /besloten: bij verzending/);
        // a new chat started from it
        const next = (await pepijn('POST', '/api/chats', { title: 'Vervolg', brief: md.data })).data.chat;
        assert.match((await pepijn('GET', `/api/chats/${next.id}/brief`)).data.brief.text, /bij verzending/);

        const how = await pepijn('GET', `/api/chats/${chat.id}/claude.md`);
        assert.match(how.data, /Claude \(Pepijn\)/);
        assert.ok(!how.data.includes('csk_'), 'the key itself is never in the instructions');
    } finally {
        s.close();
    }
});

test('live: typing and thinking wake the chat, a post ends them; the chat list hears about new chats', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');

        // Chris's chat list waits; Pepijn makes a chat with Chris in it: the list wakes up
        const { latest } = (await chris('GET', '/api/chats')).data;
        const listWait = chris('GET', `/api/chats-changed?since=${latest}&timeout=20`);
        await new Promise((r) => setTimeout(r, 100));
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Samen', members: ['Chris'] })).data;
        assert.ok((await listWait).data.latest > latest);

        const first = (await chris('GET', `/api/chats/${chat.id}/wait?since=0&tv=0`)).data;
        const last = first.messages.at(-1).id;
        // Chris waits with the typing version; Claude (Pepijn) starts thinking: it wakes up with that
        const waiting = chris('GET', `/api/chats/${chat.id}/wait?since=${last}&tv=${first.tv}&timeout=20`);
        await new Promise((r) => setTimeout(r, 100));
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);
        await claudeP('POST', `/api/chats/${chat.id}/typing`, { kind: 'thinking', seconds: 60 });
        // first wake-up: Claude (Pepijn) shows up in the chat (the icon at Pepijn)
        assert.deepEqual((await waiting).data.messages, []);
        // ask again with an old typing version: answers at once with how things are now
        const woke = (await chris('GET', `/api/chats/${chat.id}/wait?since=${last}&tv=-1`)).data;
        assert.deepEqual(woke.claudes.map((c) => c.name), ['Pepijn']);
        assert.equal(woke.claudes[0].listening, false, 'used, but not waiting live');
        assert.equal(woke.typing[0].sender, 'Claude (Pepijn)');
        assert.equal(woke.typing[0].kind, 'thinking');
        // a Claude listener without tv is not woken by typing, only by messages
        const listener = claudeP('GET', `/api/chats/${chat.id}/wait?since=${last}&timeout=1`);
        await pepijn('POST', `/api/chats/${chat.id}/typing`, { kind: 'typing' });
        assert.deepEqual((await listener).data.messages, []);
        // posting ends the thinking
        await claudeP('POST', `/api/chats/${chat.id}/messages`, { text: 'Klaar met nadenken.' });
        const after = (await chris('GET', `/api/chats/${chat.id}/wait?since=${last}&tv=${woke.tv}`)).data;
        assert.ok(!after.typing.some((t) => t.sender === 'Claude (Pepijn)'));
        assert.ok(after.typing.some((t) => t.sender === 'Pepijn' && t.kind === 'typing'));
    } finally {
        s.close();
    }
});

test('no password: invite only, one-time device link; zelf handelen only when everyone agreed', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { data } = await admin('POST', '/api/invites', { role: 'member' });
        const joined = await fetch(`${s.base}/auth/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: data.link.split('/uitnodiging/')[1], name: 'Roel' }) });
        assert.equal(joined.status, 200, 'an account without a password');
        const roel = s.call(joined.headers.get('set-cookie').split(';')[0]);
        assert.equal((await roel('GET', '/api/me')).data.user.hasPassword, false);
        assert.equal((await s.call(null)('POST', '/auth/login', { name: 'Roel', password: '' })).status, 200, 'no password = log in with only the name');

        // a device link works once
        const link = (await roel('POST', '/api/me/login-link')).data.link.replace(/^http:\/\/[^/]+/, s.base);
        assert.ok((await fetch(link, { redirect: 'manual' })).headers.get('set-cookie'));
        assert.equal((await fetch(link, { redirect: 'manual' })).headers.get('location'), '/?link=ongeldig');
        // a beheerder can make a recovery link
        const recovery = (await admin('POST', `/api/users/${(await roel('GET', '/api/me')).data.user.id}/login-link`)).data.link;
        assert.match(recovery, /\/l\/csl_/);

        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Samen bouwen', members: ['Chris'] })).data;
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);
        assert.equal((await claudeP('POST', `/api/chats/${chat.id}/autonomy`, { agree: true })).status, 403, 'only people decide');

        let auto = (await pepijn('POST', `/api/chats/${chat.id}/autonomy`, { agree: true })).data.autonomy;
        assert.equal(auto.active, false);
        assert.deepEqual(auto.waiting, ['Chris']);
        assert.match((await claudeP('GET', `/api/chats/${chat.id}/claude.md`)).data, /Zelf handelen: nu UIT/);
        auto = (await chris('POST', `/api/chats/${chat.id}/autonomy`, { agree: true })).data.autonomy;
        assert.equal(auto.active, true);
        assert.equal((await claudeP('GET', `/api/chats/${chat.id}`)).data.autonomy.active, true);
        assert.match((await claudeP('GET', `/api/chats/${chat.id}/claude.md`)).data, /Zelf handelen: nu AAN/);
        // a new member must agree too
        await pepijn('POST', `/api/chats/${chat.id}/members`, { name: 'Roel' });
        assert.equal((await pepijn('GET', `/api/chats/${chat.id}`)).data.autonomy.active, false);
        await roel('POST', `/api/chats/${chat.id}/autonomy`, { agree: true });
        assert.equal((await pepijn('GET', `/api/chats/${chat.id}`)).data.autonomy.active, true);
        // one person says no: off
        await chris('POST', `/api/chats/${chat.id}/autonomy`, { agree: false });
        assert.equal((await pepijn('GET', `/api/chats/${chat.id}`)).data.autonomy.active, false);
        // ...for everyone: no old yes stays behind, so one new yes does not turn it back on
        assert.deepEqual((await pepijn('GET', `/api/chats/${chat.id}`)).data.autonomy.agreed, []);
        // a "no" to a fresh proposal also ends it for everyone, also from someone who had not agreed yet
        await pepijn('POST', `/api/chats/${chat.id}/autonomy`, { agree: true });
        await roel('POST', `/api/chats/${chat.id}/autonomy`, { agree: false });
        assert.deepEqual((await pepijn('GET', `/api/chats/${chat.id}`)).data.autonomy.agreed, []);
        const events = (await pepijn('GET', `/api/chats/${chat.id}/messages`)).data.messages.filter((m) => m.isEvent).map((m) => m.text).join('\n');
        assert.match(events, /stelt voor dat de Claudes/);
        assert.match(events, /staat nu AAN/);
        assert.match(events, /heeft zelf handelen uitgezet/);

        // a password can be added later, without a current one
        assert.equal((await roel('POST', '/api/me/password', { next: 'roel-kiest-toch-een' })).status, 200);
        assert.equal((await s.call(null)('POST', '/auth/login', { name: 'Roel', password: 'roel-kiest-toch-een' })).status, 200);
    } finally {
        s.close();
    }
});

test('unread and tags: counts per chat, @name and @Claude-name, being added lights up, not in chat comes back', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        await invitePerson(s, admin, 'Roel');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Tags', members: ['Chris'] })).data;

        // being added counts as a tag for Chris
        let mine = (await chris('GET', '/api/chats')).data.chats[0];
        assert.equal(mine.tagged, 1);

        const sent = (await pepijn('POST', `/api/chats/${chat.id}/messages`, { text: '@chris kijk even, en @Claude-Chris draai de tests. @Roel ook?' })).data;
        assert.deepEqual(sent.message.tags.map((t) => `${t.name}:${t.claude}`).sort(), ['Chris:false', 'Chris:true']);
        assert.deepEqual(sent.notInChat, ['Roel']);
        // "@Pe" is not a tag in "@Pepijn"
        assert.deepEqual((await chris('POST', `/api/chats/${chat.id}/messages`, { text: 'mail naar @Pe of pepijn@laboratoriumdiscounter.nl' })).data.message.tags, []);

        mine = (await chris('GET', '/api/chats')).data.chats[0];
        assert.equal(mine.unread, 1, 'own messages and app notes do not count');
        assert.equal(mine.tagged, 2);
        // reading resets both; Claude cannot mark read for the person
        const claudeC = s.claude((await chris('POST', '/api/me/claude-key')).data.key);
        assert.equal((await claudeC('POST', `/api/chats/${chat.id}/read`, { upTo: sent.message.id })).status, 403);
        // a number past the newest message only marks up to the newest one
        await chris('POST', `/api/chats/${chat.id}/read`, { upTo: 999999 });
        mine = (await chris('GET', '/api/chats')).data.chats[0];
        assert.equal(mine.unread, 0);
        assert.equal(mine.tagged, 0);
        assert.equal((await pepijn('GET', '/api/chats')).data.chats[0].unread, 1, 'Pepijn has not read the message of Chris');
        await pepijn('POST', `/api/chats/${chat.id}/messages`, { text: 'nog eentje' });
        assert.equal((await chris('GET', '/api/chats')).data.chats[0].unread, 1, 'a later message is new again');
    } finally {
        s.close();
    }
});

test('presence: a waiting Claude listener shows as live; general CLAUDE.md piece between markers', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Live' })).data;
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);
        const last = (await pepijn('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).id;
        const listening = claudeP('GET', `/api/chats/${chat.id}/wait?since=${last}&timeout=2`);
        await new Promise((r) => setTimeout(r, 150));
        assert.deepEqual((await pepijn('GET', `/api/chats/${chat.id}`)).data.claudes, [{ name: 'Pepijn', color: 0 + (await pepijn('GET', '/api/me')).data.user.color, listening: true }]);
        await listening;

        const setup = (await claudeP('GET', '/api/claude-setup.md')).data;
        assert.match(setup, /^<!-- claudesuite:start -->/);
        assert.match(setup, /<!-- claudesuite:end -->\n$/);
        assert.match(setup, /@Claude-Pepijn/);
        assert.ok(!setup.includes('csk_'), 'the key itself is never in it');
    } finally {
        s.close();
    }
});

test('message numbers count per chat, from 1; an old database gets them once', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const a = (await pepijn('POST', '/api/chats', { title: 'Eerste' })).data.chat;
        const b = (await pepijn('POST', '/api/chats', { title: 'Tweede' })).data.chat;
        await pepijn('POST', `/api/chats/${a.id}/messages`, { text: 'a1' });
        await pepijn('POST', `/api/chats/${b.id}/messages`, { text: 'b1' });
        await pepijn('POST', `/api/chats/${a.id}/messages`, { text: 'a2' });
        assert.deepEqual((await pepijn('GET', `/api/chats/${a.id}/messages`)).data.messages.map((m) => m.number), [1, 2, 3]);
        assert.deepEqual((await pepijn('GET', `/api/chats/${b.id}/messages`)).data.messages.map((m) => m.number), [1, 2]);
    } finally {
        s.close();
    }

    // a database from before the numbers: they are filled in once, per chat, in order
    const { DatabaseSync } = await import('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudesuite-old-'));
    const old = new DatabaseSync(path.join(dir, 'suite.db'));
    old.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER, sender TEXT NOT NULL, is_claude INTEGER NOT NULL DEFAULT 0, is_event INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', file_id INTEGER, created TEXT NOT NULL)");
    for (const chat of [7, 8, 7, 7, 8]) old.prepare('INSERT INTO messages (chat_id, sender, created) VALUES (?, ?, ?)').run(chat, 'x', '2026-10-23');
    old.close();
    const store = createStore(dir, { firstPassword: ADMIN_PASSWORD });
    assert.deepEqual(store.messages(7).map((m) => m.number), [1, 2, 3]);
    assert.deepEqual(store.messages(8).map((m) => m.number), [1, 2]);
    store.close();
});

test('for a Claude: messages as text, older pages, the listener only wakes on a tag or another Claude, then bundles', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Kasper', members: ['Chris'] })).data;
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);
        const claudeC = s.claude((await chris('POST', '/api/me/claude-key')).data.key);
        const say = (who, text) => who('POST', `/api/chats/${chat.id}/messages`, { text });

        await say(chris, 'Regel een\nregel twee');
        const page = (await claudeP('GET', `/api/chats/${chat.id}/messages?format=text`)).data;
        assert.match(page, /^# Chat \d+ "Kasper"/);
        assert.match(page, /#\d+ \d\d:\d\d Chris: Regel een\n {4}regel twee/);
        const last = Number(page.match(/\?after=(\d+)/)[1]);
        // older pages: everything before an id
        const older = (await claudeP('GET', `/api/chats/${chat.id}/messages?format=text&voor=${last}`)).data;
        assert.ok(!older.includes('Regel een') && !older.includes('?after='));

        // a human message without a tag does not wake the listener; a tag does, and both come along
        const listening = claudeP('GET', `/api/chats/${chat.id}/wait?after=${last}&timeout=20&wake=claude&bundle=1&format=text`);
        await new Promise((r) => setTimeout(r, 100));
        await say(chris, 'Gewoon een opmerking');
        await new Promise((r) => setTimeout(r, 200));
        await say(chris, '@Claude-Pepijn kun jij kijken?');
        await new Promise((r) => setTimeout(r, 200));
        await say(claudeC, 'Ik kijk ook mee');
        const woke = (await listening).data;
        assert.match(woke, /Chris: Gewoon een opmerking/);
        assert.match(woke, /Chris: \[VOOR JOU\] @Claude-Pepijn/);
        assert.match(woke, /Claude \(Chris\): Ik kijk ook mee/); // bundled
        // only own messages: no wake-up, and the own Claude's messages are left out
        const next = Number(woke.match(/\?after=(\d+)/)[1]);
        await say(claudeP, 'Ik kijk');
        assert.equal((await claudeP('GET', `/api/chats/${chat.id}/wait?after=${next}&timeout=1&wake=claude&format=text`)).data, '');
        // another Claude without a tag does not wake it either; with @Claude-Pepijn it does, and the earlier one comes along
        await say(claudeC, 'Klaar');
        assert.equal((await claudeP('GET', `/api/chats/${chat.id}/wait?after=${next}&timeout=1&wake=claude&format=text`)).data, '');
        await say(claudeC, '@Claude-Pepijn wil jij de tests draaien?');
        const done = (await claudeP('GET', `/api/chats/${chat.id}/wait?after=${next}&timeout=5&wake=claude&format=text`)).data;
        assert.ok(done.includes('Claude (Chris): Klaar') && done.includes('[VOOR JOU] @Claude-Pepijn') && !done.includes('Ik kijk\n'));
        // @Claude on its own: every Claude in the chat
        const afterDone = Number(done.match(/\?after=(\d+)/)[1]);
        await say(pepijn, '@Claude wat vinden jullie?');
        assert.match((await claudeP('GET', `/api/chats/${chat.id}/wait?after=${afterDone}&timeout=5&wake=claude&format=text`)).data, /Pepijn: \[VOOR JOU\] @Claude wat/);
        assert.match((await claudeC('GET', `/api/chats/${chat.id}/wait?after=${afterDone}&timeout=5&wake=claude&format=text`)).data, /\[VOOR JOU\] @Claude wat/);

        // short instruction, details on request
        const core = (await claudeP('GET', `/api/chats/${chat.id}/claude.md`)).data;
        assert.ok(core.length < 5200, `core is ${core.length} characters`);
        assert.match(core, /Deelnemers nu: Chris \(@Chris, Claude: @Claude-Chris\), Pepijn/);
        assert.match((await claudeP('GET', `/api/chats/${chat.id}/claude.md?deel=meer`)).data, /onderwerp\.md/);

        // a tag that is nobody, or someone outside the chat: the writer hears it
        const typo = (await say(claudeP, '@Claude-Groen en @Chriss, kijken jullie? Mail: a@b.nl')).data;
        assert.deepEqual(typo.unknownTags, ['Claude-Groen', 'Chriss']);
        assert.match(typo.warning, /@Claude-Groen, @Chriss bestaat niet.*Taggen in deze chat: @Chris \/ @Claude-Chris, @Pepijn \/ @Claude-Pepijn/);
        assert.equal((await say(claudeP, '@Claude-Chris. En @Pepijn!')).data.warning, undefined);

        // after=laatst: a session (also a restarted one) gets what it did not see yet, once
        const keyP = (await pepijn('GET', '/api/me/claude-key')).data.key;
        const restarted = (m, u) => s.claude(keyP)(m, u, undefined, { 'x-sessie': 'Nieuw' });
        assert.match((await restarted('GET', `/api/chats/${chat.id}/messages?format=text&after=laatst`)).data, /: 0 berichten/);
        await say(chris, 'Iets nieuws');
        assert.match((await restarted('GET', `/api/chats/${chat.id}/messages?format=text&after=laatst`)).data, /Chris: Iets nieuws/);
        assert.match((await restarted('GET', `/api/chats/${chat.id}/messages?format=text&after=laatst`)).data, /: 0 berichten/);

        // whoami: is my key right, and as whom do I write
        assert.deepEqual((await restarted('GET', '/api/whoami')).data.writesAs, 'Claude (Pepijn · Nieuw)');
        assert.match((await s.claude('csk_ditiseenverkeerdesleutel1234')('GET', '/api/whoami')).data.message, /klopt niet \(meer\) voor http:\/\/127\.0\.0\.1/);
    } finally {
        s.close();
    }
});

test('several Claude sessions of one person: each its own name, they wake each other', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Twee sessies' })).data;
        const key = (await pepijn('POST', '/api/me/claude-key')).data.key;
        const kasper = (m, u, b) => s.claude(key)(m, u, b, { 'x-sessie': 'Kasper' });
        const facturen = (m, u, b) => s.claude(key)(m, u, b, { 'x-sessie': 'Facturen' });
        assert.equal((await s.claude(key)('GET', '/api/chats', undefined, { 'x-sessie': 'mag<niet>' })).status, 400);

        const first = (await kasper('POST', `/api/chats/${chat.id}/messages`, { text: 'Ik doe Kasper' })).data.message;
        assert.equal(first.sender, 'Claude (Pepijn · Kasper)');
        // the other session of the same person wakes the listener, its own message does not
        const listening = kasper('GET', `/api/chats/${chat.id}/wait?since=${first.id}&timeout=10&wake=claude&format=text`);
        await new Promise((r) => setTimeout(r, 100));
        await facturen('POST', `/api/chats/${chat.id}/messages`, { text: '@Claude-Pepijn ik doe Facturen' });
        assert.match((await listening).data, /Claude \(Pepijn · Facturen\): \[VOOR JOU\] @Claude-Pepijn ik doe Facturen/);

        // the instruction carries the session header in its commands
        const md = (await s.claude(key)('GET', `/api/chats/${chat.id}/claude.md?sessie=Kasper`)).data;
        assert.match(md, /"Claude \(Pepijn · Kasper\)"/);
        assert.match(md, /-H "X-Sessie: Kasper"/);
    } finally {
        s.close();
    }
});

test('permission questions: only for a session in a chat, only its own person answers, the others read along', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'Toestemming', members: ['Chris'] })).data;
        const claudeP = s.claude((await pepijn('POST', '/api/me/claude-key')).data.key);
        const ask = { cwd: 'C:\\Werk\\Kasper', tool: 'Bash', input: { command: 'npm test', description: 'Tests draaien' } };

        // not listening in a chat: Claude Code asks in the terminal
        assert.equal((await claudeP('POST', '/api/permissions', ask)).data.connected, false);
        assert.equal((await pepijn('POST', '/api/permissions', ask)).status, 403);
        // the listener from the same folder connects this session to the chat (capitals and closing slash do not matter)
        const last = (await claudeP('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).id;
        await claudeP('GET', `/api/chats/${chat.id}/wait?since=${last}&timeout=1&wake=claude&map=${encodeURIComponent('c:\\werk\\kasper\\')}`);
        const asked = (await claudeP('POST', '/api/permissions', ask)).data;
        assert.equal(asked.connected, true);

        // the person sees it, the others read along in the chat but cannot answer
        const open = (await pepijn('GET', '/api/permissions')).data.requests;
        assert.equal(open.length, 1);
        assert.equal(open[0].text, 'npm test');
        assert.equal((await chris('GET', '/api/permissions')).data.requests.length, 0);
        assert.equal((await chris('POST', `/api/permissions/${asked.id}`, { allow: true })).status, 404);
        const notes = (await chris('GET', `/api/chats/${chat.id}/messages`)).data.messages.map((m) => m.text).join('\n');
        assert.match(notes, /vraagt Pepijn om toestemming: Bash \(Tests draaien\)\nnpm test/);

        // the answer reaches the waiting hook; answering twice is refused
        const waiting = claudeP('GET', `/api/permissions/${asked.id}/wait`);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal((await pepijn('POST', `/api/permissions/${asked.id}`, { allow: true })).data.decision, 'allow');
        assert.equal((await waiting).data.decision, 'allow');
        assert.equal((await pepijn('POST', `/api/permissions/${asked.id}`, { allow: false })).status, 409);
        assert.equal((await pepijn('GET', '/api/permissions')).data.requests.length, 0);

        // a no comes back with the reason for Claude
        const second = (await claudeP('POST', '/api/permissions', ask)).data;
        await pepijn('POST', `/api/permissions/${second.id}`, { allow: false });
        assert.deepEqual((await claudeP('GET', `/api/permissions/${second.id}/wait`)).data, { id: second.id, decision: 'deny', message: 'Geweigerd in ClaudeSuite door Pepijn.' });

        // several Claudes (or people) right after each other: each one counts
        const two = (await pepijn('POST', `/api/chats/${chat.id}/messages`, { text: '@Claude-Pepijn @Claude-Chris @Chris dit is voor jullie' })).data;
        assert.deepEqual(two.message.tags.map((t) => `${t.name}:${t.claude}`).sort(), ['Chris:false', 'Chris:true', 'Pepijn:true']);

        // a multiple choice question of Claude: every question needs an answer; the answers come back in question order
        const questions = [
            { question: 'Welke database?', header: 'Database', multiSelect: false, options: [{ label: 'SQLite', description: 'Licht' }, { label: 'Postgres', description: 'Zwaar' }] },
            { question: 'Welke tests?', header: 'Tests', multiSelect: true, options: [{ label: 'Unit', description: '' }, { label: 'E2E', description: '' }] },
        ];
        const q = (await claudeP('POST', '/api/permissions', { cwd: ask.cwd, tool: 'AskUserQuestion', input: { questions } })).data;
        assert.equal((await pepijn('GET', '/api/permissions')).data.requests[0].questions[1].multiSelect, true);
        assert.equal((await pepijn('POST', `/api/permissions/${q.id}`, { allow: true, answers: { 'Welke database?': 'SQLite' } })).status, 400);
        await pepijn('POST', `/api/permissions/${q.id}`, { allow: true, answers: { 'Welke database?': ['SQLite'], 'Welke tests?': ['Unit', 'Iets anders'] } });
        assert.deepEqual((await claudeP('GET', `/api/permissions/${q.id}/wait`)).data.answers, ['SQLite', ['Unit', 'Iets anders']]);
        assert.match((await chris('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).text, /geantwoord:\nWelke database\? → SQLite\nWelke tests\? → Unit, Iets anders/);

        // the hook script for the pc never contains the key
        assert.ok(!(await claudeP('GET', '/api/claude-hook.ps1')).data.includes('csk_'));
    } finally {
        s.close();
    }
});

test('MCP: ClaudeSuite as tools in Claude Code; each window its own session name; the listener only peeks', async () => {
    const s = await start();
    try {
        const admin = s.call(await s.login('Admin', ADMIN_PASSWORD));
        const { as: pepijn } = await invitePerson(s, admin, 'Pepijn');
        const { as: chris } = await invitePerson(s, admin, 'Chris');
        const { chat } = (await pepijn('POST', '/api/chats', { title: 'MCP', members: ['Chris'] })).data;
        const key = (await pepijn('POST', '/api/me/claude-key')).data.key;
        let id = 0;
        const rpc = async (method, params, session) => {
            const response = await fetch(`${s.base}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
            return { status: response.status, session: response.headers.get('mcp-session-id'), body: await response.json() };
        };
        const tool = async (name, args, session) => (await rpc('tools/call', { name, arguments: args }, session)).body.result;

        const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        assert.equal(init.body.result.protocolVersion, '2025-06-18');
        const session = init.session;
        assert.ok(session);
        // a notification gets no answer
        const note = await fetch(`${s.base}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        assert.equal(note.status, 202);
        assert.ok((await rpc('tools/list', {}, session)).body.result.tools.some((t) => t.name === 'schrijven'));
        // people use the page, not the MCP server
        assert.equal((await pepijn('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403);

        assert.match((await tool('chats', {}, session)).content[0].text, new RegExp(`${chat.id}: MCP`));
        assert.equal((await tool('lezen', {}, session)).isError, true, 'first meedoen');
        const joined = (await tool('meedoen', { chat: chat.id, sessie: 'Kasper' }, session)).content[0].text;
        assert.match(joined, /als "Claude \(Pepijn · Kasper\)"/);
        assert.match(joined, /-H "X-Sessie: Kasper"/);
        assert.match((await tool('schrijven', { tekst: 'Hallo @Claude-Groen' }, session)).content[0].text, /Geplaatst als #\d+\. Let op: @Claude-Groen bestaat niet/);
        assert.equal((await chris('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).sender, 'Claude (Pepijn · Kasper)');

        // the background listener only peeks: after it wakes, "lezen" still gives the message
        const listener = s.claude(key)('GET', `/api/chats/${chat.id}/wait?after=laatst&peek=1&timeout=10&wake=claude&format=text`, undefined, { 'x-sessie': 'Kasper' });
        await new Promise((r) => setTimeout(r, 100));
        await chris('POST', `/api/chats/${chat.id}/messages`, { text: '@Claude-Pepijn kun je dit lezen?' });
        assert.match((await listener).data, /kun je dit lezen/);
        assert.match((await tool('lezen', {}, session)).content[0].text, /Chris: \[VOOR JOU\] @Claude-Pepijn kun je dit lezen\?/);
        assert.match((await tool('lezen', {}, session)).content[0].text, /: 0 berichten/);

        // wachten wakes on a tag
        const waiting = tool('wachten', { seconden: 10 }, session);
        await new Promise((r) => setTimeout(r, 100));
        await chris('POST', `/api/chats/${chat.id}/messages`, { text: '@Claude nog iets' });
        assert.match((await waiting).content[0].text, /Chris: \[VOOR JOU\] @Claude nog iets/);

        // onderwerp.md with versions
        const brief = (await tool('onderwerp', {}, session)).content[0].text;
        const version = Number(brief.match(/versie (\d+)/)[1]);
        assert.match((await tool('onderwerp_opslaan', { tekst: '# Besloten\n- MCP werkt', versie: version }, session)).content[0].text, /Opgeslagen/);
        assert.equal((await tool('onderwerp_opslaan', { tekst: 'oud', versie: version }, session)).isError, true);
        assert.match((await tool('status', { soort: 'denkt' }, session)).content[0].text, /nadenkt/);

        // another window of the same person without a session name writes as plain "Claude (Pepijn)"
        const other = (await rpc('initialize', { protocolVersion: '2025-06-18' })).session;
        await tool('meedoen', { chat: chat.id }, other);
        await tool('schrijven', { tekst: 'Ik ben het andere venster' }, other);
        assert.equal((await chris('GET', `/api/chats/${chat.id}/messages`)).data.messages.at(-1).sender, 'Claude (Pepijn)');
    } finally {
        s.close();
    }
});
