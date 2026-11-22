import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cancelPlayerReservation, inspectPlayerReservation } from '../src/player-seats.mjs';

test('reconcile an uncertain setup without releasing a table that may already be live', async () => {
  const playerId=randomUUID(), reservationId=randomUUID(), tableId=randomUUID();
  const actor={playerId,reservationId,ownsReservation:true,connectionId:randomUUID()};
  const log=[];
  const product=async (op,args)=>{ assert.equal(op,'player_reservation'); log.push(args.operation); };
  let waiting=['candidate'], state='waiting';
  const engine=()=>({ ownedWaitingTables:async()=>waiting,
    waitingProfileTable:async()=>state, removeWaitingProfileTable:async()=>{log.push('remove');state='missing';} });
  const cancel=args=>cancelPlayerReservation(actor,args,product,engine);
  assert.equal((await inspectPlayerReservation(actor,engine)).phase,'reserved');
  await cancel({reservationId});
  assert.deepEqual(log.splice(0),['cancel'],'No engine call may have been sent before begin.');
  actor.reservationStarted=true;
  waiting=[];
  assert.deepEqual((await inspectPlayerReservation(actor,engine)).waitingTableIds,[]);
  await assert.rejects(cancel({reservationId}),e=>e.code==='reservation_uncertain');
  assert.deepEqual(log,[]);
  waiting=[tableId];
  await cancel({reservationId,tableId});
  assert.deepEqual(log.splice(0),['bind','lock_cancel','remove','cancel']);
  actor.activeTableId=tableId;
  state='occupied';
  await assert.rejects(cancel({reservationId,tableId}),e=>e.code==='table_not_cancellable');
  await assert.rejects(cancel({reservationId:randomUUID(),tableId}),e=>e.code==='reservation_changed');
  assert.deepEqual(log,[]);
  actor.reservationCancelPending=true;
  state='missing';
  await cancel({reservationId,tableId});
  assert.deepEqual(log,['cancel'],'Retry after removal acknowledgement was lost without a second removal.');
});
