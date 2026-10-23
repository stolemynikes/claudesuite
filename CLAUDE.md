# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

ClaudeSuite: chats on the Synology NAS of Laboratoriumdiscounter where colleagues and their own Claude Code sessions
talk to each other (for example: "I am updating Kasper, you are changing the panel"). Every chat has an onderwerp.md,
a shared living document (like a CLAUDE.md) with what was decided, who does what and what is still open.

Plain JavaScript (ES modules), Node 24+, Express (the only package), `node:sqlite`. The page in `public/` is plain
HTML/CSS/JS without libraries. Must stay light on the NAS: data on disk, no big things in memory.

## Commands

```
npm test        # node --test test/*.test.js, all must pass
npm start       # http://localhost:8082 (needs ADMIN_PASSWORD in .env the first time)
```

On Windows PowerShell use `npm.cmd` or `node`.

## Where things are

- `index.js` start, `server.js` the Express app, `config.js` settings from `.env`
- `suite/store.js` the SQLite database (users, invites, chats, members, messages, files, onderwerp.md)
- `suite/guard.js` office-network check, login (cookie) or Claude key (Bearer), roles
- `suite/waiters.js` long polling ("wait until there is something new")
- `suite/claudeInstructions.js` the text a person gives their Claude to join a chat
- `routes/authRoute.js` login, invite, personal login link; `routes/usersRoute.js` account + beheer; `routes/chatsRoute.js` chats

## Rules that must never be broken

1. **Office network only.** `officeOnly` refuses every request from outside a private network (Tailscale 100.64.0.0/10 counts as private) or through a proxy/tunnel. No tunnel to this container, never forward port 8082.
2. **Secrets only as a hash.** Passwords (scrypt), login links, Claude keys and invites are never stored or logged in plain text, and shown once only.
   Exception (owner's choice): the Claude key is also kept AES-encrypted so its person can see it again (`GET /api/me/claude-key`, never for a Claude). The encryption key is in the same database.
3. **Members only.** Every chat, message, file and onderwerp.md is only for members of that chat; the same 404 for "does not exist" and "not yours".
4. **Claude is not a person.** A Claude key can only read and write in the chats of its person; never accounts, keys, invites, new chats or members. Its messages are always marked "Claude (<name>)".
5. **Files never run as a page.** Only png/jpeg/gif/webp are shown inline; everything else is a download (`application/octet-stream`, `nosniff`). Uploads stream straight to disk with a size limit.
6. **Never `innerHTML`** in `public/app.js`: build with `h()` (textContent). No inline styles or scripts (CSP `'self'`).
7. **Every change needs `X-Suite: 1`** for cookie logins (CSRF). Keep the tests for every new input.
8. **Light**: no websockets, no polling every second, no whole files in memory.

## How to check your work

- `npm test` after every change.
- For page changes: run it locally, open it in headless Edge with a login link (`--user-data-dir` keeps the cookie) and look at a screenshot.
