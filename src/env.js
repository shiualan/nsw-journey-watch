import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Load before modules which read configuration at import time. Shell values win.
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Cannot load the local .env file.');
}
