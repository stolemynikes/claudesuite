import fs from 'node:fs';

// Load settings from the .env file (if it exists)
if (fs.existsSync('.env')) {
    process.loadEnvFile('.env');
}

const env = (name, fallback = '') => (process.env[name] || fallback).trim();

// Only for the office network: the port is opened on the NAS, never in the router, no tunnel
export const PORT = Number(env('PORT', '8082'));

// The database (chats, users) and the shared files
export const DATA_DIR = env('DATA_DIR', './data');

// The first password of the user "Admin" (at least 12 characters). After that it lives in the database (hashed).
export const FIRST_PASSWORD = env('ADMIN_PASSWORD');

// Forgotten password: set to true for one start, then ADMIN_PASSWORD is the password of "Admin" again
export const RESET_PASSWORD = env('ADMIN_PASSWORD_RESET') === 'true';

// How long a device stays logged in (default 30 days: many people use no password, only their invite or a device link)
export const SESSION_HOURS = Number(env('SESSION_HOURS', '720'));

// Largest file that can be shared in a chat
export const MAX_FILE_MB = Number(env('MAX_FILE_MB', '25'));
