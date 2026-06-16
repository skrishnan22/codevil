---
name: grill-with-docs
description: Challenge a plan against repository docs and domain terminology before implementation.
---

Use this skill when the user asks to grill a plan, review assumptions, or check a proposed direction against existing docs.

Read the relevant repository docs first. Look for terminology mismatches, missing constraints, and decisions that need human judgement. When the plan depends on a choice the room must make, use the `ask_question` tool with concise options and enough context for the assigned responder to decide.

Return the useful pressure only:
- strongest objections or risks
- concrete edits to the plan
- open questions that still block implementation
