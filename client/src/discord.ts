import { DiscordSDK } from "@discord/embedded-app-sdk";

export const DISCORD_CLIENT_ID = "1549787463642517516";

export function isInDiscord(): boolean {
  return typeof window !== "undefined" && window.location.hostname.endsWith(".discordsays.com");
}

// Inside Discord, the client and the Colyseus server are proxied through the
// same discordsays.com origin (see the URL Mappings in the dev portal), so we
// connect same-origin instead of hardcoding the Render URL.
export function discordServerUrl(): string | null {
  if (!isInDiscord()) return null;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

export interface DiscordSession {
  sdk: DiscordSDK;
  instanceId: string;
  username: string | null;
}

let cached: Promise<DiscordSession | null> | null = null;

export function setupDiscord(): Promise<DiscordSession | null> {
  if (!isInDiscord()) return Promise.resolve(null);
  if (cached) return cached;

  cached = (async () => {
    const sdk = new DiscordSDK(DISCORD_CLIENT_ID);
    await sdk.ready();

    let username: string | null = null;
    try {
      const { code } = await sdk.commands.authorize({
        client_id: DISCORD_CLIENT_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify"],
      });

      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const { access_token } = await res.json();

      const auth = await sdk.commands.authenticate({ access_token });
      username = auth?.user?.global_name || auth?.user?.username || null;
    } catch (e) {
      console.warn("Discord identify failed, continuing with a manual name", e);
    }

    return { sdk, instanceId: sdk.instanceId, username };
  })();

  return cached;
}
