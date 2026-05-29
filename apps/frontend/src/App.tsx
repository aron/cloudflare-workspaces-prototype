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

import { lazy, Suspense, useEffect, useState } from "react";

import { RoomPicker } from "./components/RoomPicker";
import { fetchMe, type Me } from "./lib/api";
import { useRoute } from "./lib/nav";
import { ReceiptsProvider } from "./lib/receipts";

// Chat rendering pulls in streamdown, shiki, mermaid, motion, and the
// Radix UI suite. None of that is needed for the picker landing page, so
// we defer the import until the user actually navigates into a room.
const RoomShell = lazy(() =>
  import("./components/RoomShell").then(m => ({ default: m.RoomShell })),
);
const RoomTimeline = lazy(() =>
  import("./components/RoomTimeline").then(m => ({ default: m.RoomTimeline })),
);
const ThreadPanel = lazy(() =>
  import("./components/ThreadPanel").then(m => ({ default: m.ThreadPanel })),
);

const RoomFallback = (
  <div className="flex min-h-screen items-center justify-center bg-kumo-base text-sm text-kumo-inactive">
    Loading…
  </div>
);

const ThreadFallback = (
  <section className="flex h-full min-h-0 flex-col border-l border-kumo-line bg-kumo-panel">
    <div className="flex h-14 flex-shrink-0 items-center border-b border-kumo-line px-4 text-sm text-kumo-inactive">
      Loading thread…
    </div>
  </section>
);

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

  // Map current route to UI. Wrapped in ReceiptsProvider so every room/
  // thread view sees the same live receipts state — the picker also
  // benefits because it shows unread dots on each room card.
  const view = (() => {
    switch (route.kind) {
      case "picker":
        return <RoomPicker me={me} />;
      case "room":
        return (
          <Suspense fallback={RoomFallback}>
            <RoomShell me={me} roomId={route.roomId}
                       centre={<RoomTimeline me={me} roomId={route.roomId} model={me.model} />} />
          </Suspense>
        );
      case "thread":
        return (
          <Suspense fallback={RoomFallback}>
            <RoomShell
              me={me}
              roomId={route.roomId}
              threadId={route.threadId}
              centre={<RoomTimeline me={me} roomId={route.roomId} activeThreadId={route.threadId} model={me.model} />}
              thread={
                <Suspense fallback={ThreadFallback}>
                  <ThreadPanel roomId={route.roomId} threadId={route.threadId} model={me.model} />
                </Suspense>
              }
            />
          </Suspense>
        );
    }
  })();
  return <ReceiptsProvider userId={me.userId}>{view}</ReceiptsProvider>;
}
