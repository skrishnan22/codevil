import type { ExternalNotificationIntent } from "../notification-intents.js";
import type { SlackMessageContent } from "./client.js";
import type { QuestionOption } from "@codevil/shared";
import type { ExternalRunPresentation, ExternalRunStep } from "../external-run-presentation.js";
import { MAX_VISIBLE_STEPS, validPullRequestUrl } from "../external-run-presentation.js";

const MAX_EXTERNAL_TEXT_LENGTH = 500;
const MAX_SLACK_MARKDOWN_CHARS = 11_500;
const MAX_SLACK_ACTION_VALUE_LENGTH = 2_000;
const MAX_SLACK_OPTION_TEXT_LENGTH = 75;

export function renderSlackRunCard(
  presentation: ExternalRunPresentation,
  sessionUrl: string,
  revision: number,
): SlackMessageContent {
  const details = renderDetails(presentation);
  const sources: Array<Record<string, unknown>> = [
    { type: "url", url: sessionUrl, text: "Open Codevil" },
  ];
  const prUrl = presentation.prUrl ? validPullRequestUrl(presentation.prUrl) : undefined;
  if (prUrl) sources.push({ type: "url", url: prUrl, text: "View pull request" });

  const block = {
    type: "task_card",
    task_id: `codevil_${presentation.runId}`.slice(0, 255),
    title: presentation.title.slice(0, 120),
    status: presentation.status,
    block_id: `codevil_run_${presentation.runId}_${revision}`.slice(0, 255),
    details: richText(details),
    ...(presentation.status === "complete" || presentation.status === "error"
      ? { output: richText([presentation.summary ?? (presentation.status === "complete" ? "Completed successfully." : "The Agent Run failed.")]) }
      : {}),
    sources,
  };
  return {
    text: `Codevil: ${presentation.title} — ${briefStatus(presentation)}. Open session: ${sessionUrl}`.slice(0, MAX_EXTERNAL_TEXT_LENGTH),
    blocks: [block],
  };
}

function renderDetails(presentation: ExternalRunPresentation): string[] {
  const lines: string[] = [];
  if (presentation.queuedPosition !== undefined) {
    lines.push(`In queue — position ${presentation.queuedPosition}`);
  } else if (presentation.waitingFor) {
    lines.push(presentation.waitingFor === "question"
      ? "Waiting for your answer"
      : "Waiting for plan approval");
  } else {
    lines.push(presentation.phase);
    if (presentation.status === "in_progress" && presentation.summary) lines.push(presentation.summary);
  }

  const collapsed = collapseConsecutiveSteps(presentation.steps);
  lines.push(...collapsed.steps.slice(-MAX_VISIBLE_STEPS).reverse().map(renderStep));
  const hidden = presentation.droppedSteps
    + collapsed.collapsedCount
    + Math.max(0, collapsed.steps.length - MAX_VISIBLE_STEPS);
  if (hidden > 0) lines.push(`${hidden} earlier step${hidden === 1 ? "" : "s"}`);
  return lines;
}

function collapseConsecutiveSteps(steps: ExternalRunStep[]): {
  steps: ExternalRunStep[];
  collapsedCount: number;
} {
  const collapsed: ExternalRunStep[] = [];
  let collapsedCount = 0;
  for (const step of steps) {
    const previous = collapsed.at(-1);
    if (previous && previous.label === step.label && previous.detail === step.detail) {
      collapsed[collapsed.length - 1] = step;
      collapsedCount += 1;
    } else {
      collapsed.push(step);
    }
  }
  return { steps: collapsed, collapsedCount };
}

function renderStep(step: ExternalRunStep): string {
  const marker = step.status === "done" ? "✓" : step.status === "error" ? "✗" : "●";
  const detail = step.detail ? ` — ${step.detail}` : "";
  return `${marker} ${step.label}${detail}`;
}

function briefStatus(presentation: ExternalRunPresentation): string {
  if (presentation.queuedPosition !== undefined) return `In queue (position ${presentation.queuedPosition})`;
  if (presentation.status === "in_progress") return presentation.phase;
  return presentation.summary ?? presentation.status;
}

function richText(lines: string[]): Record<string, unknown> {
  return {
    type: "rich_text",
    elements: lines.map((text) => ({
      type: "rich_text_section",
      elements: [{ type: "text", text }],
    })),
  };
}

export function renderSlackNotification(
  intent: ExternalNotificationIntent,
  sessionUrl: string,
): SlackMessageContent[] {
  const openSession = `Open session: ${sessionUrl}`;
  switch (intent.type) {
    case "agent_response": {
      const markdown = intent.text.replace(/\r\n?/g, "\n").trim();
      return splitSlackMarkdown(markdown).map((chunk) => ({
        text: markdownFallback(chunk),
        blocks: [{ type: "markdown", text: chunk }],
      }));
    }
    case "approval_requested":
      return [{ text: `Codevil needs plan approval:\n\n${boundedText(intent.plan)}\n\n${openSession}` }];
    case "question_asked":
      return [renderSlackQuestion(intent, sessionUrl)];
    case "run_failed":
      return [{ text: `Codevil could not complete the Agent Run: ${boundedText(intent.message)} ${openSession}` }];
  }
}

export function encodeSlackQuestionAction(input: {
  requestId: string;
  optionIndex?: number;
}): string | null {
  const value = JSON.stringify({
    v: 1,
    q: input.requestId,
    ...(input.optionIndex !== undefined ? { i: input.optionIndex } : {}),
  });
  return value.length <= MAX_SLACK_ACTION_VALUE_LENGTH ? value : null;
}

export function renderAnsweredSlackQuestion(input: {
  question: string;
  selectedLabels: string[];
  answeredByText: string;
}): SlackMessageContent {
  const answer = input.selectedLabels.join(", ");
  return {
    text: `${boundedText(input.question)} Answered: ${boundedText(answer)} by ${boundedText(input.answeredByText)}`,
    blocks: [
      {
        type: "markdown",
        text: `**${input.question}**\n\n✓ ${answer}`,
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Answered by ${input.answeredByText}` }],
      },
    ],
  };
}

function renderSlackQuestion(
  intent: Extract<ExternalNotificationIntent, { type: "question_asked" }>,
  sessionUrl: string,
): SlackMessageContent {
  const actions = questionActions(intent, sessionUrl);
  const blocks = [
    { type: "markdown", text: questionMarkdown(intent, !actions.optionsShownInControls) },
    actions.block,
  ];
  return {
    text: `Codevil needs input: ${boundedText(intent.question)} Open session: ${sessionUrl}`,
    blocks,
  };
}

function questionMarkdown(
  intent: Extract<ExternalNotificationIntent, { type: "question_asked" }>,
  includeOptions: boolean,
): string {
  const sections = ["## Codevil needs input", intent.question];
  if (intent.context) sections.push(`> ${intent.context}`);
  if (includeOptions && intent.options?.length) {
    sections.push(intent.options.map((option, index) => {
      const detail = option.detail ? ` — ${option.detail}` : "";
      return `${index + 1}. **${option.label}**${detail}`;
    }).join("\n"));
  }
  return sections.join("\n\n");
}

function questionActions(
  intent: Extract<ExternalNotificationIntent, { type: "question_asked" }>,
  sessionUrl: string,
): {
  block: Record<string, unknown> & { type: string };
  optionsShownInControls: boolean;
} {
  const options = intent.options ?? [];
  const submitValue = encodeSlackQuestionAction({ requestId: intent.requestId });
  const elements: Array<Record<string, unknown>> = [];

  if (submitValue && options.length > 0 && options.length <= 100) {
    if (!intent.allowMultiple && options.length <= 5) {
      for (const [index, option] of options.entries()) {
        const value = encodeSlackQuestionAction({ requestId: intent.requestId, optionIndex: index });
        if (!value) {
          elements.length = 0;
          break;
        }
        elements.push({
          type: "button",
          action_id: `codevil_question_answer_${index}`,
          text: plainText(truncate(option.label, MAX_SLACK_OPTION_TEXT_LENGTH)),
          value,
        });
      }
    } else {
      elements.push(questionSelectionElement(options, intent.allowMultiple));
      elements.push({
        type: "button",
        action_id: "codevil_question_submit",
        text: plainText("Submit answer"),
        style: "primary",
        value: submitValue,
      });
    }
  }

  const optionsShownInControls = elements.length > 0;
  elements.push(openSessionButton(sessionUrl));
  return {
    block: {
      type: "actions",
      block_id: "codevil_question_controls",
      elements,
    },
    optionsShownInControls,
  };
}

function questionSelectionElement(options: QuestionOption[], allowMultiple: boolean): Record<string, unknown> {
  const renderedOptions = options.map((option, index) => ({
    text: plainText(truncate(option.label, MAX_SLACK_OPTION_TEXT_LENGTH)),
    value: String(index),
    ...(option.detail
      ? { description: plainText(truncate(option.detail, MAX_SLACK_OPTION_TEXT_LENGTH)) }
      : {}),
  }));

  if (allowMultiple && options.length <= 10) {
    return {
      type: "checkboxes",
      action_id: "codevil_question_select",
      options: renderedOptions,
    };
  }
  return {
    type: allowMultiple ? "multi_static_select" : "static_select",
    action_id: "codevil_question_select",
    placeholder: plainText(allowMultiple ? "Select answers" : "Select an answer"),
    options: renderedOptions,
  };
}

function openSessionButton(sessionUrl: string): Record<string, unknown> {
  return {
    type: "button",
    action_id: "codevil_open_session",
    text: plainText("Open session"),
    url: sessionUrl,
  };
}

function plainText(text: string): { type: "plain_text"; text: string; emoji: true } {
  return { type: "plain_text", text, emoji: true };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength - 1).trimEnd() + "…";
}

function splitSlackMarkdown(markdown: string): string[] {
  if (markdown.length <= MAX_SLACK_MARKDOWN_CHARS) return [markdown];

  const lines = markdown.split("\n").flatMap((line) => {
    if (line.length <= 10_000) return [line];
    const parts: string[] = [];
    for (let offset = 0; offset < line.length; offset += 10_000) {
      parts.push(line.slice(offset, offset + 10_000));
    }
    return parts;
  });
  const chunks: string[] = [];
  let current = "";
  let openFence: string | null = null;

  const pushCurrent = (): void => {
    if (!current) return;
    const closed = openFence ? `${current}\n\`\`\`` : current;
    chunks.push(closed);
    current = openFence ?? "";
  };

  for (const line of lines) {
    const separator = current ? "\n" : "";
    const reserveForFenceClose = openFence ? 4 : 0;
    if (current && current.length + separator.length + line.length + reserveForFenceClose > MAX_SLACK_MARKDOWN_CHARS) {
      pushCurrent();
    }

    current += `${current ? "\n" : ""}${line}`;
    if (/^\s*```/.test(line)) {
      openFence = openFence ? null : line.trim();
    }
  }

  if (current) {
    chunks.push(openFence ? `${current}\n\`\`\`` : current);
  }
  return chunks;
}

function boundedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}

function markdownFallback(value: string): string {
  const lines = value.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(trimmed)) return [];
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length >= 2) return [`${cells[0]}: ${cells.slice(1).join("; ")};`];
    }
    return [trimmed.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^[-*+]\s+/, "")];
  });

  return lines
    .join(" ")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/```[^\s]*|```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim()
    .slice(0, MAX_EXTERNAL_TEXT_LENGTH);
}
