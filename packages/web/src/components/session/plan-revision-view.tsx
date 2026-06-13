import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExtraProps } from "react-markdown";
import { useSessionStore } from "@/stores/session-store";
import { useAnnotationHighlighter } from "@/hooks/use-annotation-highlighter";
import type { PendingSelection } from "@/hooks/use-annotation-highlighter";
import { AnnotationComposer } from "./annotation-composer";
import { blockIdForNode } from "@/lib/block-id";
import type { HastNodeWithPosition } from "@/lib/block-id";

// Re-export so existing imports from this module continue to work.
export { blockIdForNode };

function makeBlockComponent<T extends keyof React.JSX.IntrinsicElements>(Tag: T) {
  return function BlockComponent(props: React.JSX.IntrinsicElements[T] & ExtraProps) {
    const { node, ...rest } = props;
    const hastNode = node as HastNodeWithPosition | undefined;
    const blockId = hastNode ? blockIdForNode(hastNode) : null;
    const sourceLine = hastNode?.position?.start.line;

    const dataAttrs: Record<string, string | number | undefined> = {};
    if (blockId !== null) dataAttrs["data-block-id"] = blockId;
    if (sourceLine !== undefined) dataAttrs["data-source-line"] = sourceLine;

    const ElementTag = Tag as React.ElementType;
    return <ElementTag {...rest} {...dataAttrs} />;
  };
}

const blockComponents = {
  p: makeBlockComponent("p"),
  h1: makeBlockComponent("h1"),
  h2: makeBlockComponent("h2"),
  h3: makeBlockComponent("h3"),
  h4: makeBlockComponent("h4"),
  h5: makeBlockComponent("h5"),
  h6: makeBlockComponent("h6"),
  li: makeBlockComponent("li"),
  blockquote: makeBlockComponent("blockquote"),
  pre: makeBlockComponent("pre"),
  table: makeBlockComponent("table"),
};

export function PlanRevisionView() {
  const planRevision = useSessionStore((state) => state.planRevision);
  const createAnnotation = useSessionStore((state) => state.createAnnotation);
  const rootRef = useRef<HTMLDivElement>(null);

  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);

  const { removeHighlight } = useAnnotationHighlighter({
    rootRef,
    planRevision,
    onPendingSelection: setPendingSelection,
  });

  if (!planRevision || !planRevision.markdown) {
    return null;
  }

  function handleComposerSubmit(comment: string) {
    if (!pendingSelection) return;
    createAnnotation(pendingSelection.anchor, comment);
    // Leave the transient <mark> in place — Task 4 will replace it with the
    // server-confirmed annotation highlight.
    setPendingSelection(null);
  }

  function handleComposerCancel() {
    if (pendingSelection) {
      removeHighlight(pendingSelection.highlightId);
    }
    setPendingSelection(null);
  }

  return (
    <div className="plan-revision-view" style={{ position: "relative" }}>
      <div ref={rootRef} className="plan-revision-view-content">
        <Markdown remarkPlugins={[remarkGfm]} components={blockComponents}>
          {planRevision.markdown}
        </Markdown>
      </div>

      {pendingSelection && (
        <AnnotationComposer
          onSubmit={handleComposerSubmit}
          onCancel={handleComposerCancel}
        />
      )}
    </div>
  );
}
