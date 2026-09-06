import type { ExternalNotificationIntent } from "../notification-intents.js";
import type { SlackMessageContent } from "./client.js";
import type { QuestionOption } from "@codevil/shared";

const MAX_EXTERNAL_TEXT_LENGTH = 500;
const MAX_SLACK_MARKDOWN_CHARS = 11_500;
const MAX_SLACK_ACTION_VALUE_LENGTH = 2_000;
const MAX_SLACK_OPTION_TEXT_LENGTH = 75;
const MAX_SLACK_MODAL_TEXT_LENGTH = 1_000;

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

export function renderSlackFreeformAnswerModal(input: {
  question: string;
  context?: string;
  privateMetadata: string;
}): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: markdownText(`*Question*\n${truncate(input.question, MAX_SLACK_MODAL_TEXT_LENGTH)}`),
    },
  ];
  if (input.context) {
    blocks.push({
      type: "section",
      text: markdownText(`*Context*\n${truncate(input.context, MAX_SLACK_MODAL_TEXT_LENGTH)}`),
    });
  }
  blocks.push({
    type: "input",
    block_id: "codevil_question_freeform_input",
    label: plainText("Answer"),
    element: {
      type: "plain_text_input",
      action_id: "codevil_question_freeform_value",
      multiline: true,
    },
  });
  return {
    type: "modal",
    callback_id: "codevil_question_freeform",
    private_metadata: input.privateMetadata,
    title: plainText("Answer Codevil"),
    submit: plainText("Send answer"),
    close: plainText("Cancel"),
    blocks,
  };
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
        ...(!intent.allowFreeform ? { style: "primary" } : {}),
        value: submitValue,
      });
    }
  }

  const optionsShownInControls = elements.length > 0;
  if (intent.allowFreeform && submitValue) {
    elements.push({
      type: "button",
      action_id: "codevil_question_open_freeform",
      text: plainText("Write answer"),
      style: "primary",
      value: submitValue,
    });
  }
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

function markdownText(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
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
