import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ReactNode } from "react";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
}

export function SplitPane({ left, right }: SplitPaneProps) {
  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1">
      <ResizablePanel defaultSize={50} minSize={30}>
        {left}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50} minSize={25}>
        {right}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
