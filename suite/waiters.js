// Long polling: someone (a browser or a Claude listener) asks "anything new after id X?" and the answer waits
// until there is a new message or the time is up. In rest this costs nothing: no timers per second, no sockets
// that stay busy. Per chat a small list of waiting answers.

export function createWaiters() {
    const byChat = new Map(); // chatId -> Set of functions

    return {
        // Resolves with true when the chat gets a new message, false after "seconds"
        wait(chatId, seconds, res) {
            return new Promise((resolve) => {
                const list = byChat.get(chatId) || new Set();
                byChat.set(chatId, list);
                let finished = false;
                const gone = () => done(false);
                const done = (news) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    res.off('close', gone);
                    list.delete(done);
                    if (!list.size && byChat.get(chatId) === list) byChat.delete(chatId);
                    resolve(news);
                };
                const timer = setTimeout(gone, seconds * 1000);
                list.add(done);
                // The asker went away (browser closed, Claude stopped): let go at once
                // (the response's close, not the request's: that one fires as soon as the request was read)
                res.on('close', gone);
            });
        },
        // Wakes the waiters of this chat, and (for a new message) the chat lists: they wait on "all".
        // Someone typing only wakes the chat itself.
        notify(chatId, { all = true } = {}) {
            for (const done of [...(byChat.get(chatId) || []), ...(all ? byChat.get('all') || [] : [])]) done(true);
        },
        count: () => [...byChat.values()].reduce((sum, list) => sum + list.size, 0),
    };
}
