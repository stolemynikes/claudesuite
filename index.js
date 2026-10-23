import { PORT, DATA_DIR, FIRST_PASSWORD, RESET_PASSWORD, SESSION_HOURS, MAX_FILE_MB } from './config.js';
import { createStore } from './suite/store.js';
import { createSessions } from './suite/session.js';
import { createServer } from './server.js';

// ClaudeSuite: chats on the NAS where colleagues and their Claude Code sessions talk to each other.
// Only for the office network: no tunnel goes here.

// A first password shorter than 12 characters is not accepted
const store = createStore(DATA_DIR, { firstPassword: FIRST_PASSWORD.length >= 12 ? FIRST_PASSWORD : '', resetPassword: RESET_PASSWORD });
if (RESET_PASSWORD) console.log('Password of "beheerder" reset to ADMIN_PASSWORD from .env. Remove ADMIN_PASSWORD_RESET from .env now.');
if (!store.hasUsers()) {
    console.log('Please set ADMIN_PASSWORD in the .env file first (at least 12 characters)');
    process.exit(1);
}
const sessions = createSessions({ secret: store.sessionSecret, hours: SESSION_HOURS });
const app = createServer({ store, sessions, maxFileBytes: MAX_FILE_MB * 1_048_576 });

const server = app.listen(PORT, () => console.log(`ClaudeSuite is running: http://<nas>:${PORT}`));
// Long waits (up to 5 minutes) must not be cut off by Node's own time limits
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000;

// Close the database cleanly when Docker stops the container
process.on('SIGTERM', () => {
    server.close();
    store.close();
    process.exit(0);
});
