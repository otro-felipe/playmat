// @vitest-environment happy-dom
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Arrows } from './Arrows';
import { StageContext, DEFAULT_STAGE } from './stageContext';
import { stackTargetConnections } from './stackTargetArrows';
import { useMatchUi } from './matchUi';
import type { GameView } from '../../protocol/generated/views';

afterEach(() => { vi.unstubAllGlobals(); useMatchUi.getState().setStackFocus(null); });

describe('[READ-AC-004] persistent stack arrow layer', () => {
  test('draws every announced branch, including covered spells, with focus and removal independent of the old top-only input', () => {
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    const stage = document.createElement('div');
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1920, height: 1080 } as DOMRect);
    for (const [id, x, y] of [['fork', 1100, 500], ['burst', 1100, 550], ['doge', 500, 100], ['bear', 600, 300]] as const) {
      const anchor = document.createElement('span');
      anchor.dataset.objectId = id;
      if (id === 'fork' || id === 'burst') anchor.dataset.stackArrowOrigin = id;
      anchor.getBoundingClientRect = () => ({ left: x, top: y, width: 10, height: 10 } as DOMRect);
      stage.append(anchor);
    }
    const view: GameView = { stack: { fork: { id: 'fork', targets: ['doge', 'bear'] }, burst: { id: 'burst', targets: ['doge'] } }, players: [{ playerId: 'doge', battlefield: { bear: { name: 'Bear' } } }] };
    const props = { sourceId: null, targetIds: [], live: false, links: [], attacks: [], leads: new Map<string, string>() };
    const element = (focus: string | null, next = view) => <StageContext.Provider value={{ ...DEFAULT_STAGE, element: stage }}><Arrows {...props} stackTargets={stackTargetConnections(Object.values(next.stack ?? {}), next, focus, new Set(), null)} /></StageContext.Provider>;
    const { container, rerender } = render(element(null));
    expect(container.querySelectorAll('[data-stack-source]')).toHaveLength(3);
    const burst = container.querySelector('[data-stack-source="burst"]')!;
    expect(burst.getAttribute('data-emphasis')).toBe('waiting');
    const fork = container.querySelector('[data-stack-source="fork"][data-stack-target="doge"]')!;
    expect(burst.querySelector('path')!.getAttribute('d')).not.toBe(fork.querySelector('path')!.getAttribute('d'));
    act(() => rerender(element('burst')));
    expect(container.querySelector('[data-stack-source="burst"]')!.getAttribute('data-emphasis')).toBe('focused');
    expect(container.querySelectorAll('[data-stack-source]')).toHaveLength(3);
    rerender(element(null, { ...view, stack: { burst: view.stack!.burst } }));
    expect(container.querySelectorAll('[data-stack-source]')).toHaveLength(1);
    expect(container.querySelector('[data-stack-source="fork"]')).toBeNull();
  });
});
