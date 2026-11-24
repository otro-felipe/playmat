import { render, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { TournamentFrameEvidence } from './TournamentFrameEvidence';

test('declared attackers and targets stay distinct from actual damage and zone movement', () => {
  const page = render(<TournamentFrameEvidence facts={[
    {kind:'target',source:'Equipment',target:'Defender',ability:true},
    {kind:'attacker',source:'Attacker',target:'South',power:'25'},
    {kind:'damage',source:'Attacker',target:'South',amount:22},
    {kind:'exiled',target:'Defender'},
  ]} />);
  const list = within(page.container).getAllByRole('listitem', {hidden:true});
  expect(list.map(row => row.textContent)).toEqual([
    'The ability of Equipment on the stack targets Defender.', 'Attacker was declared as attacking South. Power in this frame is 25.',
    'Attacker dealt 22 damage to South.', 'Defender moved from the battlefield to exile.',
  ]);
});
