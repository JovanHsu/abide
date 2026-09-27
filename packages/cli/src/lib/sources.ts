import { readdirSync, existsSync, type Dirent } from "node:fs";
import path from "node:path";
import { createSourceSha, type Rubric } from "@coldtea/abide-schema";
import { homeDir, resolveSourcePath, toSourcePath } from "./paths.js";
import { readRegularFile } from "./regularFile.js";
import { followLinks } from "./links.js";

export type SourceCandidate = {
  /** Rubric spelling: repo-relative or "~/...". */
  path: string;
  absolute: string;
  /** Glob the file's rules apply to. */
  scope: string;
  /** Required candidates must appear in the rubric for it to be fresh. */
  required: boolean;
  origin: "root" | "nested" | "global" | "contributing" | "linked";
};

const ROOT_NAMES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
const NESTED_NAMES = ["AGENTS.md", "CLAUDE.md"];
/**
 * Files every repo on this machine is governed by. The first three are the
 * host's own instruction file; the last is the rule library a global CLAUDE.md
 * keeps beside itself, which `@~/.claude/rules/x.md` imports one at a time.
 * Rules under it are read by directory rather than only through those imports,
 * so a rule file that nothing imports yet is still compiled.
 */
const GLOBAL_NAMES = [
  "~/.claude/CLAUDE.md",
  "~/.codex/AGENTS.md",
  "~/.config/opencode/AGENTS.md",
];

/** Directories under home whose documents are rules for every repo. */
const GLOBAL_DIRS = ["~/.claude/rules"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "coverage",
  ".turbo",
  ".cache",
  "target",
  ".abide",
  ".claude",
  ".codex",
  ".opencode",
]);
const MAX_DEPTH = 6;

const walkNested = (root: string, dir: string, depth: number, out: SourceCandidate[]): void => {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const sub = path.join(dir, entry.name);
    for (const name of NESTED_NAMES) {
      const file = path.join(sub, name);
      if (existsSync(file)) {
        const rel = toSourcePath(root, sub);
        out.push({
          path: toSourcePath(root, file),
          absolute: file,
          scope: `${rel}/**/*`,
          required: true,
          origin: "nested",
        });
      }
    }
    walkNested(root, sub, depth + 1, out);
  }
};

export const discoverProjectSources = (root: string): SourceCandidate[] => {
  const found: SourceCandidate[] = [];
  for (const name of ROOT_NAMES) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      found.push({ path: name, absolute: file, scope: "**/*", required: true, origin: "root" });
    }
  }
  walkNested(root, root, 1, found);
  const contributing = path.join(root, "CONTRIBUTING.md");
  if (existsSync(contributing)) {
    found.push({
      path: "CONTRIBUTING.md",
      absolute: contributing,
      scope: "**/*",
      required: false,
      origin: "contributing",
    });
  }
  found.push(...discoverLinkedSources(root, found));
  return found;
};

/**
 * The documents the files above link to.
 *
 * A linked document is not a child of the file that linked it, so it does not
 * inherit that file's scope. docs/AGENTS.md governs docs/ and links out to the
 * Agent Notes to say they are out of its range; inheriting its scope would put
 * the notes under the documentation standard, which is the opposite of what the
 * link says. A linked file's scope comes from where it sits instead: a nested
 * AGENTS.md of its own wins, otherwise the nearest such file above it, otherwise
 * everywhere.
 *
 * Required, because a hub pointing at a document is the workspace saying the
 * document holds rules; losing it from the rubric is worth recompiling for.
 */
const discoverLinkedSources = (
  root: string,
  seeds: readonly SourceCandidate[],
): SourceCandidate[] => {
  const known = new Set(seeds.map((s) => path.resolve(s.absolute)));
  const nestedScopes = seeds
    .filter((s) => s.origin === "nested")
    .map((s) => ({ dir: path.dirname(path.resolve(s.absolute)), scope: s.scope }));
  const out: SourceCandidate[] = [];
  for (const linked of followLinks(root, seeds.map((s) => s.absolute))) {
    const resolved = path.resolve(linked.absolute);
    if (known.has(resolved)) continue;
    known.add(resolved);
    out.push({
      path: toSourcePath(root, linked.absolute),
      absolute: linked.absolute,
      scope: scopeForPath(root, resolved, nestedScopes),
      required: true,
      origin: "linked",
    });
  }
  return out;
};

/** The scope a file is governed by: its own subtree AGENTS.md, else the nearest one above, else everywhere. */
const scopeForPath = (
  root: string,
  absolute: string,
  nested: readonly { dir: string; scope: string }[],
): string => {
  const dir = path.dirname(absolute);
  // The deepest directory whose subtree contains this file owns it.
  const owners = nested
    .filter((n) => dir === n.dir || dir.startsWith(`${n.dir}${path.sep}`))
    .sort((a, b) => b.dir.length - a.dir.length);
  const owner = owners[0];
  if (owner !== undefined) return owner.scope;
  // No subtree owns it: it applies to the file itself, not the whole repo.
  return toSourcePath(root, absolute);
};

export const discoverGlobalSources = (): SourceCandidate[] => {
  const named = GLOBAL_NAMES.flatMap((p) => {
    const absolute = path.join(homeDir(), p.slice(2));
    return existsSync(absolute)
      ? [{ path: p, absolute, scope: "**/*", required: true, origin: "global" as const }]
      : [];
  });
  const imported = discoverGlobalImports(named);
  return [...named, ...imported, ...discoverGlobalDirs()];
};

/**
 * What a global instruction file imports with `@~/.claude/rules/x.md`. Followed
 * because the alternative is a rule the person believes is loaded and is not,
 * and the rule library is read by directory as well, so this only catches the
 * files a directory sweep would miss: ones outside GLOBAL_DIRS.
 */
const discoverGlobalImports = (seeds: readonly SourceCandidate[]): SourceCandidate[] => {
  if (seeds.length === 0) return [];
  const known = new Set(seeds.map((s) => path.resolve(s.absolute)));
  const out: SourceCandidate[] = [];
  for (const linked of followLinks(homeDir(), seeds.map((s) => s.absolute))) {
    const resolved = path.resolve(linked.absolute);
    if (known.has(resolved)) continue;
    known.add(resolved);
    out.push({
      path: toSourcePath(homeDir(), linked.absolute),
      absolute: linked.absolute,
      scope: "**/*",
      required: false,
      origin: "global",
    });
  }
  return out;
};

/** Every document under a global rules directory, deepest last so the order is stable. */
const discoverGlobalDirs = (): SourceCandidate[] => {
  const out: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (const dir of GLOBAL_DIRS) {
    const absolute = path.join(homeDir(), dir.slice(2));
    const files: string[] = [];
    collectDocuments(absolute, 0, files);
    files.sort();
    for (const file of files) {
      const resolved = path.resolve(file);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({
        path: toSourcePath(homeDir(), file),
        absolute: file,
        // A global rule binds everywhere, as the global instruction files do.
        scope: "**/*",
        required: false,
        origin: "global",
      });
    }
  }
  return out;
};

const collectDocuments = (dir: string, depth: number, out: string[]): void => {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectDocuments(path.join(dir, entry.name), depth + 1, out);
      continue;
    }
    if (entry.isFile() && /\.(?:md|markdown|mdx)$/i.test(entry.name)) out.push(path.join(dir, entry.name));
  }
};

export const hashFile = (absolute: string): string | undefined => {
  const bytes = readRegularFile(absolute);
  return bytes === undefined ? undefined : createSourceSha(bytes);
};

export type Staleness =
  | { status: "missing" }
  | { status: "fresh" }
  | { status: "stale"; changed: string[]; added: string[]; removed: string[]; unhashed: string[] };

export const checkStaleness = (
  rubric: Rubric | undefined,
  candidates: SourceCandidate[],
  root: string,
): Staleness => {
  if (rubric === undefined) return { status: "missing" };
  const changed: string[] = [];
  const removed: string[] = [];
  const unhashed: string[] = [];
  for (const source of rubric.sources) {
    const now = hashFile(resolveSourcePath(root, source.path));
    if (now === undefined) removed.push(source.path);
    else if (source.sha === undefined) unhashed.push(source.path);
    else if (source.sha !== now) changed.push(source.path);
  }
  const listed = new Set(rubric.sources.map((s) => path.resolve(resolveSourcePath(root, s.path))));
  const added = candidates
    .filter((c) => c.required && !listed.has(path.resolve(c.absolute)))
    .map((c) => c.path);
  if (changed.length + removed.length + unhashed.length + added.length === 0) {
    return { status: "fresh" };
  }
  return { status: "stale", changed, added, removed, unhashed };
};

export const describeStaleness = (s: Staleness): string => {
  switch (s.status) {
    case "missing":
      return "no rubric yet";
    case "fresh":
      return "up to date";
    case "stale": {
      const parts: string[] = [];
      if (s.changed.length) parts.push(`changed: ${s.changed.join(", ")}`);
      if (s.added.length) parts.push(`new: ${s.added.join(", ")}`);
      if (s.removed.length) parts.push(`gone: ${s.removed.join(", ")}`);
      if (s.unhashed.length) parts.push(`never hashed: ${s.unhashed.join(", ")}`);
      return parts.join("; ");
    }
    default:
      return assertNeverStaleness(s);
  }
};

const assertNeverStaleness = (value: never): never => {
  throw new Error(`Unhandled staleness: ${JSON.stringify(value)}`);
};
