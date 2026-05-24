/**
 * Top-level client component. The URL drives everything:
 *
 *   /                              → RoomPicker
 *   /rooms/:id                     → Mockup (placeholder until wired)
 *   /rooms/:id/threads/:threadId   → Mockup (placeholder until wired)
 *
 * Identity is bootstrapped once at boot via `GET /api/app/me`. While we
 * wait, render a small splash so the layout doesn't jump.
 */

import { useEffect, useState } from "react";

import { Mockup } from "./Mockup";
import { RoomPicker } from "./components/RoomPicker";
import { fetchMe, type Me } from "./lib/api";
import { useRoute } from "./lib/nav";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    fetchMe().then(setMe).catch(e => setError((e as Error).message));
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kumo-base p-6 text-sm text-red-400">
        Couldn't load identity: {error}
      </div>
    );
  }
  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kumo-base text-sm text-kumo-inactive">
        Loading…
      </div>
    );
  }

  switch (route.kind) {
    case "picker":
      return <RoomPicker me={me} />;
    case "room":
    case "thread":
      // TODO: wire these against the real API. For now, fall back to the
      // static mockup so the rest of the UI can be developed in place.
      return <Mockup />;
  }
}
