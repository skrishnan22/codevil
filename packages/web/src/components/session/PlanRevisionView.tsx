import { useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ExtraProps } from "react-markdown";
import { useSessionStore } from "@/stores/session-store";

/**
 * Minimal structural type for the hast node position we need.
 * This avoids a direct `import from 'hast'` which isn't resolvable in
 * this package without adding @types/hast as a devDependency.
 */
interface HastPosition {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface HastNodeWithPosition {
  position?: HastPosition | undefined;
}

/**
 * Derive a stable, deterministic block identifier from the source line number.
 * The same frozen markdown always produces the same id on every client because
 * the id is derived solely from the source line.
 */
export function blockIdForLine(line: number): string {
  return `block-L${line}`;
}

/**
 * Derive a stable block id from a hast-like node with an optional position.
 * Returns null when position data is absent (generated nodes).
 */
export function blockIdForNode(node: HastNodeWithPosition): string | null {
  if (!node.position) return null;
  return blockIdForLine(node.position.start.line);
}

type BlockProps = React.HTMLAttributes<HTMLElement> & ExtraProps;

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

// Suppress the unused variable warning — BlockProps is used as documentation
void (undefined as unknown as BlockProps);

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
