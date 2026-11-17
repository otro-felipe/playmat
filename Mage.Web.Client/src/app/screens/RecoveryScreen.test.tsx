import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import { RecoveryScreen } from './RecoveryScreen';

const fixture = vi.hoisted(() => ({
  status: vi.fn(), join: vi.fn(),
  row: { matchId: '00000000-0000-4000-8000-000000000001', revision: 12, status: 'waiting', gameNumber: 2,
    phase: 'turn', turn: 7, message: 'Resume from the start of the last durably confirmed turn 7. Later decisions are discarded.' },
}));
vi.mock('../connection', () => ({ api: { recoveryStatus: fixture.status, recoveryJoin: fixture.join } }));
vi.mock('../stores/session', () => ({ useSession: (pick: (s: object) => unknown) => pick({ phase: 'signedIn', connection: 'open' }) }));
beforeEach(() => { fixture.status.mockResolvedValue(fixture.row); fixture.join.mockResolvedValue(fixture.row); vi.clearAllMocks(); });
function mount() {
  return render(<MemoryRouter initialEntries={['/recover/' + fixture.row.matchId]}>
    <Routes><Route path="/recover/:matchId" element={<RecoveryScreen />} /></Routes>
  </MemoryRouter>);
}
test('shows the durable rollback boundary and requires explicit agreement before requesting recovery', async () => {
  const view = mount();
  await view.findByText(fixture.row.message);
  expect(fixture.join).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'I agree to this saved boundary' }));
  await waitFor(() => expect(fixture.join).toHaveBeenCalledWith(fixture.row.matchId, 12, true));
  await view.findByText('Agreement saved. Waiting for the other reserved participant.');
});
test('an unavailable checkpoint cannot present an agreement or reconnect action', async () => {
  fixture.status.mockResolvedValue({ ...fixture.row, status: 'unavailable', message: 'Different engine image required.' });
  const view = mount();
  await view.findByRole('alert');
  expect(view.queryByRole('button')).toBeNull();
  expect(fixture.join).not.toHaveBeenCalled();
});
