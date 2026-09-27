import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { followLinks, resolveLinkTarget } from "../src/lib/links.js";
import { discoverProjectSources } from "../src/lib/sources.js";

const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "abide-links-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
};

describe("resolveLinkTarget", () => {
  const root = "/repo";
  const from = "/repo/AGENTS.md";

  it("resolves a relative document against the file that carried it", () => {
    expect(resolveLinkTarget(root, from, "docs/architecture.md")).toBe("/repo/docs/architecture.md");
  });

  it("drops the anchor and the title", () => {
    expect(resolveLinkTarget(root, from, "docs/AGENTS.md#writing-rules")).toBe(
      "/repo/docs/AGENTS.md",
    );
  });

  it("resolves a sibling from a nested file, not from the root", () => {
    expect(resolveLinkTarget(root, "/repo/docs/AGENTS.md", "../AGENTS.md")).toBe("/repo/AGENTS.md");
  });

  it("refuses a URL, an absolute path and a bare anchor", () => {
    expect(resolveLinkTarget(root, from, "https://example.com/x.md")).toBeUndefined();
    expect(resolveLinkTarget(root, from, "mailto:a@b.c")).toBeUndefined();
    expect(resolveLinkTarget(root, from, "/etc/passwd")).toBeUndefined();
    expect(resolveLinkTarget(root, from, "#section")).toBeUndefined();
  });

  it("refuses a link that leaves the repository", () => {
    expect(resolveLinkTarget(root, from, "../../outside.md")).toBeUndefined();
  });
});

describe("followLinks", () => {
  it("follows a link and then a link out of that file", () => {
    const root = repo({
      "AGENTS.md": "see [std](docs/AGENTS.md)",
      "docs/AGENTS.md": "see [arch](architecture.md)",
      "docs/architecture.md": "no links",
    });
    const found = followLinks(root, [path.join(root, "AGENTS.md")]).map((f) => f.absolute);
    expect(found).toContain(path.join(root, "docs/AGENTS.md"));
    expect(found).toContain(path.join(root, "docs/architecture.md"));
  });

  it("terminates on a cycle instead of walking forever", () => {
    const root = repo({
      "AGENTS.md": "see [a](a.md)",
      "a.md": "see [b](b.md)",
      "b.md": "see [a](a.md)",
    });
    const found = followLinks(root, [path.join(root, "AGENTS.md")]).map((f) => f.absolute);
    expect(found.sort()).toEqual([path.join(root, "a.md"), path.join(root, "b.md")].sort());
  });

  it("visits a file linked from two places only once", () => {
    const root = repo({
      "AGENTS.md": "see [a](a.md) and [b](b.md)",
      "a.md": "see [shared](shared.md)",
      "b.md": "see [shared](shared.md)",
      "shared.md": "no links",
    });
    const found = followLinks(root, [path.join(root, "AGENTS.md")]);
    expect(found.filter((f) => f.absolute.endsWith("shared.md"))).toHaveLength(1);
  });

  it("keeps shell scripts and json out of it, and skips a link that does not exist", () => {
    const root = repo({
      "AGENTS.md": "see [s](run.sh), [j](conf.json) and [gone](missing.md)",
    });
    expect(followLinks(root, [path.join(root, "AGENTS.md")])).toEqual([]);
  });

  it("starts from every seed, not only the first", () => {
    const root = repo({
      "AGENTS.md": "no links",
      "docs/AGENTS.md": "see [arch](architecture.md)",
      "docs/architecture.md": "no links",
    });
    const found = followLinks(root, [
      path.join(root, "AGENTS.md"),
      path.join(root, "docs/AGENTS.md"),
    ]);
    expect(found.map((f) => f.absolute)).toEqual([path.join(root, "docs/architecture.md")]);
  });

  it("reads a document it reached through a symlink-free path only once even when named twice", () => {
    const root = repo({
      "AGENTS.md": "see [a](docs/AGENTS.md) and [b](docs/AGENTS.md)",
      "docs/AGENTS.md": "no links",
    });
    expect(followLinks(root, [path.join(root, "AGENTS.md")])).toHaveLength(1);
  });
});

describe("discoverProjectSources with links", () => {
  it("adds a linked document and gives it its own scope, not the linker's", () => {
    const root = repo({
      "AGENTS.md": "# root\nsee [std](docs/AGENTS.md) and [notes](.agents/notes/README.md)",
      "docs/AGENTS.md": "# docs standard\n[Agent Notes](../.agents/notes/README.md) are out of scope",
      ".agents/notes/README.md": "# notes",
    });
    const found = discoverProjectSources(root);
    const byPath = new Map(found.map((s) => [s.path, s]));

    // docs/AGENTS.md governs the docs subtree.
    expect(byPath.get("docs/AGENTS.md")?.scope).toBe("docs/**/*");
    // The notes are linked from it to say they are OUT of scope, so they must not
    // come under the documentation standard.
    expect(byPath.get(".agents/notes/README.md")?.scope).toBe(".agents/notes/README.md");
    expect(byPath.get(".agents/notes/README.md")?.origin).toBe("linked");
  });

  it("puts a linked document under a subtree AGENTS.md when one actually owns it", () => {
    const root = repo({
      "AGENTS.md": "see [d](docs/other.md)",
      "docs/AGENTS.md": "# docs standard",
      "docs/other.md": "no links",
    });
    const found = discoverProjectSources(root);
    expect(found.find((s) => s.path === "docs/other.md")?.scope).toBe("docs/**/*");
  });

  it("does not list a file twice when it is both named and linked", () => {
    const root = repo({
      "AGENTS.md": "see [sub](docs/AGENTS.md)",
      "docs/AGENTS.md": "# docs standard",
    });
    const found = discoverProjectSources(root);
    expect(found.filter((s) => s.path === "docs/AGENTS.md")).toHaveLength(1);
  });
});
