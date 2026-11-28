import { fireEvent, render, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { registerMessages } from '../i18n';
import replayMessages from '../i18n/en/replay';
import { LineReasoning } from './ReplayLineReasoning';

registerMessages(replayMessages);

test('[PM-LINE-REPLAY-2] renders archived Markdown without activating untrusted content', () => {
  const page = render(<LineReasoning onPlay={vi.fn()} lines={[
    {
      cursor: 3, commandId: 'attack', seatId: 'one', actor: 'Agent',
      text: [
        '**Choice:** attack with [the *flyer*](card://Stormwing%20Entity).',
        '',
        '1. Preserve the ground blocker.',
        '2. Leave mana open.',
        '',
        '<img src="https://example.invalid/raw" alt="Raw HTML">',
        '',
        '[Unsafe](javascript:alert%281%29) [External](https://example.invalid/link) ![Remote](https://example.invalid/image)',
      ].join('\n'),
    },
    { cursor: 4, commandId: 'pass', seatId: 'one', actor: 'Agent', text: 'An older plain line.' },
  ]} />);

  const opener = page.getByRole('button', { name: 'See the reasoning of Agent' });
  fireEvent.click(opener);
  const dialog = page.getByRole('dialog');
  const note = within(dialog);
  expect(note.getByText('Choice:').tagName).toBe('STRONG');
  expect(note.getAllByRole('listitem')).toHaveLength(2);
  expect(note.getByRole('button', { name: /the flyer/ })).toBeTruthy();
  expect(note.getByText('An older plain line.')).toBeTruthy();
  expect(dialog.textContent).toContain('Unsafe External Remote');
  expect(note.queryByRole('link')).toBeNull();
  expect(dialog.querySelector('img, a, script')).toBeNull();

  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(page.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
