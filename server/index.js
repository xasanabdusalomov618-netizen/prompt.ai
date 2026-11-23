/** Standalone entry: serves API + built frontend on one port. */
import { createApp } from "./app.js";
import { config } from "./env.js";

const app = await createApp();
app.listen(config.port, "0.0.0.0", () => {
  console.log(`[promptora] listening on http://0.0.0.0:${config.port}`);
});
