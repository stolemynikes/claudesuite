import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Everything ClaudeSuite keeps, in one SQLite file (data/suite.db): users, invites, chats, members, messages,
// shared files (the files themselves are in data/files) and the onderwerp.md of every chat.
// Secrets (passwords, login links, Claude keys, invites) are only stored as a hash: a copy of the database
// does not let anyone log in.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
    password_hash TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, color INTEGER NOT NULL DEFAULT 0,
    login_hash TEXT UNIQUE, login_expires TEXT, claude_hash TEXT UNIQUE, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
    hash TEXT PRIMARY KEY, role TEXT NOT NULL, created_by INTEGER, created TEXT NOT NULL, expires TEXT NOT NULL, used_by INTEGER);
CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_by INTEGER, created TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, brief TEXT NOT NULL DEFAULT '', brief_version INTEGER NOT NULL DEFAULT 0,
    brief_by TEXT NOT NULL DEFAULT '', brief_at TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS members (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS autonomy (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, agreed TEXT NOT NULL, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS reads (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS mentions (message_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, claude INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (message_id, user_id, claude));
CREATE INDEX IF NOT EXISTS mentions_user ON mentions (user_id, chat_id, message_id);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, user_id INTEGER, name TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, stored TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER, sender TEXT NOT NULL,
    is_claude INTEGER NOT NULL DEFAULT 0, is_event INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '', file_id INTEGER, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
`;

export const ROLES = ['member', 'admin'];
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,29}$/;
const INVITE_DAYS = 7;

const now = () => new Date().toISOString();
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
// A new secret: shown once, only its hash is kept
const newSecret = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

export function createStore(dataDir, { firstPassword = '', resetPassword = false } = {}) {
    fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, 'suite.db'));
    // Light on the NAS: at most ~2 MB page cache in memory, the rest stays on disk
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -2000; PRAGMA temp_store = FILE;');
    db.exec(SCHEMA);
    const one = (sql, ...args) => db.prepare(sql).get(...args) || null;
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    // Messages are numbered per chat (#1, #2, ...): "seq". Older databases get it once, numbered in order.
    if (!all('PRAGMA table_info(messages)').some((column) => column.name === 'seq')) {
        db.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
        db.exec('UPDATE messages SET seq = (SELECT COUNT(*) FROM messages m2 WHERE m2.chat_id = messages.chat_id AND m2.id <= messages.id)');
    }
    // The Claude key can be shown again (owner's choice): kept encrypted next to its hash. Older databases get the column once.
    if (!all('PRAGMA table_info(users)').some((column) => column.name === 'claude_key')) db.exec('ALTER TABLE users ADD COLUMN claude_key TEXT');
    const run = (sql, ...args) => db.prepare(sql).run(...args);

    // First start: a random session secret, and the user "Admin" with ADMIN_PASSWORD
    if (!one("SELECT value FROM settings WHERE key = 'sessionSecret'")) run("INSERT INTO settings VALUES ('sessionSecret', ?)", crypto.randomBytes(32).toString('hex'));
    const sessionSecret = one("SELECT value FROM settings WHERE key = 'sessionSecret'").value;
    // AES-256-GCM for the Claude key. shortcut: the encryption key lives in the same database, so this only keeps the key
    // out of plain sight; whoever has the whole database has the keys too (the owner accepted that to see a key again).
    const keyBox = crypto.createHash('sha256').update(`claude-key:${sessionSecret}`).digest();
    const seal = (text) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBox, iv);
        const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    };
    const unseal = (sealed) => {
        const [iv, tag, data] = String(sealed).split('.').map((part) => Buffer.from(part, 'base64url'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBox, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    };
    if (firstPassword) {
        const admin = one("SELECT id FROM users WHERE name_lower = 'admin'");
        if (!admin) addUser({ name: 'Admin', role: 'admin', password: firstPassword });
        else if (resetPassword) run('UPDATE users SET password_hash = ?, role = ?, session_version = session_version + 1 WHERE id = ?', hashPassword(firstPassword), 'admin', admin.id);
    }

    // Without a password the hash stays empty: logging in with a password is then impossible (only invite / device link)
    function addUser({ name, role, password = '' }) {
        // Every person their own colour: the next one of the palette (12 colours, see public/app.js)
        const color = one('SELECT COUNT(*) AS n FROM users').n % 12;
        const info = run('INSERT INTO users (name, name_lower, role, password_hash, color, created) VALUES (?, ?, ?, ?, ?, ?)', name, name.toLowerCase(), role, password ? hashPassword(password) : '', color, now());
        return user(Number(info.lastInsertRowid));
    }

    function user(id) {
        const row = one('SELECT id, name, role, color, password_hash, login_hash, login_expires, claude_hash, created FROM users WHERE id = ?', Number(id));
        return row ? {
            id: row.id, name: row.name, role: row.role, color: row.color, hasPassword: Boolean(row.password_hash),
            hasLoginLink: Boolean(row.login_hash && row.login_expires > now()), hasClaudeKey: Boolean(row.claude_hash), created: row.created,
        } : null;
    }

    const chatRow = (row) => (row ? { id: row.id, title: row.title, description: row.description, archived: Boolean(row.archived), created: row.created, createdBy: row.created_by_name || '', lastMessage: row.last_message || row.created, unread: row.unread || 0, tagged: row.tagged || 0 } : null);
    const messageRow = (row) => ({
        id: row.id, number: row.seq, chatId: row.chat_id, sender: row.sender, color: row.color ?? 0, isClaude: Boolean(row.is_claude), isEvent: Boolean(row.is_event), text: row.text, created: row.created,
        file: row.file_id ? { id: row.file_id, name: row.file_name, type: row.file_type, size: row.file_size } : null,
    });
    // Who was tagged in these messages: tags: [{ name, claude }]
    function withTags(messages) {
        if (!messages.length) return messages;
        const ids = messages.map((m) => m.id);
        const rows = all(`SELECT t.message_id, t.claude, u.name FROM mentions t JOIN users u ON u.id = t.user_id WHERE t.message_id IN (${ids.map(() => '?').join(',')})`, ...ids);
        for (const m of messages) m.tags = rows.filter((r) => r.message_id === m.id).map((r) => ({ name: r.name, claude: Boolean(r.claude) }));
        return messages;
    }
    const MESSAGE_SQL = `SELECT m.*, f.name AS file_name, f.type AS file_type, f.size AS file_size, u.color FROM messages m LEFT JOIN files f ON f.id = m.file_id LEFT JOIN users u ON u.id = m.user_id`;

    return {
        sessionSecret,
        hasUsers: () => Boolean(one('SELECT id FROM users LIMIT 1')),

        // ---------- users ----------
        addUser,
        user,
        userByName: (name) => {
            const row = one('SELECT id FROM users WHERE name_lower = ?', String(name || '').trim().toLowerCase());
            return row ? user(row.id) : null;
        },
        users: () => all('SELECT id FROM users ORDER BY name_lower').map((row) => user(row.id)),
        sessionVersion: (id) => one('SELECT session_version FROM users WHERE id = ?', Number(id))?.session_version ?? null,
        // The slow check always runs, so the answer time does not tell whether a name exists.
        // Someone without a password logs in with only their name (owner's choice: only office network / Tailscale).
        checkLogin(name, password) {
            const row = one('SELECT id, password_hash FROM users WHERE name_lower = ?', String(name || '').trim().toLowerCase());
            const ok = verifyPassword(password, row?.password_hash || DUMMY_HASH);
            if (row && !row.password_hash) return user(row.id);
            return row && ok ? user(row.id) : null;
        },
        checkPassword: (id, password) => verifyPassword(password, one('SELECT password_hash FROM users WHERE id = ?', Number(id))?.password_hash || DUMMY_HASH),
        // A new password ends every other login of this user
        setPassword: (id, password) => run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', hashPassword(password), Number(id)),
        // The role is read on every request, so it counts at once; no logout (someone without a password would be locked out)
        setRole: (id, role) => run('UPDATE users SET role = ? WHERE id = ?', role, Number(id)),
        removeUser(id) {
            run('DELETE FROM members WHERE user_id = ?', Number(id));
            run('DELETE FROM autonomy WHERE user_id = ?', Number(id));
            run('DELETE FROM users WHERE id = ?', Number(id));
        },

        // ---------- device link (one time, a few minutes) and Claude key; a new one replaces the old one ----------
        newLoginLink(id, minutes = 15) {
            const secret = newSecret('csl');
            run('UPDATE users SET login_hash = ?, login_expires = ? WHERE id = ?', sha256(secret), new Date(Date.now() + minutes * 60_000).toISOString(), Number(id));
            return secret;
        },
        newClaudeKey(id) {
            const secret = newSecret('csk');
            run('UPDATE users SET claude_hash = ?, claude_key = ? WHERE id = ?', sha256(secret), seal(secret), Number(id));
            return secret;
        },
        // The current key again ('' when there is none, or it was made before keys were kept)
        claudeKey(id) {
            const row = one('SELECT claude_hash, claude_key FROM users WHERE id = ?', Number(id));
            return row?.claude_hash && row.claude_key ? unseal(row.claude_key) : '';
        },
        revokeLoginLink: (id) => run('UPDATE users SET login_hash = NULL WHERE id = ?', Number(id)),
        revokeClaudeKey: (id) => run('UPDATE users SET claude_hash = NULL, claude_key = NULL WHERE id = ?', Number(id)),
        // Used up at once: the same link never works twice
        useLoginLink: (secret) => user(one('UPDATE users SET login_hash = NULL, login_expires = NULL WHERE login_hash = ? AND login_expires > ? RETURNING id', sha256(secret), now())?.id),
        userByClaudeKey: (secret) => user(one('SELECT id FROM users WHERE claude_hash = ?', sha256(secret))?.id),

        // ---------- invites: one link per new person, used once, valid for a week ----------
        newInvite({ role, by }) {
            const secret = newSecret('csi');
            run('INSERT INTO invites (hash, role, created_by, created, expires) VALUES (?, ?, ?, ?, ?)', sha256(secret), role, by, now(), new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString());
            return secret;
        },
        inviteValid: (secret) => Boolean(one('SELECT hash FROM invites WHERE hash = ? AND used_by IS NULL AND expires > ?', sha256(secret), now())),
        // Makes the account and uses up the invite, in one go (two clicks at once cannot make two accounts)
        useInvite(secret, { name, password }) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const invite = one('SELECT hash, role FROM invites WHERE hash = ? AND used_by IS NULL AND expires > ?', sha256(secret), now());
                if (!invite) throw Object.assign(new Error('Deze uitnodiging is al gebruikt of verlopen. Vraag een nieuwe.'), { status: 400 });
                if (one('SELECT id FROM users WHERE name_lower = ?', name.toLowerCase())) throw Object.assign(new Error('Deze naam bestaat al. Kies een andere.'), { status: 409 });
                const created = addUser({ name, role: invite.role, password });
                run('UPDATE invites SET used_by = ? WHERE hash = ?', created.id, invite.hash);
                db.exec('COMMIT');
                return created;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        },
        invites: () => all("SELECT i.role, i.created, i.expires, i.used_by, u.name AS used_name, c.name AS by_name FROM invites i LEFT JOIN users u ON u.id = i.used_by LEFT JOIN users c ON c.id = i.created_by ORDER BY i.created DESC LIMIT 50")
            .map((row) => ({ role: row.role, created: row.created, expires: row.expires, usedBy: row.used_name || '', by: row.by_name || '' })),

        // ---------- chats ----------
        createChat({ title, description = '', brief = '', by }) {
            const info = run('INSERT INTO chats (title, description, created_by, created, brief, brief_version, brief_by, brief_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                title, description, by.id, now(), brief, brief ? 1 : 0, brief ? by.name : '', brief ? now() : '');
            const id = Number(info.lastInsertRowid);
            run('INSERT INTO members (chat_id, user_id) VALUES (?, ?)', id, by.id);
            return this.chat(id);
        },
        chat: (id) => chatRow(one(`SELECT c.*, u.name AS created_by_name, (SELECT MAX(created) FROM messages WHERE chat_id = c.id) AS last_message
            FROM chats c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`, Number(id))),
        // The chats of one person, newest activity first
        // The chats of one person, newest activity first, with how many messages they did not read yet (not their own,
        // not the small app notes) and how often they were tagged (@name, or added to the chat) since then
        chatsFor: (userId, { archived = false } = {}) => all(`SELECT c.*, u.name AS created_by_name, (SELECT MAX(created) FROM messages WHERE chat_id = c.id) AS last_message,
                (SELECT COUNT(*) FROM messages x WHERE x.chat_id = c.id AND x.id > COALESCE(r.last_read, 0) AND x.is_event = 0 AND NOT (x.user_id = m.user_id AND x.is_claude = 0)) AS unread,
                (SELECT COUNT(*) FROM mentions t WHERE t.chat_id = c.id AND t.user_id = m.user_id AND t.claude = 0 AND t.message_id > COALESCE(r.last_read, 0)) AS tagged
            FROM chats c JOIN members m ON m.chat_id = c.id AND m.user_id = ? LEFT JOIN users u ON u.id = c.created_by
            LEFT JOIN reads r ON r.chat_id = c.id AND r.user_id = m.user_id
            WHERE c.archived = ? ORDER BY COALESCE(last_message, c.created) DESC`, Number(userId), archived ? 1 : 0).map(chatRow),
        // Read up to this message (only goes forward, and never past the newest message: later ones must still count as new)
        markRead(chatId, userId, upTo) {
            const newest = one('SELECT MAX(id) AS id FROM messages WHERE chat_id = ?', Number(chatId))?.id || 0;
            run('INSERT INTO reads (chat_id, user_id, last_read) VALUES (?, ?, ?) ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)',
                Number(chatId), Number(userId), Math.min(Number(upTo) || 0, newest));
        },
        updateChat(id, { title, description, archived }) {
            if (title !== undefined) run('UPDATE chats SET title = ? WHERE id = ?', title, Number(id));
            if (description !== undefined) run('UPDATE chats SET description = ? WHERE id = ?', description, Number(id));
            if (archived !== undefined) run('UPDATE chats SET archived = ? WHERE id = ?', archived ? 1 : 0, Number(id));
        },
        isMember: (chatId, userId) => Boolean(one('SELECT 1 AS x FROM members WHERE chat_id = ? AND user_id = ?', Number(chatId), Number(userId))),
        members: (chatId) => all('SELECT u.id, u.name, u.color FROM members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY u.name_lower', Number(chatId)),
        // A new member starts with everything before now as read: only what comes next counts as new
        addMember(chatId, userId) {
            run('INSERT OR IGNORE INTO members (chat_id, user_id) VALUES (?, ?)', Number(chatId), Number(userId));
            this.markRead(chatId, userId, one('SELECT MAX(id) AS id FROM messages WHERE chat_id = ?', Number(chatId))?.id || 0);
        },
        removeMember(chatId, userId) {
            run('DELETE FROM members WHERE chat_id = ? AND user_id = ?', Number(chatId), Number(userId));
            run('DELETE FROM autonomy WHERE chat_id = ? AND user_id = ?', Number(chatId), Number(userId));
        },

        // ---------- "Claudes mogen zelf handelen": only on when EVERY member agreed (a new member must agree too) ----------
        autonomy(chatId) {
            const members = all('SELECT u.id, u.name, a.agreed FROM members m JOIN users u ON u.id = m.user_id LEFT JOIN autonomy a ON a.chat_id = m.chat_id AND a.user_id = u.id WHERE m.chat_id = ? ORDER BY u.name_lower', Number(chatId));
            const agreed = members.filter((m) => m.agreed).map((m) => m.name);
            return { active: members.length > 0 && agreed.length === members.length, agreed, waiting: members.filter((m) => !m.agreed).map((m) => m.name) };
        },
        setAutonomy(chatId, userId, agree) {
            if (agree) run('INSERT OR IGNORE INTO autonomy (chat_id, user_id, agreed) VALUES (?, ?, ?)', Number(chatId), Number(userId), now());
            // one "no" ends it for everyone: the others must not be left with an old yes that turns it on again
            else run('DELETE FROM autonomy WHERE chat_id = ?', Number(chatId));
        },

        // ---------- messages ----------
        // isEvent: a short note of the app itself ("heeft Chris toegevoegd"), shown small
        // tags: [{ userId, claude }] (members only, worked out by the route from @name / @Claude-name)
        // sender: given by the route for a named Claude session ("Claude (Pepijn · Kasper)")
        addMessage({ chatId, user: author, isClaude = false, isEvent = false, text = '', fileId = null, tags = [], sender: given = '' }) {
            const sender = given || (isClaude ? `Claude (${author.name})` : author.name);
            // the next number within this chat, in the same statement (no gap, no double)
            const info = run('INSERT INTO messages (chat_id, user_id, sender, is_claude, is_event, text, file_id, created, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE chat_id = ?))',
                Number(chatId), author.id, sender, isClaude ? 1 : 0, isEvent ? 1 : 0, text, fileId, now(), Number(chatId));
            const id = Number(info.lastInsertRowid);
            for (const tag of tags) run('INSERT OR IGNORE INTO mentions (message_id, chat_id, user_id, claude) VALUES (?, ?, ?, ?)', id, Number(chatId), Number(tag.userId), tag.claude ? 1 : 0);
            return withTags([messageRow(one(`${MESSAGE_SQL} WHERE m.id = ?`, id))])[0];
        },
        // The newest message id in any of this person's chats (the chat list compares it to see if something changed)
        latestFor: (userId) => one('SELECT MAX(m.id) AS id FROM messages m JOIN members x ON x.chat_id = m.chat_id AND x.user_id = ?', Number(userId))?.id || 0,
        // Messages after id "since" (oldest first); without "since" the last ones, or the ones just before id "before"
        // (older pages, so the whole history stays readable)
        messages(chatId, { since = 0, before = 0, limit = 200 } = {}) {
            const max = Math.min(Math.max(Number(limit) || 200, 1), 500);
            if (Number(since) > 0) return withTags(all(`${MESSAGE_SQL} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`, Number(chatId), Number(since), max).map(messageRow));
            const below = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
            return withTags(all(`${MESSAGE_SQL} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, Number(chatId), below, max).map(messageRow).reverse());
        },

        // The chat's own numbers (#12) to the internal id: the last message with at most that number (0 = none)
        idAtNumber: (chatId, number) => one('SELECT MAX(id) AS id FROM messages WHERE chat_id = ? AND seq <= ?', Number(chatId), Number(number) || 0)?.id || 0,
        lastNumber: (chatId) => one('SELECT MAX(seq) AS n FROM messages WHERE chat_id = ?', Number(chatId))?.n || 0,

        // ---------- files ----------
        addFile({ chatId, userId, name, type, size, stored }) {
            const info = run('INSERT INTO files (chat_id, user_id, name, type, size, stored, created) VALUES (?, ?, ?, ?, ?, ?, ?)', Number(chatId), userId, name, type, size, stored, now());
            return Number(info.lastInsertRowid);
        },
        file: (id) => one('SELECT * FROM files WHERE id = ?', Number(id)),
        filePath: (stored) => path.join(dataDir, 'files', stored),

        // ---------- onderwerp.md: one living document per chat ----------
        brief(chatId) {
            const row = one('SELECT brief, brief_version, brief_by, brief_at FROM chats WHERE id = ?', Number(chatId));
            return row ? { text: row.brief, version: row.brief_version, by: row.brief_by, at: row.brief_at } : null;
        },
        // Only when nobody saved a newer version in between (version = the one you started from)
        setBrief(chatId, { text, version, by }) {
            const info = run('UPDATE chats SET brief = ?, brief_version = brief_version + 1, brief_by = ?, brief_at = ? WHERE id = ? AND brief_version = ?', text, by, now(), Number(chatId), Number(version));
            return info.changes === 1;
        },

        close: () => db.close(),
    };
}

// scrypt with a random salt: "scrypt$<salt>$<hash>" (same as NAS Beheer)
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
    const [, salt, hash] = String(stored).split('$');
    if (!salt || !hash) return false;
    const given = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
