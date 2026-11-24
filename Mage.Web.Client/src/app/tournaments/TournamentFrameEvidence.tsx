import { useT } from '../i18n';

export type TournamentBoardFact =
  | {kind:'target'; source:string; target:string; ability?:boolean}
  | {kind:'attached'; source:string; target:string}
  | {kind:'attacker'; source:string; target:string; power?:string}
  | {kind:'damage'; source:string; target:string; amount:number}
  | {kind:'exiled'; target:string};

export function TournamentFrameEvidence({facts}: {facts?: readonly TournamentBoardFact[]}) {
  const t = useT();
  if (!facts?.length) return null;
  function describe(fact: TournamentBoardFact) {
    switch (fact.kind) {
      case 'damage':
        return t('spectate.fact.damage', {source: fact.source, target: fact.target, amount: fact.amount});
      case 'exiled':
        return t('spectate.fact.exiled', {target: fact.target});
      case 'attacker': {
        const declaration = t('spectate.fact.attacker', {source: fact.source, target: fact.target});
        return fact.power ? declaration + ' ' + t('spectate.fact.power', {power: fact.power}) : declaration;
      }
      case 'target':
        return t(fact.ability ? 'spectate.fact.abilityTarget' : 'spectate.fact.target', {source: fact.source, target: fact.target});
      case 'attached':
        return t('spectate.fact.attached', {source: fact.source, target: fact.target});
    }
  }
  return <details>
    <summary>{t('spectate.frameFacts')}</summary>
    <ul>{facts.map((fact, i) => <li key={i}>{describe(fact)}</li>)}</ul>
  </details>;
}
