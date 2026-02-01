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

export const STORAGE_PATH = `${process.env.HOME ?? ""}/.config/opencode/openai-accounts.json`;
export const AUTH_PATH = `${process.env.HOME ?? ""}/.local/share/opencode/auth.json`;

const PROVIDER_ID = "openai";
const COMMAND = "oai";

const EMAIL_CLAIM_KEY = "https://api.openai.com/profile";

/**
 * Keep parsing strict: we don't want accidental destructive operations.
 */
function parseArgs(raw: string): string[] {
  // Split by whitespace; OpenCode already passes raw arguments, not including the leading command.
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean);
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
  if (parsed.version !== 1 || typeof parsed.profiles !== "object" || parsed.profiles === null) {
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

function readOpenAiAuthFromAuthFile(authFile: OpenCodeAuthFile): StoredOAuthProfile["oauth"] {
  // We rely on OpenCode's on-disk state; if it doesn't match expected shape, do not guess.
  const entry = authFile[PROVIDER_ID];
  if (!entry) {
    throw new Error(`No auth entry for provider '${PROVIDER_ID}' in ${AUTH_PATH}. Run /connect first.`);
  }
  if (entry.type !== "oauth") {
    throw new Error(
      `Provider '${PROVIDER_ID}' auth is not oauth (got '${String(entry.type)}'). This plugin supports OAuth accounts.`
    );
  }
  if (typeof entry.refresh !== "string" || typeof entry.access !== "string" || typeof entry.expires !== "number") {
    throw new Error(`Invalid oauth payload for provider '${PROVIDER_ID}' in ${AUTH_PATH}`);
  }
  const oauth: StoredOAuthProfile["oauth"] = {
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
  };

  // Optional fields; we keep them if present.
  if (typeof entry.enterpriseUrl === "string") oauth.enterpriseUrl = entry.enterpriseUrl;
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

function isSameOauth(a: StoredOAuthProfile["oauth"], b: StoredOAuthProfile["oauth"]): boolean {
  /**
   * Prefer stable identifier if present. Fall back to refresh token equality.
   *
   * This is used only to highlight the active profile.
   */
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
  activeOauth: StoredOAuthProfile["oauth"];
}): string {
  /**
   * This is a text menu because plugins don't currently have access to
   * OpenCode's interactive selector UI.
   */
  const lines = params.names.map((name, idx) => {
    const p = params.profiles[name]!;
    const activeMark = isSameOauth(p.oauth, params.activeOauth) ? "*" : " ";
    const email = extractEmailFromAccessToken(p.oauth.access);
    const emailPart = email ? ` (${email})` : "";
    return `${activeMark} ${idx + 1}) ${name}${emailPart}`;
  });

  return [
    "OpenAI accounts:",
    lines.length === 0 ? "(no saved profiles)" : lines.join("\n"),
    "",
    "Actions:",
    "- /oai <number|name>        activate",
    "- /oai d <number>           delete",
    "- /oai save <name>          save current OpenAI OAuth",
  ].join("\n");
}

export const OpenAIMultiAccountPlugin: Plugin = async ({ client }) => {
  return {
    "command.execute.before": async (input, output) => {
      // We only handle our own command; everything else passes through untouched.
      if (input.command !== COMMAND) return;

      const argv = parseArgs(input.arguments);
      const sub = argv[0] ?? "";

      /**
       * Backwards-compatible aliases.
       *
       * We accept older verbs but treat the public API as the menu-driven `/oai`.
       */
      const normalizedSub =
        sub === "help" ? "" : sub === "switch" ? "" : sub === "list" ? "_list" : sub === "current" ? "_current" : sub;

      try {
        // Default: show menu.
        if (normalizedSub === "") {
          const storage = await loadStorage();
          const authFile = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
          const activeOauth = readOpenAiAuthFromAuthFile(authFile);
          const names = Object.keys(storage.profiles).sort((a, b) => a.localeCompare(b));

          output.parts = [
            {
              type: "text",
              text: buildMenuText({ names, profiles: storage.profiles, activeOauth }),
            },
          ];
          return;
        }

        // Hidden: list (kept for compatibility).
        if (normalizedSub === "_list") {
          const storage = await loadStorage();
          const authFile = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
          const activeOauth = readOpenAiAuthFromAuthFile(authFile);
          const names = Object.keys(storage.profiles).sort((a, b) => a.localeCompare(b));
          const lines = names.map((n) => {
            const p = storage.profiles[n]!;
            const activeMark = isSameOauth(p.oauth, activeOauth) ? "* " : "  ";
            return activeMark + formatProfileLine(p);
          });
          output.parts = [
            {
              type: "text",
              text: lines.length === 0 ? "No saved profiles." : ["Saved OpenAI profiles:", ...lines].join("\n"),
            },
          ];
          return;
        }

        // Hidden: current (kept for compatibility).
        if (normalizedSub === "_current") {
          const authFile = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
          const oauth = readOpenAiAuthFromAuthFile(authFile);
          const exp = new Date(oauth.expires).toISOString();
          output.parts = [
            {
              type: "text",
              text: `Active OpenAI auth: oauth (expires=${exp}${oauth.accountId ? `, accountId=${oauth.accountId}` : ""})`,
            },
          ];
          return;
        }

        if (normalizedSub === "save") {
          const name = argv[1] ?? "";
          assertNonEmpty(name, "Profile name");

          const authFile = await readJsonFile<OpenCodeAuthFile>(AUTH_PATH);
          const oauth = readOpenAiAuthFromAuthFile(authFile);

          const storage = await loadStorage();
          storage.profiles[name] = {
            name,
            oauth,
            savedAt: new Date().toISOString(),
          };
          await saveStorage(storage);

          output.parts = [{ type: "text", text: `Saved profile '${name}' to ${STORAGE_PATH}` }];
          const email = extractEmailFromAccessToken(oauth.access);
          await client.tui.showToast({
            body: {
              message: email ? `OpenAI profile saved: ${name} (${email})` : `OpenAI profile saved: ${name}`,
              variant: "success",
            },
          });
          return;
        }

        // Delete (public): /oai d <number>
        if (normalizedSub === "d" || normalizedSub === "rm" || normalizedSub === "remove") {
          const selector = argv[1] ?? "";
          assertNonEmpty(selector, "Profile number");

          const storage = await loadStorage();
          const names = Object.keys(storage.profiles).sort((a, b) => a.localeCompare(b));
          const asNumber = Number(selector);
          const name = Number.isFinite(asNumber) && String(asNumber) === selector ? names[asNumber - 1] : undefined;
          if (!name) throw new Error(`Invalid selection '${selector}'. Use: /oai`);
          if (!storage.profiles[name]) throw new Error(`Unknown profile '${name}'. Use: /oai`);

          delete storage.profiles[name];
          await saveStorage(storage);

          output.parts = [{ type: "text", text: `Removed profile '${name}'` }];
          await client.tui.showToast({ body: { message: `OpenAI profile removed: ${name}`, variant: "success" } });
          return;
        }

        /**
         * Activate (public):
         * - /oai <number>
         * - /oai <name>
         *
         * Compatibility:
         * - /oai use <number|name>
         */
        if (normalizedSub === "use") {
          argv.shift();
        }

        // At this point, treat the first token as selector.
        const selector = normalizedSub;
        assertNonEmpty(selector, "Profile name or number");

        const storage = await loadStorage();
        const names = Object.keys(storage.profiles).sort((a, b) => a.localeCompare(b));

        const asNumber = Number(selector);
        const name = Number.isFinite(asNumber) && String(asNumber) === selector ? names[asNumber - 1] : selector;
        if (!name) {
          throw new Error(`Invalid selection '${selector}'. Use: /oai`);
        }

        const profile = storage.profiles[name];
        if (!profile) throw new Error(`Unknown profile '${name}'. Use: /oai`);

        // Only send fields supported by the SDK's OAuth type.
        await client.auth.set({
          path: { id: PROVIDER_ID },
          body: {
            type: "oauth",
            refresh: profile.oauth.refresh,
            access: profile.oauth.access,
            expires: profile.oauth.expires,
            ...(profile.oauth.enterpriseUrl ? { enterpriseUrl: profile.oauth.enterpriseUrl } : {}),
          },
        });

        const email = extractEmailFromAccessToken(profile.oauth.access);
        output.parts = [
          {
            type: "text",
            text: email ? `OpenAI active: ${email}` : `Switched active OpenAI account to profile '${name}'`,
          },
        ];
        await client.tui.showToast({
          body: {
            message: email ? `OpenAI active: ${email}` : `OpenAI active profile: ${name}`,
            variant: "success",
          },
        });
        return;
      } catch (error) {
        // Boundary: provide clear error feedback and rethrow so OpenCode logs it.
        const message = error instanceof Error ? error.message : String(error);
        output.parts = [{ type: "text", text: `OpenAI multi-account error: ${message}` }];
        await client.tui.showToast({ body: { message: `OpenAI multi-account error`, variant: "error" } });
        throw error;
      }
    },
  };
};
