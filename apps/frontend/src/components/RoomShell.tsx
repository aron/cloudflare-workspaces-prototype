/**
 * Three-pane layout for `/rooms/:id[/threads/:tid]`. The sidebar is
 * always-on; the centre pane will host the room timeline (next commit);
 * the right pane mounts only when the route carries a threadId.
 *
 * The centre and right slots are passed in by the caller (App.tsx),
 * so this component is layout-only.
 *
 * A toggle in the header opens an Unread panel in the right slot. When a
 * thread is also open the Unread panel appears as a fourth pane to the right
 * of the thread.
 */

import { useCallback, useState } from "react";
import { ChevronRight, Hexagon, Inbox } from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { RoomSidebar } from "@/components/RoomSidebar";
import { UnreadPanel } from "@/components/UnreadPanel";
import { useReceipts } from "@/lib/receipts";
import type { Me } from "@/lib/api";

export function RoomShell({
  me,
  roomId,
  threadId,
  centre,
  thread,
}: {
  me:        Me;
  roomId:    string;
  threadId?: string;
  centre:    React.ReactNode;
  // thread receives onExpand/onCollapse so its header can toggle fullwidth.
  thread?:   ((onExpand: () => void, onCollapse: () => void, expanded: boolean) => React.ReactNode) | React.ReactNode;
}) {
  const threadOpen  = Boolean(threadId);
  const [unreadOpen, setUnreadOpen] = useState(false);
  const [threadExpanded, setThreadExpanded] = useState(false);

  // Count unread scopes for the badge on the toggle button.
  const { tips, isUnread } = useReceipts();
  const unreadCount = [...tips.keys()].filter(key => {
    const [scope, scopeId] = key.split(":") as ["room" | "thread", string];
    return isUnread(scope, scopeId);
  }).length;

  // autoSaveId encodes which right panels are open so panel widths are
  // restored correctly when the layout changes.
  const layoutId = [
    "agent-layout",
    threadOpen ? "t" : "",
    unreadOpen ? "u" : "",
  ].filter(Boolean).join("-");

  const handleExpand   = useCallback(() => setThreadExpanded(true),  []);
  const handleCollapse = useCallback(() => setThreadExpanded(false), []);

  const threadNode = typeof thread === "function"
    ? thread(handleExpand, handleCollapse, threadExpanded)
    : thread;

  // ── Thread full-width mode ────────────────────────────────────────────
  // When expanded we bypass the resizable panel group entirely and render
  // a plain flex row: a slim 40px strip on the left (restore chevron) and
  // the thread filling the rest. This avoids fighting autoSaveId restoring
  // old panel sizes and guarantees a true full-width thread.
  if (threadExpanded && threadNode) {
    return (
      <div className="flex h-screen w-screen bg-kumo-base text-kumo-default">
        {/* Slim restore strip */}
        <button
          type="button"
          onClick={handleCollapse}
          aria-label="Restore sidebar and room"
          className="flex w-10 flex-shrink-0 flex-col items-center justify-center gap-1 border-r border-kumo-line bg-kumo-panel text-kumo-inactive transition-colors hover:bg-kumo-elevated hover:text-kumo-default"
        >
          <ChevronRight size={16} />
        </button>
        {/* Thread fills the rest */}
        <div className="min-w-0 flex-1">
          {threadNode}
        </div>
      </div>
    );
  }

  // ── Normal three-pane layout ──────────────────────────────────────────
  return (
    <div className="flex h-screen w-screen flex-col bg-kumo-base text-kumo-default">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base/80 px-4 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <Hexagon size={20} strokeWidth={2.5} className="text-kumo-brand" />
          <span className="text-md font-semibold tracking-tight">hackspace</span>
        </div>

        {/* Unread toggle */}
        <button
          type="button"
          onClick={() => setUnreadOpen(v => !v)}
          aria-label={unreadOpen ? "Close unread panel" : "Open unread panel"}
          title={unreadOpen ? "Close unread" : "Unread messages"}
          className={`relative flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            unreadOpen
              ? "bg-kumo-tint text-kumo-brand"
              : "text-kumo-inactive hover:bg-kumo-elevated hover:text-kumo-default"
          }`}
        >
          <Inbox size={17} />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-kumo-brand px-1 text-[9px] font-bold leading-none text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </header>

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId={layoutId}
        className="flex min-h-0 flex-1"
      >
        <ResizablePanel
          id="rooms" order={1}
          defaultSize={20} minSize={14} maxSize={32}
          className="!overflow-visible"
        >
          <RoomSidebar me={me} activeRoomId={roomId} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel
          id="room" order={2}
          defaultSize={threadOpen || unreadOpen ? 50 : 80} minSize={30}
        >
          {centre}
        </ResizablePanel>
        {threadOpen && threadNode && (
          <>
            <ResizableHandle />
            <ResizablePanel id="thread" order={3} defaultSize={30} minSize={20} maxSize={60}>
              {threadNode}
            </ResizablePanel>
          </>
        )}
        {unreadOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel id="unread" order={4} defaultSize={25} minSize={18} maxSize={45}>
              <UnreadPanel onClose={() => setUnreadOpen(false)} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
