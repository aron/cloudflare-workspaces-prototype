/**
 * Root client entry. The URL is the only source of truth for navigation:
 *
 *   /                            → <RoomPicker />
 *   /rooms/:id                   → <RoomSidebar /> + <RoomView />
 *   /rooms/:id/threads/:tid      → <RoomSidebar /> + <RoomView /> + <ThreadPanel />
 *
 * Identity is fetched once at boot from `/api/app/me` (which also upserts
 * the user row in AppDO). Nothing about the session is in localStorage.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { fetchMe, type Me } from "./client/api.js";
import { useRoute } from "./client/nav.js";
import { RoomPicker }  from "./client/RoomPicker.js";
import { RoomSidebar } from "./client/RoomSidebar.js";
import { RoomView }    from "./client/RoomView.js";
import { ThreadPanel } from "./client/ThreadPanel.js";
import { colors, s } from "./client/styles.js";

function App() {
  const [me, setMe]       = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    fetchMe().then(setMe).catch(e => setError((e as Error).message));
  }, []);

  if (error) return <div style={s.errorBox}>{error}</div>;
  if (!me)   return <div style={bootStyles.boot}>Loading…</div>;

  switch (route.kind) {
    case "picker":
      return <RoomPicker userName={me.name} />;

    case "room":
      return (
        <div style={s.app}>
          <RoomSidebar activeRoomId={route.roomId} />
          <RoomView roomId={route.roomId} />
        </div>
      );

    case "thread":
      return (
        <div style={s.appWithThread}>
          <RoomSidebar activeRoomId={route.roomId} />
          <RoomView roomId={route.roomId} highlightThreadId={route.threadId} />
          <ThreadPanel roomId={route.roomId} threadId={route.threadId} />
        </div>
      );
  }
}

const bootStyles: Record<string, React.CSSProperties> = {
  boot: { display: "flex", alignItems: "center", justifyContent: "center", height: "100dvh",
          background: colors.bg, color: colors.textDim, fontFamily: "system-ui, sans-serif" },
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
