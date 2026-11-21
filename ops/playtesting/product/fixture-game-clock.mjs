// A family runs its synthetic matches sequentially. Start its eight-minute clock
// when creating each game, so already-bound setup helpers see the current one.
export function fixtureGameClock(now = Date.now) {
  let deadline = 0
  return {
    forGame(create) {
      return (...args) => {
        deadline = now() + 480_000
        return create(...args)
      }
    },
    hasTime: () => now() < deadline,
    deadlineWithin: duration => Math.min(deadline, now() + duration),
  }
}
