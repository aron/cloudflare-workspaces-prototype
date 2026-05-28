"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { humanizeDuration } from "@/lib/humanize-duration";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-1.5 w-full rounded-lg border border-kumo-line bg-kumo-tint", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  /**
   * Wall-clock duration of the tool call in milliseconds. Rendered as
   * a small italic label in the header (top-right, before the chevron)
   * so the user can see at a glance how long each call took without
   * expanding the part. Omitted while the call is still running — the
   * value only becomes meaningful after `output-available` /
   * `output-error`.
   */
  callDurationMs?: number;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-kumo-warning" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-kumo-info" />,
  "input-available": <ClockIcon className="size-4 animate-pulse text-kumo-inactive" />,
  "input-streaming": <CircleIcon className="size-4 text-kumo-inactive" />,
  "output-available": <CheckCircleIcon className="size-4 text-kumo-success" />,
  "output-denied": <XCircleIcon className="size-4 text-kumo-warning" />,
  "output-error": <XCircleIcon className="size-4 text-kumo-danger" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="h-5 gap-1 rounded-full px-2 py-0 text-2xs font-medium leading-none" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  callDurationMs,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-3 px-3 py-1.5",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-3 text-kumo-inactive" />
        <span className="font-mono text-xs leading-none text-kumo-subtle">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <div className="flex items-center gap-2">
        {callDurationMs !== undefined && (
          <span className="text-2xs italic leading-none text-kumo-inactive">
            {humanizeDuration(callDurationMs)}
          </span>
        )}
        <ChevronDownIcon className="size-3.5 text-kumo-inactive transition-transform group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-3 p-3 text-kumo-default outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-mono text-2xs uppercase tracking-wide text-kumo-inactive">
      Parameters
    </h4>
    <div className="overflow-hidden rounded-md">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-mono text-2xs uppercase tracking-wide text-kumo-inactive">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "border-l-2 border-kumo-danger bg-kumo-danger-tint/30 px-3 py-2 text-kumo-default"
            : "text-kumo-default"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
