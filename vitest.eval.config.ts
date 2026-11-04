import { defineConfig } from "vitest/config";

// `npm run eval:capture`: runs the capture fixtures against the real local
// Ollama. Not part of `npm test` (which never calls a model).
export default defineConfig({
  test: { include: ["src/**/*.eval.ts"], testTimeout: 15 * 60 * 1000 },
});
