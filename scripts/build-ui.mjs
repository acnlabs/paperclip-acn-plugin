#!/usr/bin/env node
/**
 * Build the plugin UI bundle using esbuild.
 * Output: dist/ui/index.js  (ESM, React bundled as external peer)
 */
import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await build({
  entryPoints: [join(root, "src/ui/index.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outdir: join(root, "dist/ui"),
  external: ["react", "react-dom", "@paperclipai/plugin-sdk"],
  jsx: "automatic",
  target: "es2022",
  sourcemap: true,
  minify: false,
});

console.log("UI bundle built → dist/ui/index.js");
