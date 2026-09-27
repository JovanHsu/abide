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

/** A markdown link whose target looks like a document, not an anchor or a URL. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Enough of a file to hold its links; a bigger one is prose, not a hub, and is read only for rules. */
const MAX_HUB_BYTES = 256 * 1024;

const isDocument = (target: string): boolean =>
  /\.(?:md|markdown|mdx)$/i.test(target) || !path.extname(target);

/**
 * A link target resolved against the file that carried it, or nothing when it
 * leaves the repo, is absolute, is a URL, is only an anchor, or does not exist.
 */
export const resolveLinkTarget = (
  root: string,
  fromAbsolute: string,
  rawTarget: string,
): string | undefined => {
  const withoutAnchor = rawTarget.split("#")[0]?.trim() ?? "";
  if (withoutAnchor === "") return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutAnchor)) return undefined; // http:, mailto:
  if (path.isAbsolute(withoutAnchor)) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    decoded = withoutAnchor;
  }

  const resolved = path.resolve(path.dirname(fromAbsolute), decoded);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return undefined;
  return resolved;
};

/** Every document a file links to, in the order they appear, each once. */
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
  for (const match of text.matchAll(LINK)) {
    const raw = match[1];
    if (raw === undefined) continue;
    if (!isDocument(raw.split("#")[0] ?? "")) continue;
    const resolved = resolveLinkTarget(root, absolute, raw);
    if (resolved === undefined || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
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
