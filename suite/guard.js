// Who may do what.
// - Only the office network: requests from outside a private network, or that came through a proxy or tunnel,
//   are always refused.
// - People log in with a cookie (password or personal login link). Changes also need the header "X-Suite: 1":
//   a browser on another website cannot send that (CSRF).
// - A Claude Code session uses its person's Claude key: "Authorization: Bearer csk_...". It writes as
//   "Claude (<name>)" and may only use the chats of that person, never users, invites or keys.

const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'cf-ray', 'ngrok-trace-id'];

// 127.x, 10.x, 172.16-31.x, 192.168.x, ::1, fc00::/7 (also as ::ffff:a.b.c.d), and Tailscale: 100.64-127.x and
// fd7a:115c:a1e0:: (inside fc00::/7). Only devices in our own Tailscale network get those addresses.
export function isPrivateAddress(address) {
    const ip = String(address || '').replace(/^::ffff:/, '');
    if (ip === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function officeOnly(req, res, next) {
    if (PROXY_HEADERS.some((name) => req.get(name)) || !isPrivateAddress(req.socket.remoteAddress)) {
        return res.status(403).json({ message: 'Alleen op het kantoornetwerk.' });
    }
    next();
}

export function currentUser(req, { store, sessions }) {
    const session = sessions.read(req);
    if (!session) return null;
    const user = store.user(session.userId);
    if (!user || store.sessionVersion(user.id) !== session.version) return null;
    return user;
}

export function apiGuard({ store, sessions }) {
    return (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const bearer = /^Bearer (csk_[A-Za-z0-9_-]{20,})$/.exec(req.get('authorization') || '');
        if (bearer) {
            const user = store.userByClaudeKey(bearer[1]);
            if (!user) return res.status(401).json({ message: 'Deze Claude-sleutel klopt niet (meer). Maak een nieuwe op je profiel.' });
            // One person can run several Claude Code sessions: each names itself with "X-Sessie: Kasper" and then
            // writes as "Claude (Pepijn · Kasper)". Without it: "Claude (Pepijn)".
            const session = sessionName(req.get('x-sessie'));
            if (session === null) return res.status(400).json({ message: 'X-Sessie: 1 tot 24 tekens, alleen letters, cijfers, spatie, punt, - of _.' });
            req.user = user;
            req.isClaude = true;
            req.sender = `Claude (${user.name}${session ? ` · ${session}` : ''})`;
            return next();
        }
        // "Bearer" with an empty or wrong key: say so, not "log in" (a Claude cannot log in)
        if (/^Bearer\b/i.test(req.get('authorization') || '')) return res.status(401).json({ message: 'De Claude-sleutel ontbreekt of klopt niet. Staat CLAUDESUITE_KEY op deze pc?' });
        const user = currentUser(req, { store, sessions });
        if (!user) return res.status(401).json({ message: 'Log opnieuw in.' });
        if (req.method !== 'GET' && req.get('x-suite') !== '1') return res.status(403).json({ message: 'Niet toegestaan.' });
        req.user = user;
        req.isClaude = false;
        req.sender = user.name;
        next();
    };
}

// '' = no session name, null = not allowed
export function sessionName(value) {
    const name = String(value ?? '').trim();
    if (!name) return '';
    return /^[A-Za-z0-9 ._-]{1,24}$/.test(name) ? name : null;
}

// Only people (not their Claude)
export const humanOnly = (req, res, next) => (req.isClaude ? res.status(403).json({ message: 'Dit kan alleen een mens, niet Claude.' }) : next());
// Only a beheerder
export const adminOnly = (req, res, next) => (!req.isClaude && req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Dit mag alleen een admin.' }));
