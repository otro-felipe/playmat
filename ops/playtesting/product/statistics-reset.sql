-- Public statistics restart from zero on 2026-11-24 21:45 UTC. Every match that started
-- earlier leaves the statistics; its archive, replays and match history stay untouched.
-- Idempotent: the cutoff is fixed, so a restart never excludes a newer match.
INSERT INTO match_statistics_exclusions(match_id,reason,author)
SELECT id,'Reinicio de estadísticas del 24-11-2026','service-operator'
FROM matches WHERE started_at < 1795556700000
ON CONFLICT (match_id) DO NOTHING;
