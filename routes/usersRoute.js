import express from 'express';
import { apiGuard, humanOnly, adminOnly } from '../suite/guard.js';
import { ROLES } from '../suite/store.js';

// Your own account, and (beheerder) the other accounts and invites. Never for Claude.
//
//   GET    /api/me                      who am I
//   POST   /api/me/password             { current, next } (no current needed when you had no password yet)
//   POST   /api/me/login-link           a one-time device link, 15 minutes: log in on another device (phone)
//   DELETE /api/me/login-link
//   POST   /api/me/claude-key           a new Claude key (shown once; the old one stops working)
//   DELETE /api/me/claude-key
//   GET    /api/users                   names, to add people to a chat
//   POST   /api/invites { role }        (beheerder) an invite link for a new person
//   GET    /api/invites                 (beheerder)
//   PATCH  /api/users/:id { role }      (beheerder)
//   DELETE /api/users/:id               (beheerder)
//   POST   /api/users/:id/login-link    (beheerder) a one-time link, 60 minutes, for someone who lost every device
//   DELETE /api/users/:id/login-link    (beheerder) take back someone's device link
//   DELETE /api/users/:id/claude-key    (beheerder) take back someone's Claude key

export function usersRoute({ store, sessions }) {
    const router = express.Router();
    // Only on these paths: the chats route is mounted on /api too, and Claude may use that one
    router.use(['/me', '/users', '/invites'], apiGuard({ store, sessions }), humanOnly, express.json({ limit: '4kb' }));
    const origin = (req) => `${req.protocol}://${req.get('host')}`;

    router.get('/me', (req, res) => res.json({ user: store.user(req.user.id) }));

    router.post('/me/password', (req, res) => {
        const next = String(req.body?.next || '');
        if (req.user.hasPassword && !store.checkPassword(req.user.id, String(req.body?.current || ''))) return res.status(400).json({ message: 'Je huidige wachtwoord klopt niet.' });
        if (!next) return res.status(400).json({ message: 'Kies een wachtwoord.' });
        store.setPassword(req.user.id, next);
        // this browser stays logged in, all others stop
        sessions.start(res, req.user.id, store.sessionVersion(req.user.id));
        res.json({ ok: true });
    });

    router.post('/me/login-link', (req, res) => res.json({ link: `${origin(req)}/l/${store.newLoginLink(req.user.id)}` }));
    router.delete('/me/login-link', (req, res) => {
        store.revokeLoginLink(req.user.id);
        res.json({ ok: true });
    });
    router.post('/me/claude-key', (req, res) => res.json({ key: store.newClaudeKey(req.user.id), address: origin(req) }));
    router.delete('/me/claude-key', (req, res) => {
        store.revokeClaudeKey(req.user.id);
        res.json({ ok: true });
    });

    router.get('/users', (req, res) => {
        const users = store.users();
        res.json({ users: req.user.role === 'admin' ? users : users.map(({ id, name, color }) => ({ id, name, color })) });
    });

    router.post('/invites', adminOnly, (req, res) => {
        const role = ROLES.includes(req.body?.role) ? req.body.role : 'member';
        res.json({ link: `${origin(req)}/uitnodiging/${store.newInvite({ role, by: req.user.id })}` });
    });
    router.get('/invites', adminOnly, (req, res) => res.json({ invites: store.invites() }));

    // A beheerder never removes or demotes himself (there must always be one)
    const other = (req, res, next) => {
        const target = store.user(req.params.id);
        if (!target) return res.status(404).json({ message: 'Deze gebruiker bestaat niet.' });
        if (target.id === req.user.id) return res.status(400).json({ message: 'Dit kan niet bij je eigen account.' });
        req.target = target;
        next();
    };
    router.patch('/users/:id', adminOnly, other, (req, res) => {
        if (!ROLES.includes(req.body?.role)) return res.status(400).json({ message: 'Onbekende rol.' });
        store.setRole(req.target.id, req.body.role);
        res.json({ ok: true });
    });
    router.delete('/users/:id', adminOnly, other, (req, res) => {
        store.removeUser(req.target.id);
        res.json({ ok: true });
    });
    router.post('/users/:id/login-link', adminOnly, other, (req, res) => {
        res.json({ link: `${origin(req)}/l/${store.newLoginLink(req.target.id, 60)}` });
    });
    router.delete('/users/:id/login-link', adminOnly, other, (req, res) => {
        store.revokeLoginLink(req.target.id);
        res.json({ ok: true });
    });
    router.delete('/users/:id/claude-key', adminOnly, other, (req, res) => {
        store.revokeClaudeKey(req.target.id);
        res.json({ ok: true });
    });

    return router;
}
