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
        <div className="flex justify-end py-1">
          <div className="max-w-[80%] rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">
            {message.content}
          </div>
        </div>
      ) : (
        <div className="timeline-item timeline-item-text">
          <div className="prose prose-sm dark:prose-invert">
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          </div>
        </div>
      );

    case "status":
      return (
        <div className="timeline-item">
          <span className="timeline-dot" />
          <span className="timeline-copy">{message.content}</span>
        </div>
      );

    case "phase":
      return (
        <div className="timeline-item timeline-item-phase">
          <span className="timeline-dot timeline-dot-active" />
          <Badge variant="secondary" className="rounded-md font-mono text-[11px]">
            {message.content}
          </Badge>
        </div>
      );

    case "progress":
      return (
        <div className="timeline-item timeline-item-progress">
          <span className="timeline-dot timeline-dot-progress" />
          <span className="timeline-progress-label">{message.content}</span>
        </div>
      );

    case "tool_summary":
      return (
        <div className="timeline-item timeline-item-tool">
          <span className="timeline-dot timeline-dot-muted" />
          <span className="font-mono">{message.meta?.tool_name}</span>
          <span className="truncate">{message.content}</span>
        </div>
      );

    case "complete":
      return (
        <div className="timeline-card timeline-card-success">
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
        <div className="timeline-card timeline-card-error">
          <p className="text-sm text-destructive">{message.content}</p>
        </div>
      );

    case "verification_failed":
      return (
        <div className="timeline-card timeline-card-warning">
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
