import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@phantasy/agent",
    "@phantasy/agent/plugins",
    "@phantasy/agent/plugin-runtime",
    "@phantasy/agent/plugin-admin-ui",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".js",
    };
  },
});
