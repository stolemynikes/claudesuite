import express from 'express';
import { currentUser } from '../suite/guard.js';
import { NAME_RE } from '../suite/store.js';

// Logging in without a password is the normal way: the invite link (/uitnodiging/csi_...) makes the account and keeps
// that device logged in (SESSION_HOURS, default 30 days). Another device is linked with a one-time device link
// (/l/csl_..., 15 minutes, made on a device that is already logged in, or by a beheerder after losing every device).
// A password is optional, for people who want one.
// After 5 wrong tries from the same computer (or for the same name) the next try has to wait 10 minutes.
//
//   GET  /auth/session            who is logged in
//   POST /auth/login              { name, password }
//   POST /auth/logout
//   GET  /auth/invite/:secret     is this invite still valid?
//   POST /auth/join               { invite, name, password? }  -> new account, this device logged in
//   GET  /l/:secret               one-time device link -> this device logged in, to the start page

const MAX_TRIES = 5;
const WAIT_MINUTES = 10;

export function authRoute({ store, sessions }) {
    const router = express.Router();
    const tries = new Map(); // "ip" or "name:<name>" -> { count, until }
    const blocked = (key) => (tries.get(key)?.until || 0) > Date.now();
    function failed(key) {
        const record = tries.get(key) || { count: 0, until: 0 };
        record.count += 1;
        if (record.count >= MAX_TRIES) Object.assign(record, { count: 0, until: Date.now() + WAIT_MINUTES * 60_000 });
        tries.set(key, record);
    }
    const tooMany = (res) => res.status(429).json({ message: `Te vaak geprobeerd. Wacht ${WAIT_MINUTES} minuten.` });
    const publicUser = (user) => ({ id: user.id, name: user.name, role: user.role });

    router.use('/auth', express.json({ limit: '4kb' }));

    router.get('/auth/session', (req, res) => {
        const user = currentUser(req, { store, sessions });
        res.set('Cache-Control', 'no-store').json({ user: user ? publicUser(user) : null });
    });

    router.post('/auth/login', (req, res) => {
        const name = String(req.body?.name || '').trim().slice(0, 30);
        const keys = [req.socket.remoteAddress, `name:${name.toLowerCase()}`];
        if (keys.some(blocked)) return tooMany(res);
        const user = store.checkLogin(name, String(req.body?.password || ''));
        if (!user) {
            keys.forEach(failed);
            console.log(`Wrong login from ${req.socket.remoteAddress}`);
            return res.status(401).json({ message: 'Naam of wachtwoord klopt niet.' });
        }
        keys.forEach((key) => tries.delete(key));
        sessions.start(res, user.id, store.sessionVersion(user.id));
        res.json({ user: publicUser(user) });
    });

    router.post('/auth/logout', (req, res) => {
        sessions.end(res);
        res.json({ ok: true });
    });

    router.get('/auth/invite/:secret', (req, res) => {
        if (blocked(req.socket.remoteAddress)) return tooMany(res);
        const valid = store.inviteValid(req.params.secret);
        if (!valid) failed(req.socket.remoteAddress);
        res.json({ valid });
    });

    router.post('/auth/join', (req, res) => {
        if (blocked(req.socket.remoteAddress)) return tooMany(res);
        const name = String(req.body?.name || '').trim();
        const password = String(req.body?.password || '');
        if (!NAME_RE.test(name)) return res.status(400).json({ message: 'Kies een naam van 2 tot 30 tekens: letters, cijfers, spatie, punt, - of _.' });
        try {
            const user = store.useInvite(String(req.body?.invite || ''), { name, password });
            sessions.start(res, user.id, store.sessionVersion(user.id));
            console.log(`New account: ${user.name}`);
            res.json({ user: publicUser(user) });
        } catch (error) {
            if (error.status === 400) failed(req.socket.remoteAddress);
            res.status(error.status || 500).json({ message: error.status ? error.message : 'Er ging iets mis.' });
        }
    });

    // The device link: works once, within its few minutes
    router.get('/l/:secret', (req, res) => {
        if (blocked(req.socket.remoteAddress)) return res.status(429).send('Te vaak geprobeerd. Wacht 10 minuten.');
        const user = store.useLoginLink(req.params.secret);
        if (!user) {
            failed(req.socket.remoteAddress);
            return res.redirect('/?link=ongeldig');
        }
        sessions.start(res, user.id, store.sessionVersion(user.id));
        res.redirect('/');
    });

    return router;
}
