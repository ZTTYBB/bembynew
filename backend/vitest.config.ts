import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The data dir holds the downloaded browser and its profiles: thousands of files,
    // some of them written by whichever user ran the app, which is neither worth
    // scanning nor always readable from here.
    exclude: ["**/node_modules/**", "**/dist/**", "data/**"],
    watchExclude: ["**/node_modules/**", "data/**"],
    server: { watch: { ignored: ["**/data/**"] } },
  },
});
