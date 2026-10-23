// Permission questions of Claude Code ("may I run this command?"), asked in the app instead of the terminal.
// Claude Code's PermissionRequest hook sends them here, but only for a session that takes part in a chat: its live
// listener ran in that chat from the same folder in the last hour. Only in memory: after a restart an open question
// simply gets no answer, and the hook then says no.

import crypto from 'node:crypto';

const CONNECTED_MS = 60 * 60_000;
export const ANSWER_MINUTES = 5;

export function createPermissions() {
    const connections = new Map(); // "<userId>|<folder>" -> { chatId, sender, at }
    const requests = new Map(); // id -> { id, userId, chatId, sender, tool, about, text, created, expires, decision, by }
    // Windows folders: no difference between capitals, and with or without a closing slash
    const key = (userId, cwd) => `${userId}|${String(cwd || '').trim().replace(/[\\/]+$/, '').toLowerCase()}`;

    return {
        connect({ user, cwd, chatId, sender }) {
            connections.set(key(user.id, cwd), { chatId, sender, at: Date.now() });
        },
        connectionOf(user, cwd) {
            const found = connections.get(key(user.id, cwd));
            return found && Date.now() - found.at < CONNECTED_MS ? found : null;
        },
        add({ user, chatId, sender, tool, about, text, questions = null }) {
            // old answered or expired questions go, so the map stays small
            for (const [id, r] of requests) if (Date.now() - r.expires > CONNECTED_MS) requests.delete(id);
            const request = {
                id: crypto.randomBytes(12).toString('hex'), userId: user.id, chatId, sender, tool, about, text, questions, answers: null,
                created: Date.now(), expires: Date.now() + ANSWER_MINUTES * 60_000, decision: null, by: '',
            };
            requests.set(request.id, request);
            return request;
        },
        get: (id) => requests.get(String(id)) || null,
        // still waiting for an answer from this person
        openFor: (userId) => [...requests.values()].filter((r) => r.userId === userId && !r.decision && r.expires > Date.now()),
        decide(request, decision, by) {
            request.decision = decision;
            request.by = by;
        },
    };
}
