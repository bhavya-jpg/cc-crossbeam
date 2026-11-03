// Loads server/.env for local runs. Imported first so that modules reading
// process.env at import time see it. Deployed servers have no file and set env directly.
try {
  process.loadEnvFile();
} catch {
  // No .env file present.
}
