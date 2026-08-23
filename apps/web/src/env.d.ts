/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

declare namespace App {
  interface Locals extends import("@astrojs/cloudflare").Runtime {}
}

/** Options accepted by turnstile.render(). Only what the ballot passes. */
interface TurnstileRenderOptions {
  sitekey: string;
  /** "render" runs the challenge immediately; "execute" waits for execute(). */
  execution?: "render" | "execute";
  /** "interaction-only" keeps the widget invisible unless a human is needed. */
  appearance?: "always" | "execute" | "interaction-only";
  size?: "normal" | "flexible" | "compact";
  theme?: "auto" | "light" | "dark";
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
}

/**
 * Turnstile's api.js attaches this global once loaded. Optional because the
 * script is deferred, so it may not have run yet when a handler fires.
 *
 * `onTurnstileLoad` is ours — api.js calls it because the script URL carries
 * `?onload=onTurnstileLoad`, which is why it has to hang off window.
 */
interface Window {
  turnstile?: {
    render(container: string | HTMLElement, options: TurnstileRenderOptions): string | undefined;
    /** Runs a deferred challenge on an already-rendered widget. */
    execute(widget?: string | HTMLElement, options?: TurnstileRenderOptions): void;
    /** Clears the solved token so the next attempt gets a fresh one. */
    reset(widget?: string | HTMLElement): void;
    remove(widget?: string | HTMLElement): void;
    getResponse(widget?: string | HTMLElement): string | undefined;
  };
  onTurnstileLoad?: () => void;
}
