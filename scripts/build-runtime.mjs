import { chmod, readFile } from "node:fs/promises";
import { build } from "esbuild";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versionSource = await readFile("src/version.ts", "utf8");
const expected = `export const VERSION = "${packageJson.version}";`;
if (!versionSource.includes(expected)) {
  throw new Error("src/version.ts must match package.json version");
}

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/codexhook.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await chmod("dist/codexhook.mjs", 0o755);
