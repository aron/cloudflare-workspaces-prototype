/**
 * Top-level client component. The URL drives everything:
 *
 *   /                              → RoomPicker
 *   /rooms/:id                     → three-pane shell (sidebar + timeline)
 *   /rooms/:id/threads/:threadId   → adds a thread panel on the right
 *
 * Identity is bootstrapped once at boot via `GET /api/app/me`. While we
 * wait, render a small splash so the layout doesn't jump.
 */

import { useEffect, useState } from "react";

import { RoomPicker } from "./components/RoomPicker";
import { RoomShell } from "./components/RoomShell";
import { RoomTimelinePlaceholder } from "./components/RoomTimelinePlaceholder";
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
      return (
        <RoomShell me={me} roomId={route.roomId}
                   centre={<RoomTimelinePlaceholder roomId={route.roomId} />} />
      );

    case "thread":
      return (
        <RoomShell
          me={me}
          roomId={route.roomId}
          threadId={route.threadId}
          centre={<RoomTimelinePlaceholder roomId={route.roomId} />}
          thread={(
            <div className="flex h-full items-center justify-center text-sm text-kumo-inactive">
              Thread panel coming online — next commit wires useAgentChat.
            </div>
          )}
        />
      );
  }
}
