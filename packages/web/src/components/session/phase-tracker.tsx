import { useSessionStore } from "@/stores/session-store";
import { Check } from "lucide-react";

export function PhaseTracker() {
  const { sessionPhase } = useSessionStore();

  const getStatus = (target: string, currentIndex: number) => {
    // Map backend states to our local tracker indices
    let activeIndex = -1;
    switch (sessionPhase) {
      case "initializing": activeIndex = 0; break; // Provision
      case "planning": activeIndex = 2; break; // Plan
      case "awaiting_approval": activeIndex = 2; break; // Plan done, waiting
      case "executing": activeIndex = 3; break; // Execute
      case "completed": activeIndex = 5; break; // All done
      case "verifying": activeIndex = 4; break; // Review
      case "failed": activeIndex = -1; break; // Failed state
    }

    if (sessionPhase === "awaiting_approval" && currentIndex === 2) {
       // Wait, if awaiting approval, plan phase is done, execution is pending.
       return "done";
    }

    if (currentIndex < activeIndex) return "done";
    if (currentIndex === activeIndex) return "active";
    return "pending";
  };

  const phases = [
    { id: 'provision', label: 'Provision', time: '0:08', index: 0 },
    { id: 'setup', label: 'Setup', time: '1:12', index: 1 },
    { id: 'plan', label: 'Plan', time: '2:34', index: 2 },
    { id: 'execute', label: 'Execute', time: '—', index: 3 },
    { id: 'review', label: 'Review', time: '—', index: 4 }
  ];

  return (
    <div className="phases">
      {phases.map((phase, idx) => {
        const status = getStatus(phase.id, phase.index);
        let phaseClass = "phase";
        if (status === "done") phaseClass += " phase-done";
        if (status === "active") phaseClass += " phase-active pulse";
        if (status === "pending") phaseClass += " phase-pending";

        return (
          <div className={phaseClass} key={phase.id}>
            <div className="phase-rail">
              <div className="phase-bullet">
                {status === "done" && <Check size={10} strokeWidth={3} />}
                {status === "active" && <div className="phase-bullet-inner"></div>}
              </div>
              {idx < phases.length - 1 && <div className="phase-line"></div>}
            </div>
            <div className="phase-body">
              <span className="phase-label">{phase.label}</span>
              <span className="phase-meta">{phase.time}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
