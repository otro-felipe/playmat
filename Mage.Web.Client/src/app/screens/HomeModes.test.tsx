import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { HomeModes } from './HomeModes';
import { defaultHomeMode } from './playModes';

vi.mock('../playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
afterEach(cleanup);

test('private play starts on MCP rival and gives all four opponents equal positions', () => {
  const select = vi.fn();
  const page = render(<HomeModes mode={defaultHomeMode} onChange={select} disabled={false} />);
  const modes = page.getAllByRole('radio');
  expect(modes.map(mode => mode.closest('label')?.textContent)).toEqual(['MCP rival', 'A friend', 'Practice', 'BOT']);
  expect(modes.map(mode => (mode as HTMLInputElement).checked)).toEqual([true, false, false, false]);
  fireEvent.click(modes[2]);
  expect(select).toHaveBeenCalledWith('practice');
});

test('a keyboard user moves between the four match modes with the arrow keys', async () => {
  function Choice() {
    const [mode, setMode] = useState(defaultHomeMode);
    return <HomeModes mode={mode} onChange={setMode} disabled={false} />;
  }
  const page = render(<Choice />);
  const user = userEvent.setup();
  const first = page.getByRole('radio', { name: 'MCP rival' });
  first.focus();
  await user.keyboard('{ArrowRight}');
  expect((page.getByRole('radio', { name: 'A friend' }) as HTMLInputElement).checked).toBe(true);
});
