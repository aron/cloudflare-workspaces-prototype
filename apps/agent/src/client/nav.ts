/**
 * Tiny `useRoute()` hook + `navigate()` helper.
 *
 * Wraps `history.pushState` + `popstate` so the React tree re-renders
 * whenever the URL changes. No router library — the parser in `route.ts`
 * does the work, this just glues it to React via `useSyncExternalStore`.
 */

import { useSyncExternalStore } from "react";
import { formatRoute, parseRoute, type Route } from "./route.js";

// External store: subscribe to popstate + a custom event we dispatch
// ourselves on programmatic navigation.
const NAV_EVENT = "pi:navigate";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

function getSnapshot(): string {
  return window.location.pathname;
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot, () => "/");
  return parseRoute(pathname);
}

/** Push a new route onto history and notify subscribers. */
export function navigate(route: Route): void {
  const path = formatRoute(route);
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Replace the current entry (use for fixing up bad URLs without a back-stack entry). */
export function replaceRoute(route: Route): void {
  const path = formatRoute(route);
  window.history.replaceState(null, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}
