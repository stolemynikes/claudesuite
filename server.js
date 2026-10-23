import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { officeOnly } from './suite/guard.js';
import { createWaiters } from './suite/waiters.js';

//routes import
import { authRoute } from './routes/authRoute.js';
import { usersRoute } from './routes/usersRoute.js';
import { chatsRoute } from './routes/chatsRoute.js';

// The Express app, apart from index.js so the tests can use it without starting a server
export function createServer({ store, sessions, maxFileBytes = 25 * 1_048_576, waiters = createWaiters() }) {
    const app = express();
    app.disable('x-powered-by');
    const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

    // Health check for Docker, before the office check (it comes from inside the container)
    app.get('/health', (req, res) => res.send('ok'));

    app.use(officeOnly);
    // Protection headers: only our own files, no framing, no passing on of addresses
    app.use((req, res, next) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
        });
        next();
    });

    //ROUTES
    app.use('/', authRoute({ store, sessions }));
    app.use('/api', usersRoute({ store, sessions }));
    app.use('/api', chatsRoute({ store, sessions, waiters, maxFileBytes }));
    app.use('/api', (req, res) => res.status(404).json({ message: 'Onbekend adres.' }));
    app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
    // The page handles /uitnodiging/... and /chat/... itself
    app.get(/^\/(uitnodiging|chat)\//, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

    app.use((req, res) => res.status(404).send('Not found'));
    app.use((error, req, res, next) => {
        if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Te groot.' });
        if (error.type === 'entity.parse.failed') return res.status(400).json({ message: 'Ongeldige JSON.' });
        console.log(`Error on ${req.method} ${req.path}: ${error.message}`);
        if (res.headersSent) return next(error);
        res.status(500).json({ message: 'Er ging iets mis.' });
    });
    return app;
}
