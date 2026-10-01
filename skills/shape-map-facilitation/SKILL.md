---
name: shape-map-facilitation
description: Clarify human notes and proposed changes on a Shape map into an approved, implementable product decision. Use with an AI discussion export or ambiguous feature intent; do not interview a user whose request is already clear.
---

# Shape map facilitation

Use the user's installed **기획문답 / decision-interview** skill when available.
This portable workflow preserves its intent for other agents.

1. Read the referenced canonical map, relevant feature IDs, human notes, proposed
   changes, and the corresponding repository evidence. Resolve factual questions
   from that evidence before asking the user. Keep source facts, proposals, and
   uncertain assumptions distinct.
2. Restate the problem, purpose, and observable success criteria briefly. Ask only
   about missing intent, priorities, or consequential tradeoffs. Respect decisions
   the user already made; do not request the same approval again.
3. When a real choice remains, offer approximately three viable alternatives with
   concise tradeoffs and one recommendation with reasons. Ask the dependency that
   changes later decisions first. Continue independent work while awaiting answers.
4. Present a concrete final proposal centered on why and what: affected IDs,
   desired experience, success criteria, and essential constraints. Avoid prescribing
   implementation steps or copying the full graph into the request.
5. If execution is already authorized and criteria are clear, implement and verify.
   Otherwise obtain approval for the final proposal, then actually implement it.
   Exporting a prompt, writing a plan, or updating the map alone is not completion.
6. Update the map with the resulting behavior and relevant evidence. Preserve stable
   IDs and unrelated work. Record actual completed changes as a turn; mark human
   review only after the user's explicit confirmation of the current behavior.

Use short, plain Korean for a Korean-speaking user. Ask a small, self-contained
question rather than a long questionnaire. If intent is clear, proceed directly.
