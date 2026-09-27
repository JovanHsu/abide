import { parseArgs } from "node:util";
import path from "node:path";
import { Text } from "ink";
import { createElement, type ReactElement } from "react";
import { AbideError } from "@coldtea/abide-schema";
import { isIgnored } from "../lib/git.js";
import { readSecret } from "../lib/secret.js";
import { findRepoRoot } from "../lib/paths.js";
import { Callout } from "../ui/components/Callout.js";
import { showPicker, showStatic } from "../ui/render.js";
import type { PickerItem } from "../ui/components/Picker.js";
import {
  GATEWAY_KEY_ENV,
  OPENROUTER_KEY_ENV,
  TYPESAFE_KEY_ENV,
} from "../lib/constants.js";
import { projectEnvPath, saveKey, userEnvPath } from "../lib/credentials.js";

type Provider = { name: string; prompt: string };

type Place = { kind: "user" } | { kind: "project"; root: string };

const TYPESAFE: PickerItem<Provider> = {
  value: { name: TYPESAFE_KEY_ENV, prompt: "TypeSafe API key: " },
  label: "TypeSafe API key",
  hint: "from typesafe.ai",
};

const GATEWAY: PickerItem<Provider> = {
  value: { name: GATEWAY_KEY_ENV, prompt: "Vercel AI Gateway key: " },
  label: "Vercel AI Gateway key",
  hint: "a key you already have",
};

const OPENROUTER: PickerItem<Provider> = {
  value: { name: OPENROUTER_KEY_ENV, prompt: "OpenRouter API key: " },
  label: "OpenRouter API key",
  hint: "a general model answers instead of Jev; bands mean what that model means",
};

const PROVIDERS: readonly PickerItem<Provider>[] = [OPENROUTER, TYPESAFE, GATEWAY];

/** The name a person types for a key, so the choice can be made without the menu. */
const PROVIDER_ALIASES: Record<string, string> = {
  typesafe: TYPESAFE_KEY_ENV,
  gateway: GATEWAY_KEY_ENV,
  vercel: GATEWAY_KEY_ENV,
  openrouter: OPENROUTER_KEY_ENV,
  "open-router": OPENROUTER_KEY_ENV,
  or: OPENROUTER_KEY_ENV,
};

const providerByEnvName = (name: string): Provider | undefined =>
  PROVIDERS.map((item) => item.value).find((provider) => provider.name === name);

/** On a pipe there is no menu, so a named provider wins, then the first item. */
const ask = async <T>(title: string, items: readonly PickerItem<T>[]): Promise<T> => {
  const first = items[0];
  if (first === undefined) throw new AbideError("NO_API_KEY", "nothing to choose from");
  if (!process.stdin.isTTY) return first.value;
  const chosen = await showPicker(title, items);
  if (chosen === undefined) throw new AbideError("NO_API_KEY", "nothing was chosen");
  return chosen.value;
};

const choosePlace = (root: string): Promise<Place> =>
  ask<Place>("Where should it live?", [
    { value: { kind: "user" }, label: "Every repo on this machine", hint: "~/.abide/.env" },
    { value: { kind: "project", root }, label: "This repo only", hint: ".env.local at the root" },
  ]);

const envFile = (place: Place): string =>
  place.kind === "user" ? userEnvPath() : projectEnvPath(place.root);

export const leakWarning = (place: Place): ReactElement | null => {
  if (place.kind === "user") return null;
  const name = path.basename(projectEnvPath(place.root));
  if (isIgnored(place.root, name)) return null;
  return Callout({
    tone: "warn",
    title: `${name} is not ignored by git`,
    children: createElement(
      Text,
      null,
      `Add ${name} to .gitignore before you commit, or the key goes with it.`,
    ),
  });
};

/**
 * Which key to store and where, from the arguments. A person names the provider
 * (`abide login openrouter`) instead of picking from the menu, which is what
 * makes the command work over a pipe: without it the menu is skipped and the
 * first item wins silently, so a redirected login could store the wrong kind of
 * key and only fail later, at check time.
 */
export const chooseProvider = (name: string | undefined): Provider => {
  if (name === undefined) return OPENROUTER.value;
  const envName = PROVIDER_ALIASES[name.toLowerCase()];
  if (envName === undefined)
    throw new AbideError(
      "NO_API_KEY",
      `"${name}" is not a key abide knows; name one of ${Object.keys(PROVIDER_ALIASES).join(", ")}`,
    );
  const provider = providerByEnvName(envName);
  if (provider === undefined) throw new AbideError("NO_API_KEY", `no provider for ${envName}`);
  return provider;
};

/** Never a flag: a flag lands in shell history and CI logs. */
export const runLogin = async (argv: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { project: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const named = positionals.filter((p) => p !== undefined);
  const provider = named[0] === undefined ? await ask("Which key do you have?", PROVIDERS) : chooseProvider(named[0]);
  const place: Place = values.project
    ? { kind: "project", root }
    : named[1] === "project"
      ? { kind: "project", root }
      : named[1] === "user"
        ? { kind: "user" }
        : await choosePlace(root);
  const key = await readSecret(provider.prompt);
  if (key === "") throw new AbideError("NO_API_KEY", "nothing was entered");
  const file = saveKey(envFile(place), provider.name, key);
  await showStatic(
    Callout({
      tone: "ok",
      title: `${provider.name} saved to ${file} (owner-only). Run abide init next.`,
    }),
  );
  const warning = leakWarning(place);
  if (warning !== null) await showStatic(warning);
  return 0;
};
