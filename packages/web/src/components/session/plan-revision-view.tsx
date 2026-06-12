import { useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExtraProps } from "react-markdown";
import { useSessionStore } from "@/stores/session-store";

/**
 * Minimal structural type for the hast node position we need.
 * This avoids a direct `import from 'hast'` which isn't resolvable in
 * this package without adding @types/hast as a devDependency.
 *
 * `offset` mirrors the optional field in the unist `Point` spec
 * (0-indexed character offset from the start of the document).
 */
interface HastPoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface HastPosition {
  start: HastPoint;
  end: HastPoint;
}

interface HastNodeWithPosition {
  position?: HastPosition | undefined;
}

/**
 * Derive a stable, deterministic block identifier from a hast-like node.
 *
 * Strategy (in order of preference):
 *  1. If the position carries character `offset` values, use
 *     `block-{start.offset}-{end.offset}`.  This is unique for every
 *     distinct source span even when two nodes share the same start line
 *     (e.g. a loose-list `li` and its child `p`).
 *  2. Otherwise fall back to `block-{sl}:{sc}-{el}:{ec}` using line +
 *     column, which is still unique per source span.
 *  3. Returns null when position data is absent (generated / synthetic
 *     nodes) — callers must handle null gracefully.
 *
 * Determinism: the id is derived solely from the frozen source span, so
 * the same markdown always produces the same ids on every client.
 */
export function blockIdForNode(node: HastNodeWithPosition): string | null {
  if (!node.position) return null;
  const { start, end } = node.position;
  if (start.offset !== undefined && end.offset !== undefined) {
    return `block-${start.offset}-${end.offset}`;
  }
  return `block-${start.line}:${start.column}-${end.line}:${end.column}`;
}

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
  const rootRef = useRef<HTMLDivElement>(null);

  if (!planRevision || !planRevision.markdown) {
    return null;
  }

  return (
    <div ref={rootRef} className="plan-revision-view">
      <Markdown remarkPlugins={[remarkGfm]} components={blockComponents}>
        {planRevision.markdown}
      </Markdown>
    </div>
  );
}
