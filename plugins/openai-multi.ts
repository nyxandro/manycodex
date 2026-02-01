/**
 * OpenCode Plugin: OpenAI Multi-Account Switcher
 *
 * Exports:
 * - OpenAIMultiAccountPlugin (L22): Plugin entrypoint.
 * - STORAGE_PATH (L41): Where profiles are stored.
 * - AUTH_PATH (L45): Where OpenCode stores active provider auth.
 *
 * Commands handled (via command.execute.before hook):
 * - /oai list (L175): List saved profiles.
 * - /oai current (L207): Show active OpenAI account (from auth.json).
 * - /oai save <name> (L231): Save current OpenAI OAuth creds as a profile.
 * - /oai use <name> (L285): Switch active OpenAI creds to a saved profile.
 * - /oai remove <name> (L346): Remove a saved profile.
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

const STORAGE_PATH = `${process.env.HOME ?? ""}/.config/opencode/openai-accounts.json`;
const AUTH_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/auth.json`;

const PROVIDER_ID = "openai";
const COMMAND = "oai";

const EMAIL_CLAIM_KEY = "https://api.openai.com/profile";

/**
 * Keep parsing strict: we don't want accidental destructive operations.
 */
function parseArgs(raw: string): string[] {
  // Split by whitespace; OpenCode already passes raw arguments, not including the leading command.
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

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must be non-empty`);
  }
}

function formatProfileLine(p: StoredOAuthProfile): string {
  const exp = new Date(p.oauth.expires).toISOString();
  const acct = p.oauth.accountId ? ` accountId=${p.oauth.accountId}` : "";
  const email = extractEmailFromAccessToken(p.oauth.access);
  const emailPart = email ? ` email=${email}` : "";
  return `- ${p.name}${emailPart} (expires=${exp}${acct}, savedAt=${p.savedAt})`;
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

function helpText(): string {
  /**
   * We intentionally keep the public surface area tiny.
   *
   * Older subcommands are still accepted as aliases, but we don't advertise them.
   */
  return [
    "OpenAI multi-account:",
    "- /oai                 (menu)",
    "- /oai <name|number>    (activate)",
    "- /oai d <number>       (delete)",
    "- /oai save <name>      (save current openai oauth)",
  ].join("\n");
}

function buildMenuText(params: {
  names: string[];
  profiles: Record<string, StoredOAuthProfile>;
  activeOauth?: StoredOAuthProfile["oauth"];
}): string {
  /**
   * This is a text menu because plugins don't currently have access to
   * OpenCode's interactive selector UI.
   */
  const lines = params.names.map((name, idx) => {
    const p = params.profiles[name]!;
    const activeMark =
      params.activeOauth && isSameOauth(p.oauth, params.activeOauth)
        ? "*"
        : " ";
    const email = extractEmailFromAccessToken(p.oauth.access);
    const emailPart = email ? ` (${email})` : "";
    return `${activeMark} ${idx + 1}) ${name}${emailPart}`;
  });

  return [
    "```text",
    "OpenAI accounts:",
    lines.length === 0 ? "(no saved profiles)" : lines.join("\n"),
    "",
    "Actions:",
    "- /oai <number|name>        activate",
    "- /oai d <number>           delete",
    "- /oai save <name>          save current OpenAI OAuth",
    "```",
  ].join("\n");
}

export const OpenAIMultiAccountPlugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
      await client.tui.showToast({
        body: {
          message: `OpenAIMultiAccountPlugin: command.execute.before called for command: ${input.command}`,
          variant: "info",
        },
        duration: 1000, // Short duration for debug toast
      });

      // Normalize command: remove leading/trailing whitespace and slash
      const cmd = input.command.trim().replace(/^\//, "").toLowerCase();

      // We only handle our own command; everything else passes through untouched.
      if (cmd !== COMMAND) return;

      const argv = parseArgs(input.arguments);
      const sub = argv[0] ?? "";

      /**
       * Backwards-compatible aliases.
       *
       * We accept older verbs but treat the public API as the menu-driven `/oai`.
       */
      const normalizedSub =
        sub === "help"
          ? ""
          : sub === "switch"
            ? ""
            : sub === "list"
              ? "_list"
              : sub === "current"
                ? "_current"
                : sub;

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

        // 1. LIST (Default or explicit)
        if (normalizedSub === "" || normalizedSub === "_list") {
          const storage = await loadStorage();
          let activeOauth: StoredOAuthProfile["oauth"] | undefined;
          try {
            const auth = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
            if (auth[PROVIDER_ID]) {
              activeOauth = readOpenAiAuthFromAuthFile(auth);
            }
          } catch (e) {
            /* ignore */
          }

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
                message: `Profiles: ${listStr}. Use '/oai <name>' to switch.`,
                variant: "info",
              },
              duration: 8000,
            });
          }

          output.parts = []; // Zero chat output
          return;
        }

        // 2. SAVE
        if (normalizedSub === "save") {
          const name = argv[1] ?? "";
          if (!name) throw new Error("Usage: /oai save <profile_name>");

          const oauth = await ensureActiveAuth();

          // Basic validation of token existence (simple check)
          if (!oauth.access || !oauth.refresh) {
            throw new Error(
              "Active OpenAI auth seems invalid (missing tokens). Try /connect again.",
            );
          }

          const storage = await loadStorage();
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
          // No chat output, keep it clean
          output.parts = [];
          return;
        }

        // 3. REMOVE
        if (
          normalizedSub === "d" ||
          normalizedSub === "rm" ||
          normalizedSub === "remove"
        ) {
          const selector = argv[1] ?? "";
          if (!selector) throw new Error("Usage: /oai rm <name|number>");

          const storage = await loadStorage();
          const names = Object.keys(storage.profiles).sort((a, b) =>
            a.localeCompare(b),
          );

          let name = selector;
          const asNum = parseInt(selector, 10);
          if (!isNaN(asNum) && asNum > 0 && asNum <= names.length) {
            name = names[asNum - 1];
          }

          if (!storage.profiles[name])
            throw new Error(`Profile '${name}' not found.`);

          delete storage.profiles[name];
          await saveStorage(storage);

          await client.tui.showToast({
            body: { message: `Removed profile '${name}'`, variant: "success" },
          });
          output.parts = [];
          return;
        }

        // 4. USE (ACTIVATE)
        // Handle "/oai use <name>" or just "/oai <name>"
        if (normalizedSub === "use") {
          argv.shift();
        }
        const selector = normalizedSub; // Now this is definitely the target
        if (!selector) {
          // Should have been caught by "list" case, but just in case
          throw new Error("Usage: /oai <name|number>");
        }

        const storage = await loadStorage();
        const names = Object.keys(storage.profiles).sort((a, b) =>
          a.localeCompare(b),
        );

        let name = selector;
        const asNum = parseInt(selector, 10);
        if (!isNaN(asNum) && asNum > 0 && asNum <= names.length) {
          name = names[asNum - 1];
        }

        const profile = storage.profiles[name];
        if (!profile)
          throw new Error(`Profile '${name}' not found. Use /oai to list.`);

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
            message: email ? `Active: ${name} (${email})` : `Active: ${name}`,
            variant: "success",
          },
        });
        output.parts = [];
        return;
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
