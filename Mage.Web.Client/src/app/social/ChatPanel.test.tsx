import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

test('lobby, table and event composer preserve 500 raw characters, reject 501 and keep a rejected draft', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('fixture rejected')).mockResolvedValueOnce(undefined);
  const page = render(<MemoryRouter><ChatPanel lines={[]} ready onSend={send} label="Fixture chat" /></MemoryRouter>);
  const input = page.getByRole('textbox') as HTMLTextAreaElement;
  const prefix = '  &amp; 🐾\n\n';
  const body = prefix + 'x'.repeat(498 - Array.from(prefix).length) + '🦊 ';
  const submit = () => fireEvent.click(page.getByRole('button', {name: 'Send'}));
  fireEvent.change(input,{target:{value:body+'!'}});
  submit();
  expect(send).not.toHaveBeenCalled();
  expect(page.getByRole('alert').textContent).toContain('500');
  expect(input.value).toBe(body+'!');
  fireEvent.change(input,{target:{value:body}});
  submit();
  await waitFor(()=>expect(page.getByRole('alert').textContent).toContain('Could not send'));
  expect(input.value).toBe(body);
  submit();
  await waitFor(()=>expect(input.value).toBe(''));
  expect(send.mock.calls).toEqual([[body],[body]]);
});
