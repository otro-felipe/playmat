import { Brain, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { LineExplanationMarkdown } from '../ui/LineExplanationMarkdown';
import { usePlayerNames } from '../ui/usePlayerIdentity';
import { decisionPresentation, replayName } from './decisionPresentation';
import { ReviewRating } from './ReplayDecision';
import type { ReplayLine, ReviewMoment } from './reviewData';
import styles from './ReplayLineReasoning.module.css';

export type ShownLine = ReplayLine & { text: string };

const GAP = 8;
const EDGE = 12;
const WIDTH = 400;

/** Where the note opens: under the seat, or over it when the seat sits in the lower half of the window. */
function placement(trigger: HTMLElement): CSSProperties {
  const box = trigger.getBoundingClientRect();
  const left = Math.max(EDGE, Math.min(box.left, window.innerWidth - Math.min(WIDTH, window.innerWidth - 2 * EDGE) - EDGE));
  return box.top + box.height / 2 > window.innerHeight / 2
    ? { left, bottom: window.innerHeight - box.top + GAP, maxHeight: box.top - GAP - EDGE }
    : { left, top: box.bottom + GAP, maxHeight: window.innerHeight - box.bottom - GAP - EDGE };
}

/**
 * The brain on an agent's seat: the line it explained for this moment of the replay and the plays it sent with it.
 * A play jumps the replay to that decision.
 */
export function LineReasoning({ lines, onPlay }: { lines: readonly ShownLine[]; onPlay: (moment: ReviewMoment) => void }) {
  const t = useT();
  const formatName = usePlayerNames();
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const id = useId();
  const name = replayName(lines[0]?.actor ?? '', t, formatName);
  const open = position !== null;

  useLayoutEffect(() => {
    if (open) note.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(null);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!note.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (!lines.length) return null;
  const label = t('replay.lineReasoningOpen', { name });
  return (
    <>
      <button ref={trigger} type="button" className={styles.trigger} aria-label={label} title={label}
        aria-expanded={open} aria-controls={open ? id : undefined} data-replay-step-focus
        onClick={(event) => {
          event.stopPropagation();
          setPosition(open ? null : placement(event.currentTarget));
        }}>
        <Brain size={20} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={note} id={id} role="dialog" aria-label={t('replay.lineReasoning', { name })} tabIndex={-1}
          className={styles.note} style={position}
          onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <header className={styles.head}>
            <Brain size={18} aria-hidden="true" />
            <strong>{t('replay.lineReasoning', { name })}</strong>
            <button type="button" className={styles.close} aria-label={t('ui.close')} onClick={() => {
              setPosition(null);
              trigger.current?.focus();
            }}><X size={16} aria-hidden="true" /></button>
          </header>
          {lines.map((line) => (
            <section key={line.cursor} className={styles.line}>
              <LineExplanationMarkdown text={line.text} />
              {!!line.plays?.length && (
                <>
                  <h4>{t('replay.linePlays')}</h4>
                  <ol className={styles.plays}>
                    {line.plays.map((play) => {
                      const title = decisionPresentation(play, t, formatName).fullTitle;
                      return (
                        <li key={play.cursor}>
                          <button type="button" data-replay-step-focus onClick={() => {
                            setPosition(null);
                            onPlay(play);
                          }}>
                            {play.category && <ReviewRating category={play.category} />}
                            <span>{title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
            </section>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
