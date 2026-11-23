/**
 * Vercel serverless entrypoint — catch-all for /api/*.
 * The Express app is the handler, so every API route behaves exactly as it
 * does in the standalone server (server/index.js).
 */
import { createApp } from "../server/app.js";

const appPromise = createApp();

export default async function handler(req, res) {
  const app = await appPromise;
  return app(req, res);
}
