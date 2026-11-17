// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DecisionIdleNotice } from './DecisionIdleNotice';
import { useSettings } from '../stores/settings';

let mono = 0;
beforeEach(() => {
  useSettings.getState().update({ locale: 'en' });
  mono = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const timing = { status: 'running', deadlineEpochMs: 1_000_000, sampledAtEpochMs: 100_000, remainingMillis: 900_000 };

test('a repeated sample and a skewed client wall clock never replenish response time', () => {
  const { rerender } = render(<DecisionIdleNotice timing={timing} active />);
  expect(screen.getByRole('timer').textContent).toBe('Decision idle: 15:00');
  act(() => { mono = 1000; vi.advanceTimersByTime(1000); });
  expect(screen.getByRole('timer').textContent).toBe('Decision idle: 14:59');
  vi.spyOn(Date, 'now').mockReturnValue(99_999_999_999);
  rerender(<DecisionIdleNotice timing={{ ...timing }} active />);
  act(() => { mono = 2000; vi.advanceTimersByTime(1000); });
  expect(screen.getByRole('timer').textContent).toBe('Decision idle: 14:58');
  expect(screen.getByRole('timer').getAttribute('aria-live')).toBe('off');
});

test('zero is an urgent deadline, while unknown and inactive views do not manufacture a countdown', () => {
  const { rerender } = render(<DecisionIdleNotice timing={{ ...timing, remainingMillis: 0 }} active />);
  expect(screen.getByRole('timer').textContent).toBe('Decision idle: 0:00');
  expect(screen.getByRole('status').textContent).toMatch(/Less than a minute/);
  rerender(<DecisionIdleNotice timing={{ ...timing, status: 'inactive' }} active />);
  expect(screen.queryByRole('timer')).toBeNull();
  rerender(<DecisionIdleNotice timing={undefined} active />);
  expect(screen.queryByRole('timer')).toBeNull();
});
