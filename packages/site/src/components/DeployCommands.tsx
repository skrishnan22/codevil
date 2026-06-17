import { useState } from "react";
import { DEPLOY_STEPS } from "../lib/commands";

export default function DeployCommands() {
  return (
    <div className="flex flex-col gap-6">
      {DEPLOY_STEPS.map((step, i) => (
        <CommandBlock key={i} index={i + 1} title={step.title} commands={step.commands} />
      ))}
    </div>
  );
}

function CommandBlock({
  index,
  title,
  commands,
}: {
  index: number;
  title: string;
  commands: string[];
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = commands.filter((c) => !c.startsWith("# ")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="font-mono text-xs text-fg-3">
          {String(index).padStart(2, "0")} · {title}
        </span>
        <button
          type="button"
          onClick={copy}
          className="font-mono text-xs font-medium text-accent transition-opacity hover:opacity-70"
          aria-label={`Copy ${title} commands`}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-fg-2">
        {commands.map((cmd, i) => (
          <div key={i} className={cmd.startsWith("# ") ? "text-fg-4" : ""}>
            <span className="mr-3 select-none text-fg-4">$</span>
            {cmd.startsWith("# ") ? cmd.slice(2) : cmd}
          </div>
        ))}
      </pre>
    </div>
  );
}
