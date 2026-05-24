/**
 * Three-pane chat UI mockup (static).
 *
 *   [ Rooms ]   [ Room messages (Slack-style threads) ]   [ Active thread ]
 *
 * The right pane (thread / chat session) is collapsible — when closed it
 * disappears entirely; the only re-open affordance lives on each
 * top-level message ("View thread") and on the room header.
 *
 * Tool calls use the schemas from apps/agent/src/agent.ts so the markup
 * matches what a real session will render.
 *
 * No data wiring, no state outside the collapse toggle. Route via
 * `/?mockup`.
 */

import { useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Hexagon,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Sparkles,
  Trash2,
  X,
  MessageSquare,
} from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineCode } from "@/components/ui/inline-code";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

// ── atoms ────────────────────────────────────────────────────────────


const AVATAR_PALETTE = [
  "bg-[#ea7d3a]",
  "bg-[#3f8f7a]",
  "bg-[#a85f3d]",
  "bg-[#5a5a5a]",
  "bg-[#c89f5b]",
];

function LetterAvatar({
  letter,
  idx = 0,
  size = 36,
}: {
  letter: string;
  idx?: number;
  size?: number;
}) {
  return (
    <div
      style={{ width: size, height: size }}
      className={`flex flex-shrink-0 items-center justify-center rounded-md font-semibold text-white shadow-sm ring-1 ring-black/5 ${AVATAR_PALETTE[idx % AVATAR_PALETTE.length]}`}
    >
      <span style={{ fontSize: Math.round(size * 0.42) }}>{letter}</span>
    </div>
  );
}

function AssistantAvatar({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="flex flex-shrink-0 items-center justify-center rounded-full bg-kumo-contrast text-kumo-inverse"
    >
      <Hexagon size={Math.round(size * 0.5)} strokeWidth={2.5} />
    </div>
  );
}

function AvatarStack({
  letters,
  size = 22,
}: {
  letters: Array<{ letter: string; idx: number }>;
  size?: number;
}) {
  return (
    <div className="flex -space-x-1.5">
      {letters.map((a, i) => (
        <div
          key={i}
          style={{ width: size, height: size }}
          className={`flex flex-shrink-0 items-center justify-center rounded-md text-2xs font-semibold text-white ring-2 ring-kumo-base ${AVATAR_PALETTE[a.idx % AVATAR_PALETTE.length]}`}
        >
          {a.letter}
        </div>
      ))}
    </div>
  );
}

// ── left: room list ──────────────────────────────────────────────────

function RoomListItem({
  letter,
  title,
  meta,
  active = false,
  idx = 0,
}: {
  letter: string;
  title: string;
  meta: string;
  active?: boolean;
  idx?: number;
}) {
  return (
    <button
      className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active
          ? "border-kumo-line bg-kumo-elevated"
          : "border-transparent hover:border-kumo-line hover:bg-kumo-elevated"
      }`}
    >
      <LetterAvatar letter={letter} idx={idx} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium  text-kumo-default">
          {title}
        </div>
        <div className="truncate text-xs text-kumo-inactive">{meta}</div>
      </div>
    </button>
  );
}

// ── centre: top-level message (Slack-style) ─────────────────────────

function TopLevelMessage({
  authorName,
  authorIdx,
  time,
  body,
  replyCount,
  replyAvatars,
  lastReplyAgo,
  active = false,
  onClick,
}: {
  authorName: string;
  authorIdx: number;
  time: string;
  body: React.ReactNode;
  replyCount: number;
  replyAvatars: Array<{ letter: string; idx: number }>;
  lastReplyAgo: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={`group rounded-lg px-3 py-3 transition-colors ${
        active ? "bg-kumo-elevated" : "hover:bg-kumo-elevated"
      }`}
    >
      <div className="flex items-start gap-3">
        <LetterAvatar letter={authorName[0]} idx={authorIdx} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold  text-kumo-default">
              {authorName}
            </span>
            <span className="text-xs text-kumo-inactive tabular-nums">
              {time}
            </span>
          </div>
          <div className="mt-1 space-y-2 text-base leading-6 text-kumo-default">
            {body}
          </div>
          <button
            onClick={onClick}
            className={`mt-3 flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
              active
                ? "border-kumo-line bg-kumo-base"
                : "border-transparent hover:border-kumo-line hover:bg-kumo-base"
            }`}
          >
            <AvatarStack letters={replyAvatars} />
            <span className="text-sm font-semibold text-kumo-brand">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </span>
            <span className="text-xs text-kumo-inactive">
              Last reply {lastReplyAgo}
            </span>
            <span className="ml-auto flex items-center gap-1 text-xs text-kumo-inactive opacity-0 transition-opacity group-hover:opacity-100">
              View thread
              <ChevronRight size={11} strokeWidth={2.5} />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── right: assistant block wrapper ───────────────────────────────────

function AssistantBlock({
  model,
  time,
  children,
}: {
  model: string;
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <AssistantAvatar size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-kumo-default">{model}</span>
          <span className="text-kumo-inactive tabular-nums">{time}</span>
        </div>
        <div className="mt-1 flex flex-col gap-3 text-base leading-6 text-kumo-default">
          {children}
        </div>
      </div>
    </div>
  );
}

function UserBubble({
  name,
  time,
  children,
}: {
  name: string;
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex w-full justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        <div className="px-3 text-2xs text-kumo-inactive">
          <span className="font-medium text-kumo-subtle">{name}</span>{" "}
          <span className="tabular-nums">{time}</span>
        </div>
        <Message from="user" className="ml-0">
          <MessageContent>
            <MessageResponse>{String(children)}</MessageResponse>
          </MessageContent>
        </Message>
      </div>
    </div>
  );
}

// ── thread pane: every part type, every tool, every state ────────────

function ThreadReplies() {
  return (
    <div className="chat-panel flex-1 space-y-6 overflow-y-auto px-5 py-5">
      {/* 1. Assistant text + reasoning + readFile tool */}
      <AssistantBlock model="Claude Sonnet 4.6" time="10:30">
        <MessageResponse>
{`On it — let me peek at the layout first. I'll start by reading the README and the main \`agent.ts\` file.`}
        </MessageResponse>

        <Reasoning isStreaming={false} duration={6} defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>
{`The user is asking me to walk through \`packages/think\`. I should:

1. Read README.md for the high-level picture.
2. List the package directory.
3. Open the entry point and skim exports.

Then propose where a Discord-search gadget could plug in.`}
          </ReasoningContent>
        </Reasoning>

        <Tool defaultOpen={false}>
          <ToolHeader type="tool-readFile" state="output-available" />
          <ToolContent>
            <ToolInput input={{ path: "/workspace/README.md" }} />
            <ToolOutput
              errorText={undefined}
              output={{
                path: "/workspace/README.md",
                content:
                  "# think\n\nA thin agent framework on top of the AI SDK…",
              }}
            />
          </ToolContent>
        </Tool>

        <Tool defaultOpen={false}>
          <ToolHeader type="tool-listDirectory" state="output-available" />
          <ToolContent>
            <ToolInput input={{ path: "/workspace/packages/think/src" }} />
            <ToolOutput
              errorText={undefined}
              output={{
                path: "/workspace/packages/think/src",
                entries: [
                  { name: "index.ts", type: "file" },
                  { name: "think.ts", type: "file" },
                  { name: "workspace-tools.ts", type: "file" },
                  { name: "providers", type: "directory" },
                ],
              }}
            />
          </ToolContent>
        </Tool>

        <MessageResponse>
{`The package exposes two interesting surfaces:

- **\`Think\`** — base class that wires the AI SDK \`streamText\` loop.
- **\`createWorkspaceTools\`** — file-system tools shared across personas.

| symbol | kind | exported from |
| --- | --- | --- |
| \`Think\` | class | \`index.ts\` |
| \`createWorkspaceTools\` | function | \`workspace-tools.ts\` |
| \`Persona\` | type | \`index.ts\` |`}
        </MessageResponse>
      </AssistantBlock>

      {/* 2. User markdown message */}
      <UserBubble name="Aron" time="10:32">
{`Cool. Can you sketch a **Discord triage gadget** on top? It should:

1. Take an inbound question.
2. Search \`cloudflare/agents\` issues for matches.
3. Draft a reply.`}
      </UserBubble>

      {/* 3. Assistant with writeFile + exec + run (with image output) */}
      <AssistantBlock model="Claude Sonnet 4.6" time="10:33">
        <MessageResponse>
{`Sketch incoming. I'll write a tiny CLI tool, compile it to WASM, then run it.`}
        </MessageResponse>

        <Tool defaultOpen={false}>
          <ToolHeader type="tool-writeFile" state="output-available" />
          <ToolContent>
            <ToolInput
              input={{
                path: "/workspace/triage.zig",
                content:
                  'const std = @import("std");\n\npub fn main() !void {\n    const stdout = std.io.getStdOut().writer();\n    try stdout.print("triage\\n", .{});\n}\n',
              }}
            />
            <ToolOutput
              errorText={undefined}
              output={{ path: "/workspace/triage.zig", bytesWritten: 142 }}
            />
          </ToolContent>
        </Tool>

        <Tool defaultOpen={true}>
          <ToolHeader type="tool-exec" state="output-available" />
          <ToolContent>
            <ToolInput
              input={{
                command:
                  "zig build-exe /workspace/triage.zig -target wasm32-wasi -O ReleaseSmall -femit-bin=/workspace/triage.wasm",
              }}
            />
            <ToolOutput
              errorText={undefined}
              output={{
                exitCode: 0,
                stdout: "",
                stderr: "",
              }}
            />
          </ToolContent>
        </Tool>

        <Tool defaultOpen={true}>
          <ToolHeader type="tool-run" state="output-available" />
          <ToolContent>
            <ToolInput
              input={{ command: "triage --question 'rate limits?'" }}
            />
            <ToolOutput
              errorText={undefined}
              output={{
                exitCode: 0,
                stdout: "triage\n",
                stderr: "",
                files: [],
                images: [],
              }}
            />
          </ToolContent>
        </Tool>

        <MessageResponse>
{`Compiled clean and the binary runs. Next I'd wire the GitHub search step.`}
        </MessageResponse>
      </AssistantBlock>

      {/* 4. User follow-up */}
      <UserBubble name="Aron" time="10:34">
        Check that the `GITHUB_REST_API` binding still works first.
      </UserBubble>

      {/* 5. Assistant with worker_deploy (input-streaming), worker_fetch (output-error), grep */}
      <AssistantBlock model="Claude Sonnet 4.6" time="10:35">
        <MessageResponse>{`Probing the binding now.`}</MessageResponse>

        <Tool defaultOpen={true}>
          <ToolHeader type="tool-grep" state="output-available" />
          <ToolContent>
            <ToolInput
              input={{
                pattern: "GITHUB_REST_API",
                path: "/workspace/wrangler.jsonc",
              }}
            />
            <ToolOutput
              errorText={undefined}
              output={{
                pattern: "GITHUB_REST_API",
                path: "/workspace/wrangler.jsonc",
                matches: [
                  {
                    file: "/workspace/wrangler.jsonc",
                    line: 14,
                    text: '      { "binding": "GITHUB_REST_API", "service": "github-rest" }',
                  },
                ],
              }}
            />
          </ToolContent>
        </Tool>

        <Tool defaultOpen={true}>
          <ToolHeader type="tool-worker_deploy" state="input-streaming" />
          <ToolContent>
            <ToolInput input={{ config: "/workspace/wrangler.jsonc" }} />
          </ToolContent>
        </Tool>

        <Tool defaultOpen={true}>
          <ToolHeader type="tool-worker_fetch" state="output-error" />
          <ToolContent>
            <ToolInput
              input={{
                request:
                  "fetch('https://w/api.github.com/repos/cloudflare/agents/issues')",
              }}
            />
            <ToolOutput
              output={undefined}
              errorText="HTTP 401 Unauthorized — token expired on 2026-04-30. Rotate GITHUB_TOKEN and redeploy."
            />
          </ToolContent>
        </Tool>

        <MessageResponse>
{`The token is expired — see the 401 above. You'll need to rotate \`GITHUB_TOKEN\` in the Worker secrets before I can hit the API.

\`\`\`bash
wrangler secret put GITHUB_TOKEN --name github-rest
\`\`\``}
        </MessageResponse>
      </AssistantBlock>
    </div>
  );
}

// ── shell ────────────────────────────────────────────────────────────

export function Mockup() {
  const [threadOpen, setThreadOpen] = useState(
    () => !new URLSearchParams(window.location.search).has("closed")
  );

  return (
    <div className="flex h-screen w-screen flex-col bg-kumo-base text-kumo-default">
      {/* Outer header */}
      <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-kumo-line bg-kumo-base/80 px-4 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <Hexagon size={20} strokeWidth={2.5} className="text-kumo-brand" />
          <span className="text-md font-semibold tracking-tight">
            hackspace
          </span>
        </div>


        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" aria-label="Share">
            <Share2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Settings">
            <Settings className="size-4" />
          </Button>
          <div className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-kumo-tint text-kumo-brand ring-1 ring-kumo-line">
            <Bot size={15} />
          </div>
        </div>
      </header>

      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId={threadOpen ? "agent-layout-3" : "agent-layout-2"}
        className="flex min-h-0 flex-1"
      >
        {/* Left pane — rooms */}
        {/* Left pane — rooms */}
        <ResizablePanel
          id="rooms"
          order={1}
          defaultSize={20}
          minSize={14}
          maxSize={32}
          className="!overflow-visible"
        >
        <aside className="flex h-full flex-col border-r border-kumo-line bg-kumo-base">
          <div className="flex h-14 flex-shrink-0 items-center justify-between px-5">
            <h2 className="text-md font-semibold ">
              Rooms
            </h2>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-lg bg-kumo-brand px-2.5 text-sm font-medium text-white hover:bg-kumo-brand-hover"
            >
              <Plus className="size-3" strokeWidth={2.5} />
              New
            </Button>
          </div>

          <div className="px-4 pb-3">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-elevated px-3 focus-within:border-kumo-ring focus-within:bg-kumo-base">
              <Search size={14} className="text-kumo-inactive" />
              <input
                type="text"
                placeholder="Search rooms…"
                className="block w-full border-0 bg-transparent p-0 text-sm outline-none placeholder:text-kumo-inactive"
              />
            </div>
          </div>

          <div className="chat-panel flex-1 space-y-1 overflow-y-auto px-3 pb-4">
            <RoomListItem
              letter="C"
              title="Cloudflare Agents"
              meta="14 threads · 1d ago"
              active
              idx={1}
            />
            <RoomListItem
              letter="M"
              title="Micro Machines Clone"
              meta="3 threads · 63d ago"
              idx={3}
            />
            <RoomListItem
              letter="W"
              title="Workers AI Gateway"
              meta="8 threads · 2d ago"
              idx={0}
            />
            <RoomListItem
              letter="D"
              title="DO naming for multi-user"
              meta="5 threads · 6d ago"
              idx={2}
            />
            <RoomListItem
              letter="S"
              title="Streaming JSON with AI SDK"
              meta="2 threads · 9d ago"
              idx={4}
            />
            <RoomListItem
              letter="K"
              title="Kumo theme overrides"
              meta="1 thread · 14d ago"
              idx={0}
            />
            <RoomListItem
              letter="A"
              title="Access JWT for *.workers.dev"
              meta="6 threads · 21d ago"
              idx={1}
            />
          </div>

          <div className="flex h-12 flex-shrink-0 items-center gap-2.5 border-t border-kumo-line px-4">
            <LetterAvatar letter="A" idx={3} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                aron@4g3nts.com
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Account">
              <MoreVertical className="size-4" />
            </Button>
          </div>
        </aside>
        </ResizablePanel>

        <ResizableHandle />

        {/* Centre pane — top-level messages */}
        <ResizablePanel id="room" order={2} defaultSize={50} minSize={30}>

        {/* Centre pane — top-level messages */}
        <section className="flex h-full min-w-0 flex-col border-r border-kumo-line">
          <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-md font-semibold ">
                  Cloudflare Agents
                </h1>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-kumo-inactive">
                <span>14 threads</span>
                <span>·</span>
                <span>Default model: Claude Sonnet 4.6</span>
              </div>
            </div>
            {!threadOpen && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setThreadOpen(true)}
              >
                <MessageSquare className="size-3.5" />
                Open thread
              </Button>
            )}
            <Select defaultValue="sonnet-4.6">
              <SelectTrigger className="h-8 w-[170px] gap-1 text-sm font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="sonnet-4.6">Claude Sonnet 4.6</SelectItem>
                <SelectItem value="opus-4">Claude Opus 4</SelectItem>
                <SelectItem value="gpt-5">GPT-5</SelectItem>
                <SelectItem value="kimi-k2">Kimi K2</SelectItem>
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Room actions"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                <DropdownMenuItem>

                  Rename room
                </DropdownMenuItem>
                <DropdownMenuItem>

                  Room settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive>

                  Delete room
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="chat-panel flex-1 overflow-y-auto">
            <div className="space-y-1 px-4 py-5">
              <TopLevelMessage
                authorName="Aron"
                authorIdx={3}
                time="Yesterday at 14:21"
                replyCount={11}
                replyAvatars={[
                  { letter: "C", idx: 1 },
                  { letter: "A", idx: 3 },
                ]}
                lastReplyAgo="6h ago"
                body={
                  <>
                    <p>Hi team,</p>
                    <p>
                      I want to build a triage gadget for our Discord support
                      channel. Idea: someone pastes a question, the gadget
                      searches our public repos for related issues/PRs, plus a
                      local knowledge base of canned answers, and drafts a
                      reply.
                    </p>
                    <p>
                      Can you set up the GitHub bindings for{" "}
                      <InlineCode>cloudflare/agents</InlineCode> and{" "}
                      <InlineCode>cloudflare/sandbox-sdk</InlineCode>?
                    </p>
                  </>
                }
              />
              <TopLevelMessage
                authorName="Aron"
                authorIdx={3}
                time="Today at 10:02"
                replyCount={3}
                replyAvatars={[{ letter: "C", idx: 1 }]}
                lastReplyAgo="3h ago"
                body={
                  <p>
                    Quick follow-up — the GitHub token on{" "}
                    <InlineCode>GITHUB_REST_API</InlineCode> seems to have
                    expired. Can you check?
                  </p>
                }
              />
              <TopLevelMessage
                authorName="Aron"
                authorIdx={3}
                time="Today at 10:28"
                replyCount={8}
                replyAvatars={[
                  { letter: "C", idx: 1 },
                  { letter: "A", idx: 3 },
                ]}
                lastReplyAgo="just now"
                active
                onClick={() => setThreadOpen(true)}
                body={
                  <p>
                    Try cloning the repo locally and walk me through the
                    structure of <InlineCode>packages/think</InlineCode>. Then
                    propose a place to wire a Discord-search gadget on top.
                  </p>
                }
              />
            </div>
          </div>

          <div className="flex-shrink-0 bg-kumo-base px-5 pb-4 pt-2">
            <div className="prompt-input rounded-2xl border px-4 pb-2 pt-3">
              <textarea
                rows={1}
                placeholder="Start a new thread in #Cloudflare Agents…"
                className="block w-full resize-none border-0 bg-transparent p-0 text-base leading-6  outline-none placeholder:text-kumo-inactive"
              />
              <div className="flex items-end justify-between gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-sm font-medium"
                >
                  Claude Sonnet 4.6
                  <ChevronDown size={11} />
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Toggle reasoning"
                  >
                    <Sparkles size={15} />
                  </Button>
                  <Button
                    size="icon-sm"
                    aria-label="Send"
                    className="bg-kumo-brand text-white hover:bg-kumo-brand-hover"
                  >
                    <ArrowUp size={15} strokeWidth={2.5} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
        </ResizablePanel>

        {/* Right pane — thread (collapsible: fully hidden when closed) */}
        {threadOpen && (<>
          <ResizableHandle />
          <ResizablePanel
            id="thread"
            order={3}
            defaultSize={30}
            minSize={20}
            maxSize={60}
          >
          <aside className="flex h-full flex-col bg-kumo-base">
            <div className="flex h-14 flex-shrink-0 items-center gap-2 border-b border-kumo-line px-5">

              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-semibold ">
                  Thread
                </div>
                <div className="flex items-center gap-2 truncate text-xs text-kumo-inactive">
                  <span>#Cloudflare Agents · 8 replies</span>
                  <span>·</span>
                  <span className="tabular-nums">
                    <span className="text-kumo-subtle">19,534</span> tokens
                  </span>
                  <span>·</span>
                  <span className="tabular-nums text-kumo-subtle">
                    $0.8094
                  </span>
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="More">
                <MoreVertical className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close thread"
                onClick={() => setThreadOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>

            {/* Quoted root */}
            <div className="border-b border-kumo-line bg-kumo-elevated px-5 py-4">
              <div className="flex items-start gap-2.5">
                <LetterAvatar letter="A" idx={3} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-kumo-default">
                      Aron
                    </span>
                    <span className="text-2xs text-kumo-inactive tabular-nums">
                      Today at 10:28
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-5 text-kumo-default">
                    Try cloning the repo locally and walk me through the
                    structure of <InlineCode>packages/think</InlineCode>. Then
                    propose a place to wire a Discord-search gadget on top.
                  </p>
                </div>
              </div>
            </div>

            <ThreadReplies />

            {/* Accept-changes banner */}
            <div className="flex flex-shrink-0 items-center justify-between border-t border-kumo-line bg-kumo-base px-5 py-2.5">
              <span className="text-xs text-kumo-subtle">
                Accept changes to apply them to the gadget.
              </span>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-kumo-contrast text-kumo-inverse hover:opacity-90"
              >
                <Check size={12} strokeWidth={2.5} />
                Accept
              </Button>
            </div>

            {/* Thread composer */}
            <div className="flex-shrink-0 bg-kumo-base px-4 pb-3 pt-2">
              <div className="prompt-input rounded-2xl border px-3.5 pb-2 pt-3">
                <textarea
                  rows={1}
                  placeholder="Reply…"
                  className="block w-full resize-none border-0 bg-transparent p-0 text-base leading-6  outline-none placeholder:text-kumo-inactive"
                />
                <div className="flex items-end justify-between gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs font-medium"
                  >
                    Claude Sonnet 4.6
                    <ChevronDown size={10} />
                  </Button>
                  <Button
                    size="icon-sm"
                    aria-label="Send"
                    className="h-7 w-7 bg-kumo-brand text-white hover:bg-kumo-brand-hover"
                  >
                    <ArrowUp size={13} strokeWidth={2.5} />
                  </Button>
                </div>
              </div>
            </div>
          </aside>
          </ResizablePanel>
        </>
        )}
      </ResizablePanelGroup>

      {/* Status badges — show that all 5 tool states render. Sitting in the
          bottom-right so it's visible in the screenshot but unobtrusive. */}
      <div className="pointer-events-none fixed bottom-2 right-2 flex gap-1 opacity-60">
        <Badge variant="secondary" className="text-2xs">
          mockup
        </Badge>
      </div>
    </div>
  );
}
