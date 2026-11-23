import { useEffect, useState } from 'react';

export function Countdown({ at, expired }: { at: number; expired: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return (
    <time dateTime={new Date(at).toISOString()}>
      {seconds ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : expired}
    </time>
  );
}
