import { Badge } from "@/components/ui/badge";
import type { ChatMessage } from "@/types";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  switch (message.variant) {
    case "text":
      return message.role === "user" ? (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-lg bg-primary px-4 py-2 text-primary-foreground">
            {message.content}
          </div>
        </div>
      ) : (
        <div className="max-w-[80%]">
          <div className="prose prose-sm dark:prose-invert">
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          </div>
        </div>
      );

    case "status":
      return (
        <div className="flex justify-center">
          <span className="text-xs text-muted-foreground">{message.content}</span>
        </div>
      );

    case "phase":
      return (
        <div className="flex justify-center py-1">
          <Badge variant="secondary">
            {message.content}
          </Badge>
        </div>
      );

    case "tool_summary":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{message.meta?.tool_name}</span>
          <span className="truncate">{message.content}</span>
        </div>
      );

    case "complete":
      return (
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
          <p className="font-medium text-green-700 dark:text-green-400">Session completed</p>
          {message.meta?.pr_url && (
            <a
              href={message.meta.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-sm text-blue-600 underline dark:text-blue-400"
            >
              {message.meta.pr_url}
            </a>
          )}
        </div>
      );

    case "error":
      return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{message.content}</p>
        </div>
      );

    case "verification_failed":
      return (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <p className="font-medium text-yellow-700 dark:text-yellow-400">
            Verification failed ({message.meta?.attempts} attempt{message.meta?.attempts === 1 ? "" : "s"})
          </p>
          {message.meta?.last_error && (
            <p className="mt-1 text-sm text-muted-foreground">{message.meta.last_error}</p>
          )}
        </div>
      );

    case "plan":
      return null;

    default:
      return null;
  }
}
