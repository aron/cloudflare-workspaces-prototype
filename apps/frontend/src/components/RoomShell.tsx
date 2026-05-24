/**
 * Three-pane layout for `/rooms/:id[/threads/:tid]`. The sidebar is
 * always-on; the centre pane will host the room timeline (next commit);
 * the right pane mounts only when the route carries a threadId.
 *
 * The centre and right slots are passed in by the caller (App.tsx),
 * so this component is layout-only.
 */

import { Hexagon, Settings, Share2 } from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { Button } from "@/components/ui/button";
import { RoomSidebar } from "@/components/RoomSidebar";
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
  thread?:   React.ReactNode;
}) {
  const threadOpen = Boolean(threadId);

  return (
    <div className="flex h-screen w-screen flex-col bg-kumo-base text-kumo-default">
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base/80 px-4 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <Hexagon size={20} strokeWidth={2.5} className="text-kumo-brand" />
          <span className="text-md font-semibold tracking-tight">hackspace</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Share">
            <Share2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Settings">
            <Settings className="size-4" />
          </Button>
        </div>
      </header>

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId={threadOpen ? "agent-layout-3" : "agent-layout-2"}
        className="flex min-h-0 flex-1"
      >
        <ResizablePanel id="rooms" order={1} defaultSize={20} minSize={14} maxSize={32} className="!overflow-visible">
          <RoomSidebar me={me} activeRoomId={roomId} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="room" order={2} defaultSize={50} minSize={30}>
          {centre}
        </ResizablePanel>
        {threadOpen && thread && (
          <>
            <ResizableHandle />
            <ResizablePanel id="thread" order={3} defaultSize={30} minSize={20} maxSize={60}>
              {thread}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
