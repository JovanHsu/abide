// An instruction file points at more than itself. A workspace AGENTS.md is a
// hub: it carries standing orders and links each one to the document that holds
// the detail, and the detail is where most of the rules actually live. The
// name-based discovery in sources.ts sees only the hub, so a rubric compiled
// from it covers the headings and misses the body.
//
// This follows those links. Markdown links only, by relative path, staying
// inside the repo, following each file once. A shell script or a JSON file may
// be linked as a convention to respect, but it is not written as rules, so only
// documents are collected.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { homeDir } from "./paths.js";

/** A markdown link whose target looks like a document, not an anchor or a URL. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * A path a file pulls in by reference rather than by link. Claude Code reads
 * `@path/to/file.md` in an instruction file as "treat that file as part of me",
 * which is how a global CLAUDE.md stays short while its rules live in a
 * directory beside it.
 *
 * The @ must start a word, so an email address or a decorator is not an import.
 * A backtick or a quote before it is the normal way to write one in prose, so
 * those are starters rather than terminators.
 */
const IMPORT = /(?:^|[\s(`'"[])(@[~/][^\s`'")\]]+\.(?:md|markdown|mdx))/g;

/** Enough of a file to hold its links; a bigger one is prose, not a hub, and is read only for rules. */
const MAX_HUB_BYTES = 256 * 1024;

const isDocument = (target: string): boolean =>
  /\.(?:md|markdown|mdx)$/i.test(target) || !path.extname(target);

/**
 * A link or import target resolved against the file that carried it, or nothing
 * when it leaves the allowed root, is absolute, is a URL, is only an anchor, or
 * does not exist. `~` resolves against the same home the rest of abide uses.
 */
export const resolveLinkTarget = (
  root: string,
  fromAbsolute: string,
  rawTarget: string,
): string | undefined => {
  // `@` is import syntax, not part of the path. Without this the target resolves
  // against the linking file's directory and lands inside it, which is how a
  // real home-relative import came out as `~/.claude/@~/.claude/rules/x.md`.
  const withoutAnchor = (rawTarget.split("#")[0] ?? "").trim().replace(/^@/, "");
  if (withoutAnchor === "") return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAnchor)) return undefined; // http:, mailto:
  if (path.isAbsolute(withoutAnchor)) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    decoded = withoutAnchor;
  }

  // `~` alone, or a path that starts with it, is home. `~root/x.md` is not: a
  // shell would expand it as another user's home, which is outside the boundary
  // either way, so it is refused rather than joined onto this home.
  let resolved: string;
  let allowed: string;
  if (decoded === "~" || decoded.startsWith("~/")) {
    resolved = path.join(homeDir(), decoded.slice(2));
    allowed = path.resolve(homeDir());
  } else if (decoded.startsWith("~")) {
    return undefined;
  } else {
    resolved = path.resolve(path.dirname(fromAbsolute), decoded);
    allowed = path.resolve(root);
  }
  if (resolved !== allowed && !resolved.startsWith(`${allowed}${path.sep}`)) return undefined;
  return resolved;
};

/** Every document a file links to or imports, in the order they appear, each once. */
const linkedDocuments = (root: string, absolute: string): string[] => {
  let text: string;
  try {
    if (statSync(absolute).size > MAX_HUB_BYTES) return [];
    text = readFileSync(absolute, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (raw: string): void => {
    if (!isDocument(raw.split("#")[0] ?? "")) return;
    const resolved = resolveLinkTarget(root, absolute, raw);
    if (resolved === undefined || seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  for (const match of text.matchAll(LINK)) {
    const raw = match[1];
    if (raw !== undefined) take(raw);
  }
  for (const match of text.matchAll(IMPORT)) {
    const raw = match[1];
    if (raw !== undefined) take(raw);
  }
  return out;
};

/**
 * Breadth-first over the links starting from the files already found by name.
 * A file is visited once, so a link cycle terminates, and nothing outside the
 * starting files is followed twice. Only documents that exist are returned.
 */
export const followLinks = (
  root: string,
  seeds: readonly string[],
): { absolute: string; linkedFrom: string }[] => {
  const visited = new Set<string>(seeds.map((s) => path.resolve(s)));
  const out: { absolute: string; linkedFrom: string }[] = [];
  let frontier = [...visited];
  // Bounded so a pathological chain of links cannot walk the whole repository.
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of linkedDocuments(root, file)) {
        if (visited.has(target)) continue;
        visited.add(target);
        if (!existsSync(target)) continue;
        try {
          if (!statSync(target).isFile()) continue;
        } catch {
          continue;
        }
        out.push({ absolute: target, linkedFrom: file });
        next.push(target);
      }
    }
    frontier = next;
  }
  return out;
};
