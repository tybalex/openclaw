import type { Tab } from "./navigation";
import { connectGateway } from "./app-gateway";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings";
import {
  handleOidcCallback,
  hasOidcTokens,
  getOidcUserEmail,
  ensureValidOidcToken,
  startOidcLogin,
  scheduleTokenRefresh,
  cancelTokenRefresh,
} from "./oidc";

type LifecycleHost = {
  basePath: string;
  tab: Tab;
  chatHasAutoScrolled: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  oidcLoggedIn: boolean;
  oidcUser: string | null;
};

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]);

  // OIDC callback must be detected BEFORE syncTabWithLocation, which rewrites
  // unknown paths (like /callback) to /chat and destroys the query params.
  const params = new URLSearchParams(window.location.search);
  const isOidcCallback =
    window.location.pathname === "/callback" && params.has("code") && params.has("state");

  if (isOidcCallback) {
    // Exchange the authorization code for tokens first.
    // cleanCallbackParams() inside handleOidcCallback restores the original URL,
    // so syncTabWithLocation will see the correct path afterwards.
    void handleOidcCallback().then(() => {
      // Re-infer basePath now that cleanCallbackParams() restored the original URL.
      host.basePath = inferBasePath();
      syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
      syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
      attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
      window.addEventListener("popstate", host.popStateHandler);
      syncOidcState(host);
      scheduleTokenRefresh();
      connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
      startPolling(host);
    });
    return;
  }

  // Normal (non-callback) flow.
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);

  // Require NVIDIA SSO before proceeding. If no valid OIDC token,
  // try a silent refresh; if that fails, redirect to SSO.
  void ensureValidOidcToken().then((token) => {
    syncOidcState(host);
    if (!token) {
      void startOidcLogin();
      return;
    }
    scheduleTokenRefresh();
    connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
  });
  startPolling(host);
}

function startPolling(host: LifecycleHost): void {
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
}

/** Sync OIDC login state from sessionStorage into the host. */
function syncOidcState(host: LifecycleHost): void {
  host.oidcLoggedIn = hasOidcTokens();
  host.oidcUser = getOidcUserEmail();
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  cancelTokenRefresh();
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
