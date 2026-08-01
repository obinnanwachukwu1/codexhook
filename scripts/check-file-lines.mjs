import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const LIMIT = 400;
const ROOT = process.cwd();
const SKIP_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const CHECKED_EXTENSIONS = new Set([
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".toml",
  ".yaml",
  ".yml",
]);

async function authoredFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (SKIP_DIRECTORIES.has(entry.name)) return [];
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) return authoredFiles(pathname);
      if (
        SKIP_FILES.has(entry.name) ||
        !CHECKED_EXTENSIONS.has(path.extname(entry.name))
      ) {
        return [];
      }
      return [pathname];
    }),
  );
  return nested.flat();
}

const violations = [];
for (const filename of await authoredFiles(ROOT)) {
  const contents = await readFile(filename, "utf8");
  const lines =
    contents.length === 0 ? 0 : contents.split(/\r?\n/).length - 1;
  if (lines > LIMIT) {
    violations.push({
      filename: path.relative(ROOT, filename),
      lines,
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(`Authored files may not exceed ${LIMIT} lines:\n`);
  for (const violation of violations) {
    process.stderr.write(
      `- ${violation.filename}: ${violation.lines} lines\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`File line limit: all authored files <= ${LIMIT}.\n`);
}
