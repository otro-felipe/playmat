# Recorded decisions and inferred replay opportunities

Date 2026-11-19

Status Accepted

## Context

The replay records public moves and periodic board positions. Several decisions occur within one position, especially opening choices and resolving Thoughtseize. A player can also pass a useful opportunity without producing a public move. The review needs to distinguish the act that occurred from a strategic inference about a window.

## Decision

Record the committing seat, protected choices and a preceding frame when the engine observes a relevant opening, selection or pass. Capture context only for replays eligible for completed-match review. Preserve existing archive cursors and verify older hand context against the event order. A reviewed opportunity absent from the engine decisions can be anchored to an observed priority window with the acting seat, card reference and closing event. The saved annotation identifies it as inferred.

## Consequences

Protected opening hands and legal options use the existing authorized replay projections. Legacy recordings can support a grade when independent observations establish the relevant facts. A rejected opening hand absent from all frames remains unavailable. The engine records eligible pass opportunities, while the strategic review determines their significance in the matchup.

Affected specification [Post-match replay and strategic review](../specs/playtesting/postmatch-review.md), PM-REVIEW-CAPTURE-3, PM-REVIEW-CAPTURE-4, PM-REVIEW-API-9 and PM-REVIEW-API-10. Related [Recorded hands in completed private tests](2026-11-19-post-match-hand-visibility.md).
