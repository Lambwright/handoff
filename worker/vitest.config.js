import { defineConfig } from "vitest/config";

// Plain node-environment unit tests over the pure helpers (customer-name
// normalization + match scoring, gate validation, checklist filtering, the
// create-pipeline step-resume logic, batched()). Route/integration tests that
// need Neon + R2 + the auth service binding run against `wrangler dev` by hand
// and via `npm run smoke` — see worker/README.md.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.js"],
  },
});
