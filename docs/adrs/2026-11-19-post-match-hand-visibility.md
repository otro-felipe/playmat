# Recorded hands in completed private tests

Date 2026-11-19

Status Accepted

## Context

Private MTG Eigen tables are used to test decks and review both players' decisions. Requiring separate opt-in at table creation and joining left participants with partial review, including when a best-of-three had finished and both hands were present in the archive.

## Decision

Record protected hand evidence by default in eligible private tests. Use match completion and verified participant identity as the authorization boundary. Waiting for the match to finish covers the time between games and sideboarding. An authenticated participant can inspect both recorded hands. The acting-seat analysis view still uses the evidence available to that seat at the decision.

## Alternatives considered

An opt-in at table setup or during replay would leave otherwise usable evidence dependent on a separate grant. Showing full hands in an ordinary shared replay would extend access beyond the match participants.

## Consequences

Historical archives expose the hand frames that were recorded when ownership can be verified. Missing frames cannot be reconstructed. The protected review and ordinary shared replay continue to use distinct projections. Submitted deck lists stay scoped to the viewing seat.

Affected specification [Post-match replay and strategic review](../specs/playtesting/postmatch-review.md), PM-REVIEW-PRIV-1 through PM-REVIEW-PRIV-4. Supersedes the earlier consent rules in that specification.
