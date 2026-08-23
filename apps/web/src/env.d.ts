/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

declare namespace App {
  interface Locals extends import("@astrojs/cloudflare").Runtime {}
}

/**
 * Turnstile's api.js attaches this global once loaded. Only the members the
 * ballot actually calls are declared — it is optional because the script is
 * `async defer`, so it may not have run yet when a handler fires.
 */
interface Window {
  turnstile?: {
    /** Clears the solved token so a retry gets a fresh one. Tokens are single-use. */
    reset(widget?: string | HTMLElement): void;
    getResponse(widget?: string | HTMLElement): string | undefined;
  };
}
