# Public action receipts alongside the authoritative board

Date: 2026-11-17
Status: Accepted for this implementation

## Context
Fast engine updates can put a spell on and off the stack before React renders it. Increasing an animation duration cannot preserve an already removed card. Delaying the whole game view would put targeting and priority controls on obsolete state, and would make real decision clocks misleading.

## Decision
Observe every delivered game-session store update and derive public action receipts in a separate bounded queue. Keep the actual board, stack, prompts, clocks and manual answers immediate. Label receipts as recent actions and make them noninteractive. Do not change engine rules or server-side priority passing.

Use a 900 ms presentation beat and retain at most eight receipts. Count overflow explicitly and refer to the log for the full public history. On reconnect, rollback or game end, discard receipts and establish a fresh baseline. Spectator receipts observe the already delayed session view, preserving broadcast delay.

Leave a full presentation beat before client auto-pass answers a priority with a nonempty stack, including pass-turn mode. Revalidate the current prompt, stack and settings at the time the timer fires. Empty-stack phase progression retains its existing cadence.

## Alternatives considered
Delaying the authoritative view was rejected because it could offer actions on stale objects. Longer CSS animations alone cannot preserve intermediate server updates. An unbounded queue can fall indefinitely behind a busy game. A bounded queue without overflow accounting would silently omit activity.

## Consequences and limits
Recent receipts can describe an object that has already left the real stack; the historical label is deliberate. This improves readability without increasing the time available under a priority clock. Server-side automatic priority passing cannot be slowed by this client change. The game-chat endpoint has no history replay, so disconnected intervals remain a known log gap.

Affected specification: `docs/specs/match/readable-actions.md` (`READ-REQ-003`). Supersedes: none.
