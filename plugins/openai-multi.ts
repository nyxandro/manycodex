/**
 * OpenCode Plugin: OpenAI Multi-Account Switcher
 *
 * Exports:
 * - OpenAIMultiAccountPlugin (L225): Plugin entrypoint.
 *
 * Commands handled (via command.execute.before hook):
 * - /oai                 (L276): List saved profiles.
 * - /oai list            (L276): List saved profiles.
 * - /oai save <name>     (L311): Save current OpenAI OAuth creds as a profile.
 * - /oai load <name>     (L381): Switch active OpenAI creds to a saved profile.
 * - /oai del <name|num>  (L349): Remove a saved profile.
 *
 * Notes:
 * - This plugin targets OpenAI "ChatGPT Plus/Pro" OAuth flow used by `/connect`.
 * - We intentionally keep logic local and fail fast on missing/invalid state.
 */

import type { Plugin } from "@opencode-ai/plugin";

type StoredOAuthProfile = {
  /**
   * Human-friendly name (used as key as well), repeated for readability/debug.
   *
   * Invariant: must be non-empty and unique.
   */
  name: string;
  /**
   * OAuth tokens copied from OpenCode auth storage.
   *
   * We store refresh + access + expires to allow immediate use without waiting
   * for a refresh round-trip.
   */
  oauth: {
    refresh: string;
    access: string;
    expires: number;
    enterpriseUrl?: string;
    /**
     * Not part of the public Auth type, but present in OpenCode's auth.json for openai.
     * Stored for display/debug only; not sent back via auth.set.
     */
    accountId?: string;
  };
  /**
   * ISO timestamp for auditing.
   */
  savedAt: string;
};

type StorageFile = {
  version: 1;
  profiles: Record<string, StoredOAuthProfile>;
};

/**
 * Resolve OpenCode directories in an XDG-compatible way.
 *
 * Invariant:
 * - If neither XDG_* nor HOME is available, we fail fast; we cannot guess paths.
 */
function resolveXdgPaths(): {
  configHome: string;
  dataHome: string;
} {
  const home = process.env.HOME;
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const xdgDataHome = process.env.XDG_DATA_HOME;

  if (!xdgConfigHome && !xdgDataHome && !home) {
    throw new Error(
      "Cannot resolve OpenCode paths: HOME, XDG_CONFIG_HOME, and XDG_DATA_HOME are all unset.",
    );
  }

  return {
    configHome: xdgConfigHome ?? `${home}/.config`,
    dataHome: xdgDataHome ?? `${home}/.local/share`,
  };
}

const { configHome: XDG_CONFIG_HOME, dataHome: XDG_DATA_HOME } =
  resolveXdgPaths();

const STORAGE_PATH = `${XDG_CONFIG_HOME}/opencode/openai-accounts.json`;
const AUTH_PATH = `${XDG_DATA_HOME}/opencode/auth.json`;

const PROVIDER_ID = "openai";
const COMMAND = "oai";

const EMAIL_CLAIM_KEY = "https://api.openai.com/profile";

/**
 * Keep parsing strict: we don't want accidental destructive operations.
 */
function parseArgs(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean);
}

async function readJsonFile<T>(path: string): Promise<T> {
  // Fail fast if the file doesn't exist; it indicates missing expected OpenCode state.
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`);
  }
  return (await file.json()) as T;
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  // Write pretty JSON for manual inspection; atomicity is handled by Bun under the hood.
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

async function loadStorage(): Promise<StorageFile> {
  // Storage is optional; if missing we initialize an empty structure.
  const file = Bun.file(STORAGE_PATH);
  if (!(await file.exists())) {
    return { version: 1, profiles: {} };
  }
  const parsed = (await file.json()) as Partial<StorageFile>;
  if (
    parsed.version !== 1 ||
    typeof parsed.profiles !== "object" ||
    parsed.profiles === null
  ) {
    throw new Error(`Invalid storage format in ${STORAGE_PATH}`);
  }
  return parsed as StorageFile;
}

async function saveStorage(storage: StorageFile): Promise<void> {
  // Invariant: always keep version pinned for future migrations.
  await writeJsonFile(STORAGE_PATH, storage);
}

type OpenCodeAuthFile = Record<string, any>;

function readOpenAiAuthFromAuthFile(
  authFile: OpenCodeAuthFile,
): StoredOAuthProfile["oauth"] {
  // We rely on OpenCode's on-disk state; if it doesn't match expected shape, do not guess.
  const entry = authFile[PROVIDER_ID];
  if (!entry) {
    throw new Error(
      `No auth entry for provider '${PROVIDER_ID}' in ${AUTH_PATH}. Run /connect first.`,
    );
  }
  if (entry.type !== "oauth") {
    throw new Error(
      `Provider '${PROVIDER_ID}' auth is not oauth (got '${String(entry.type)}'). This plugin supports OAuth accounts.`,
    );
  }
  if (
    typeof entry.refresh !== "string" ||
    typeof entry.access !== "string" ||
    typeof entry.expires !== "number"
  ) {
    throw new Error(
      `Invalid oauth payload for provider '${PROVIDER_ID}' in ${AUTH_PATH}`,
    );
  }
  const oauth: StoredOAuthProfile["oauth"] = {
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
  };

  // Optional fields; we keep them if present.
  if (typeof entry.enterpriseUrl === "string")
    oauth.enterpriseUrl = entry.enterpriseUrl;
  if (typeof entry.accountId === "string") oauth.accountId = entry.accountId;

  return oauth;
}

function base64UrlToUtf8(input: string): string {
  /**
   * JWT payload is base64url encoded.
   *
   * We decode without verifying signatures because this is only for UI display.
   */
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractEmailFromAccessToken(access: string): string | undefined {
  /**
   * OpenAI OAuth access token is a JWT.
   *
   * We best-effort extract email for UX, but never rely on it for logic.
   */
  const parts = access.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payloadRaw = base64UrlToUtf8(parts[1] ?? "");
    const payload = JSON.parse(payloadRaw) as Record<string, any>;
    const profile = payload[EMAIL_CLAIM_KEY] as Record<string, any> | undefined;
    const email = profile?.email;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

function isSameOauth(
  a: StoredOAuthProfile["oauth"],
  b?: StoredOAuthProfile["oauth"],
): boolean {
  /**
   * Prefer stable identifier if present. Fall back to refresh token equality.
   *
   * This is used only to highlight the active profile.
   */
  if (!b) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  return a.refresh === b.refresh;
}

export const OpenAIMultiAccountPlugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
      // Normalize command: remove leading/trailing whitespace and slash
      const cmd = input.command.trim().replace(/^\//, "").toLowerCase();

      // We only handle our own command; everything else passes through untouched.
      if (cmd !== COMMAND) return;

      const argv = parseArgs(input.arguments);
      const rawSub = (argv[0] ?? "").toLowerCase();

      // 1. Normalize Action
      let action: "list" | "save" | "del" | "load" | "unknown" = "unknown";

      if (!rawSub || rawSub === "list") {
        action = "list";
      } else if (rawSub === "save") {
        action = "save";
      } else if (rawSub === "del") {
        action = "del";
      } else if (rawSub === "load") {
        action = "load";
      }

      try {
        // Validation helper for 'save' and strict checks
        const ensureActiveAuth = async () => {
          try {
            const authFile = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
            return readOpenAiAuthFromAuthFile(authFile);
          } catch (e) {
            throw new Error(
              "No active OpenAI login found. Run /connect first.",
            );
          }
        };

        const loadStorageAndAuth = async () => {
          const storage = await loadStorage();
          let activeOauth: StoredOAuthProfile["oauth"] | undefined;
          try {
            const auth = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
            if (auth[PROVIDER_ID])
              activeOauth = readOpenAiAuthFromAuthFile(auth);
          } catch (e) {
            /* ignore */
          }
          return { storage, activeOauth };
        };

        if (action === "list") {
          const { storage, activeOauth } = await loadStorageAndAuth();
          const names = Object.keys(storage.profiles).sort((a, b) =>
            a.localeCompare(b),
          );

          if (names.length === 0) {
            await client.tui.showToast({
              body: {
                message: "No profiles. Use '/oai save <name>' to add one.",
                variant: "info",
              },
              duration: 5000,
            });
          } else {
            const listStr = names
              .map((n) => {
                const p = storage.profiles[n]!;
                const active = activeOauth && isSameOauth(p.oauth, activeOauth);
                return active ? `[${n}]` : n;
              })
              .join(", ");

            await client.tui.showToast({
              body: {
                message: `Profiles: ${listStr}. Use '/oai load <name>'.`,
                variant: "info",
              },
              duration: 8000,
            });
          }
          output.parts = [];
          return;
        }

        if (action === "save") {
          const name = argv[1] ?? "";
          if (!name) throw new Error("Usage: /oai save <name>");

          const oauth = await ensureActiveAuth();
          if (!oauth.access || !oauth.refresh) {
            throw new Error(
              "Active OpenAI auth seems invalid. Try /connect again.",
            );
          }

          const storage = await loadStorage();
          if (storage.profiles[name]) {
            throw new Error(
              `Profile '${name}' already exists. Use a different name.`,
            );
          }

          storage.profiles[name] = {
            name,
            oauth,
            savedAt: new Date().toISOString(),
          };
          await saveStorage(storage);

          const email = extractEmailFromAccessToken(oauth.access);
          await client.tui.showToast({
            body: {
              message: email
                ? `Saved profile '${name}' (${email})`
                : `Saved profile '${name}'`,
              variant: "success",
            },
          });
          output.parts = [];
          return;
        }

        if (action === "del") {
          const nameOrNum = argv[1] ?? "";
          if (!nameOrNum) throw new Error("Usage: /oai del <name>");

          const storage = await loadStorage();
          const names = Object.keys(storage.profiles).sort((a, b) =>
            a.localeCompare(b),
          );

          let targetName = nameOrNum;
          const asNum = parseInt(nameOrNum, 10);
          if (!isNaN(asNum) && asNum > 0 && asNum <= names.length) {
            targetName = names[asNum - 1];
          }

          if (!storage.profiles[targetName]) {
            throw new Error(`Profile '${targetName}' not found.`);
          }

          delete storage.profiles[targetName];
          await saveStorage(storage);

          await client.tui.showToast({
            body: {
              message: `Removed profile '${targetName}'`,
              variant: "success",
            },
          });
          output.parts = [];
          return;
        }

        if (action === "load") {
          const targetName = argv[1] ?? "";
          if (!targetName) throw new Error("Usage: /oai load <name>");

          const storage = await loadStorage();
          const names = Object.keys(storage.profiles).sort((a, b) =>
            a.localeCompare(b),
          );

          // Resolve number to name if possible
          const asNum = parseInt(targetName, 10);
          let resolvedName = targetName;
          if (!isNaN(asNum) && asNum > 0 && asNum <= names.length) {
            resolvedName = names[asNum - 1];
          }

          const profile = storage.profiles[resolvedName];
          if (!profile) {
            throw new Error(`Profile '${resolvedName}' not found.`);
          }

          await client.auth.set({
            path: { id: PROVIDER_ID },
            body: {
              type: "oauth",
              refresh: profile.oauth.refresh,
              access: profile.oauth.access,
              expires: profile.oauth.expires,
              ...(profile.oauth.enterpriseUrl
                ? { enterpriseUrl: profile.oauth.enterpriseUrl }
                : {}),
            },
          });

          const email = extractEmailFromAccessToken(profile.oauth.access);
          await client.tui.showToast({
            body: {
              message: email
                ? `Active: ${resolvedName} (${email})`
                : `Active: ${resolvedName}`,
              variant: "success",
            },
          });
          output.parts = [];
          return;
        }

        // Show help/list for unknown commands
        if (action === "unknown") {
          await client.tui.showToast({
            body: {
              message: "Unknown command. Available: list, save, load, del",
              variant: "error",
            },
            duration: 5000,
          });
          output.parts = [];
        }
      } catch (error) {
        // Boundary: Use Toast for errors instead of Chat
        const message = error instanceof Error ? error.message : String(error);
        await client.tui.showToast({
          body: {
            message: `Error: ${message}`,
            variant: "error",
          },
        });
        // Do NOT put error in chat output to avoid noise
        output.parts = []; // Ensure no chat output on error
      }
    },
  };
};
