import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { AppShell } from './AppShell';
import { queryClient } from './queries';
import { openImport, useImportSheet } from './stores/importSheet';
import { useSession } from './stores/session';
import { Dialog } from './ui/Dialog';

vi.mock('./playtesting', () => ({ PRIVATE_PLAYTESTING: true }));
vi.mock('./whatsNew', () => ({
  pendingReleaseNotes: async () => ({ version: '1.2.3', sections: [] }),
}));
vi.mock('./WhatsNewDialog', () => ({
  WhatsNewDialog: () => <Dialog open onOpenChange={() => undefined} title="What's new">Release notes</Dialog>,
}));
vi.mock('./career/WelcomeDialog', () => ({
  default: () => <Dialog open onOpenChange={() => undefined} title="Welcome to Career">Progression</Dialog>,
}));
vi.mock('./support/SupportNotice', () => ({
  SupportNotice: () => <Dialog open onOpenChange={() => undefined} title="Support notice">Thank you</Dialog>,
}));

afterEach(() => {
  queryClient.clear();
  useSession.setState(useSession.getInitialState());
  useImportSheet.setState(useImportSheet.getInitialState());
});

test('[PM-AC-05] the private beta can open deck import without unrelated introductory dialogs', async () => {
  queryClient.setQueryData(['serverInfo'], { accounts: true, career: true, support: true });
  useSession.setState({ phase: 'signedIn', userName: 'Fixture', connection: 'open' });
  const page = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/decks']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/decks" element={<button onClick={() => openImport()}>Import</button>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(async () => {
    page.getByRole('button', { name: 'Import' }).click();
    await Promise.all([
      import('./WhatsNewDialog'),
      import('./career/WelcomeDialog'),
      import('./support/SupportNotice'),
      import('./decks/import/ImportSheet'),
    ]);
  });
  await page.findByRole('dialog', { name: 'Import a deck' });
  expect(page.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
});
