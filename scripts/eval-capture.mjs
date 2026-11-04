// `npm run eval:capture [-- --model <name>] [-- --url <ollama url>]`
// Runs the capture fixtures against the real local Ollama (see
// src/lib/capture.eval.ts). Vitest does not accept unknown flags, so this
// wrapper reads them and passes them on as environment variables.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) env.OLLAMA_MODEL = args[++i];
  else if (args[i].startsWith("--model=")) env.OLLAMA_MODEL = args[i].slice(8);
  else if (args[i] === "--url" && args[i + 1]) env.OLLAMA_URL = args[++i];
  else {
    console.error(`Unknown option ${args[i]}. Use --model <name> or --url <ollama url>.`);
    process.exit(2);
  }
}
const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.eval.config.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
