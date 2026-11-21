import { PlayerLabel } from '../ui/PlayerLabel';
import { playerLabelText } from '../ui/playerIdentity';
import { BookOpen, Bot, Eye, Link2, Lock, MessageSquare, Plus, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../connection';
import { selectedDeckForPlay, toWire } from '../decks/deckModel';
import { refreshTables, useServerState, useTables } from '../queries';
import { useDecks } from '../stores/decks';
import { useDeckRoster } from '../stores/useDeckRoster';
import { useSession } from '../stores/session';
import { notify } from '../stores/toasts';
import type { TableView } from '../../protocol/generated/views';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { warmDeck } from '../ui/imageCache';
import { Zone } from '../ui/Zone';
import { formatMenu, formatRules, gameTypesFor, isCommanderFormat } from '../../core/decks/formats';
import { DEFAULT_ADVANCED, matchOptions, type TableAdvanced } from '../../core/game/tableSetup';
import { inviteLink } from '../../core/social/chatLine';
import { ChatPanel } from '../social/ChatPanel';
import { NameLevel } from '../social/LevelBadge';
import { useChatRoom } from '../social/useChatRoom';
import { useSocial } from '../stores/social';
import { joinTable } from './joinTable';
import { TableAdvancedFields } from './TableAdvancedFields';
import styles from './TablesScreen.module.css';
import { PUBLIC_ORIGIN } from '../brand';
import { createPlaytestingInvite, MCP_CHAT_MODES, PRIVATE_PLAYTESTING, type McpChatMode, type PlaytestingInvitationView } from '../playtesting';
import { usePlaytestingInvitation } from '../usePlaytestingInvitation';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/social';
import { McpConnectionDialog } from '../mcp/McpConnection';
import { mcpConnectionGuideHidden } from '../mcp/connectionGuide';

registerMessages(messages);

const FREEFORM = 'Constructed - Freeform';
const PRIVATE_FORMATS = ['Constructed - Standard', 'Constructed - Pioneer', 'Constructed - Modern'];
type HostOpponent = 'friend' | 'mcp' | 'ai';

const STATE_LABEL: Record<string, string> = {
  WAITING: 'Waiting for players',
  READY_TO_START: 'Ready to start',
  STARTING: 'Starting',
  DRAFTING: 'Drafting',
  CONSTRUCTING: 'Building decks',
  DUELING: 'Playing',
  SIDEBOARDING: 'Sideboarding',
  FINISHED: 'Finished',
};

/** Every table on the server: join one with your selected deck, watch a game, or host your own. */
export function TablesScreen() {
  const location = useLocation();
  const { data: tables = [], isLoading } = useTables();
  const userName = useSession((state) => state.userName);
  const roomId = useSession((state) => state.roomId);
  const decks = useDecks();
  const roster = useDeckRoster();
  const selectedDeck = roster.find((deck) => deck.id === decks.selectedId) ?? roster[0] ?? null;
  const hostEntry = location.state as { host?: string; opponent?: HostOpponent } | null;
  const [hostOpen, setHostOpen] = useState(!!hostEntry?.host);
  const [busyTable, setBusyTable] = useState<string | null>(null);
  // a passworded table asks for the password in a dialog before joining
  const [locked, setLocked] = useState<TableView | null>(null);
  const [tablePassword, setTablePassword] = useState('');

  useEffect(() => {
    if (!decks.loaded) void decks.refresh();
  }, [decks]);

  const games = tables.filter((table) => !table.isTournament);
  const mine = games.filter((table) => table.seats?.some((seat) => seat.playerName === userName) && table.tableState !== 'FINISHED');
  const open = games.filter((table) => table.tableState === 'WAITING' && !mine.includes(table));
  const running = games.filter((table) => table.tableState !== 'WAITING' && table.tableState !== 'FINISHED' && !mine.includes(table));

  async function join(table: TableView, password?: string) {
    if (!roomId || !table.tableId || !selectedDeck) return;
    if (PRIVATE_PLAYTESTING) {
      window.location.assign(`/join/${table.tableId}`);
      return;
    }
    if (table.passworded && password === undefined) {
      setTablePassword('');
      setLocked(table);
      return;
    }
    setBusyTable(table.tableId);
    try {
      await joinTable(table, selectedDeck.id, password ?? '');
    } catch (error) {
      notify("Couldn't join", error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusyTable(null);
    }
  }

  async function watch(table: TableView) {
    if (!roomId || !table.tableId) return;
    const ok = await api.roomWatchTable(roomId, table.tableId).catch(() => false);
    if (!ok) notify("Can't watch this game", 'The table does not allow spectators.', 'error');
  }

  return (
    <div className={styles.page}>
      {PRIVATE_PLAYTESTING && <p><Link to="/recover">Return to your saved private matches</Link></p>}
      <div className={styles.columns}>
        <Zone
          label="Open tables"
          aside={<Button size="sm" variant="print" icon={<Plus size={16} />} onClick={() => setHostOpen(true)}>Host a table</Button>}
          className={styles.list}
        >
          {mine.length > 0 && (
            <div className={styles.group}>
              <h3 className={styles.groupLabel}>Your tables</h3>
              {mine.map((table) => (
                <MyTable key={table.tableId} table={table} />
              ))}
            </div>
          )}
          <div className={styles.group}>
            {open.length === 0 && !isLoading && (
              <p className={styles.empty}>No one is waiting right now. Host a table and invite a friend, or play the AI from Home.</p>
            )}
            {open.map((table) => (
              <TableRow key={table.tableId} table={table}>
                <Button size="sm" busy={busyTable === table.tableId} disabled={!selectedDeck} onClick={() => void join(table)}>
                  Join
                </Button>
              </TableRow>
            ))}
          </div>
        </Zone>

        <Zone label="Games in progress" className={styles.list}>
          {running.length === 0 && <p className={styles.empty}>No games are being played.</p>}
          {running.map((table) => (
            <TableRow key={table.tableId} table={table}>
              {table.spectatorsAllowed && (
                <Button size="sm" variant="quiet" icon={<Eye size={16} />} onClick={() => void watch(table)}>Watch</Button>
              )}
            </TableRow>
          ))}
        </Zone>
      </div>
      <p className={styles.deckNote}>
        Joining with <strong>{selectedDeck?.name ?? 'no deck'}</strong>. Change it on the Play screen.
      </p>
      <Dialog
        open={!!locked}
        onOpenChange={(open) => !open && setLocked(null)}
        title="Table password"
        description={locked ? `${locked.tableName} is private. Ask the host for its password.` : undefined}
        width="sm"
        footer={(
          <>
            <Button variant="quiet" onClick={() => setLocked(null)}>Cancel</Button>
            <Button
              variant="decision"
              disabled={!tablePassword}
              onClick={() => {
                const table = locked!;
                setLocked(null);
                void join(table, tablePassword);
              }}
            >
              Join
            </Button>
          </>
        )}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked || !tablePassword) return;
            const table = locked;
            setLocked(null);
            void join(table, tablePassword);
          }}
        >
          <Field label="Password" type="password" value={tablePassword} onChange={(event) => setTablePassword(event.target.value)} autoFocus />
        </form>
      </Dialog>
      <HostDialog
        open={hostOpen}
        onOpenChange={setHostOpen}
        deckId={selectedDeck?.id ?? null}
        initialOpponent={PRIVATE_PLAYTESTING && hostEntry?.opponent === 'mcp' ? 'mcp' : 'friend'}
      />
    </div>
  );
}

function TableRow({ table, mcpInvite, children }: {
  table: TableView;
  mcpInvite?: PlaytestingInvitationView;
  children?: React.ReactNode;
}) {
  const mcpSeated = !!mcpInvite?.guestEngineName && table.seats?.some((seat) => seat.playerName === mcpInvite.guestEngineName);
  const seatStatus = mcpInvite && table.tableState === 'WAITING' ? 'Waiting for Rival MCP'
    : mcpSeated && table.tableState === 'READY_TO_START' ? 'Rival MCP ready'
      : STATE_LABEL[table.tableState ?? ''] ?? table.tableStateText;
  return (
    <article className={styles.row}>
      <div className={styles.rowMain}>
        <h3 className={styles.tableName}>
          {table.passworded && <Lock size={14} aria-label="Password required" />}
          {table.tableName}
        </h3>
        <p className={styles.tableMeta}>
          {table.gameType} · {(table.deckType ?? '').replace(/^Constructed - /, '')} · {(mcpInvite ? (table.controllerName ?? '').split(', ').slice(0, 1) : (table.controllerName ?? '').split(', ')).map((name, index) => (
            <span key={index}>{index > 0 && ', '}<PlayerLabel name={name} /></span>
          ))}
        </p>
      </div>
      <ul className={styles.seats} aria-label="Seats">
        {(table.seats ?? []).map((seat, index) => {
          const mcpSeat = mcpInvite && (!seat.playerName || seat.playerName === mcpInvite.guestEngineName);
          const owner = mcpSeat ? mcpInvite.guestOwnerName : undefined;
          const label = seat.playerName ? playerLabelText(seat.playerName, owner, mcpSeat || undefined) : (mcpSeat ? 'Rival MCP' : 'Open');
          return (
            <li key={index} className={seat.playerName ? styles.seatTaken : styles.seatOpen} title={seat.playerName ? label : 'Open seat'}>
              {mcpSeat || /^mcp_/i.test(seat.playerName ?? '') || (seat.playerType && seat.playerType !== 'HUMAN') ? <Bot size={14} aria-hidden="true" /> : <UserRound size={14} aria-hidden="true" />}
              <span className={styles.seatName}>{seat.playerName
                ? <PlayerLabel name={seat.playerName} displayName={owner} isMcp={mcpSeat || undefined} /> : label}</span>
              {!mcpSeat && seat.playerName && (!seat.playerType || seat.playerType === 'HUMAN') && <NameLevel name={seat.playerName} className={styles.seatLevel} />}
            </li>
          );
        })}
      </ul>
      <span className={mcpSeated && table.tableState === 'READY_TO_START' ? styles.mcpReady : styles.state} role={mcpInvite ? 'status' : undefined}>{seatStatus}</span>
      <div className={styles.rowActions}>{children}</div>
    </article>
  );
}

function MyTable({ table }: { table: TableView }) {
  const t = useT();
  const navigate = useNavigate();
  const roomId = useSession((state) => state.roomId);
  const userName = useSession((state) => state.userName);
  const [chatOpen, setChatOpen] = useState(false);
  // the server lists the controller first, then the other seated players: "host, guest"
  const isOwner = (table.controllerName ?? '').split(', ')[0] === userName;
  const ready = table.tableState === 'READY_TO_START';
  const { data: invitation } = usePlaytestingInvitation(table.tableId, table.tableState);
  const mcpInvite = invitation?.mode === 'mcp' ? invitation : undefined;
  async function copyInvite() {
    if (!table.tableId) return;
    const link = inviteLink(PRIVATE_PLAYTESTING ? window.location.origin : PUBLIC_ORIGIN, table.tableId);
    try {
      await navigator.clipboard.writeText(link);
      notify('Invite link copied', mcpInvite ? 'Share the private link with your MCP agent.'
        : invitation?.unlisted ? t('tableInvite.shareUnlisted')
          : !PRIVATE_PLAYTESTING && table.passworded ? 'Send it to a friend, with the table password.' : 'Send it to the invited player.');
    } catch {
      notify('Invite link', link);
    }
  }
  return (
    <>
      <TableRow table={table} mcpInvite={mcpInvite}>
        {table.tableState === 'WAITING' && (
          <Button size="sm" variant="quiet" icon={<Link2 size={16} />} onClick={() => void copyInvite()}>{mcpInvite ? t('mcpInvite.copyLink') : 'Invite'}</Button>
        )}
        {isOwner && mcpInvite && table.tableId && (table.tableState === 'WAITING' || ready) && (
          <IconButton label={t('mcpInvite.guide')} icon={<BookOpen size={16} />} onClick={() => navigate(`/join/${table.tableId}`)} />
        )}
        <IconButton label={chatOpen ? 'Hide table chat' : 'Table chat'} icon={<MessageSquare size={16} />} pressed={chatOpen} onClick={() => setChatOpen(!chatOpen)} />
        {isOwner && table.tableState !== 'DUELING' && (
          <>
            <Button size="sm" variant="quiet" onClick={() => roomId && table.tableId && void api.tableRemove(roomId, table.tableId).finally(refreshTables)}>Close</Button>
            <Button size="sm" variant={ready ? 'decision' : 'print'} disabled={!ready} onClick={() => roomId && table.tableId && void api.matchStart(roomId, table.tableId)}>
              Start
            </Button>
          </>
        )}
        {!isOwner && table.tableState === 'WAITING' && (
          <Button size="sm" variant="quiet" onClick={() => roomId && table.tableId && void api.roomLeaveTableOrTournament(roomId, table.tableId).finally(refreshTables)}>Leave</Button>
        )}
      </TableRow>
      {chatOpen && table.tableId && <TableChat tableId={table.tableId} />}
    </>
  );
}

/** The chat of a table you sit at: talk to the others while seats fill. */
function TableChat({ tableId }: { tableId: string }) {
  const chat = useChatRoom(tableId, (id) => api.chatFindByTable(id));
  return (
    <div className={styles.tableChat}>
      <ChatPanel label="Table chat" lines={chat.lines} ready={chat.ready} onSend={chat.send} empty="Say hi to the table. /help lists commands." />
    </div>
  );
}

function HostDialog({ open, onOpenChange, deckId, initialOpponent }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  deckId: string | null;
  initialOpponent: HostOpponent;
}) {
  const t = useT();
  const { data: serverState } = useServerState();
  const roomId = useSession((state) => state.roomId);
  const userName = useSession((state) => state.userName);
  const loadForPlay = useDecks((state) => state.loadForPlay);
  const loadList = useDecks((state) => state.loadList);
  const [name, setName] = useState('');
  const [deckType, setDeckType] = useState(PRIVATE_PLAYTESTING ? 'Constructed - Pioneer' : FREEFORM);
  const [gameType, setGameType] = useState('Two Player Duel');
  const [seats, setSeats] = useState(2);
  const [wins, setWins] = useState(2);
  const [aiSeats, setAiSeats] = useState(0);
  const [opponent, setOpponent] = useState(initialOpponent);
  const [mcpGuideOpen, setMcpGuideOpen] = useState(() => open && initialOpponent === 'mcp' && !mcpConnectionGuideHidden());
  const [chatMode, setChatMode] = useState<McpChatMode>('quiet');
  const [password, setPassword] = useState('');
  const [guest, setGuest] = useState('');
  const friends = useSocial((state) => state.friends);
  const invitedFriend = friends.includes(guest) ? guest : undefined;
  const [advanced, setAdvanced] = useState<TableAdvanced>(DEFAULT_ADVANCED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the table takes the format of the deck you join with
  useEffect(() => {
    if (!open || !deckId) return;
    let cancelled = false;
    void loadList(deckId).then((deck) => {
      if (!cancelled && deck.format && (!PRIVATE_PLAYTESTING || PRIVATE_FORMATS.includes(deck.format))) setDeckType(deck.format);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, deckId, loadList]);

  const allTypes = useMemo(() => serverState?.gameTypes ?? [], [serverState]);
  const gameTypes = useMemo(() => gameTypesFor(deckType, allTypes.map((item) => item.name!).filter(Boolean)), [deckType, allTypes]);
  const chosenGame = gameTypes.includes(gameType) ? gameType : gameTypes[0] ?? gameType;
  const type = allTypes.find((item) => item.name === chosenGame);
  const minSeats = type?.minPlayers ?? 2;
  const maxSeats = Math.min(type?.maxPlayers ?? 2, 6);
  const seatCount = Math.min(maxSeats, Math.max(minSeats, seats));
  const commander = isCommanderFormat(deckType);
  const menu = formatMenu(PRIVATE_PLAYTESTING ? PRIVATE_FORMATS : serverState?.deckTypes ?? []);
  const listed = menu.some((group) => group.types.includes(deckType));
  const aiCount = PRIVATE_PLAYTESTING ? (opponent === 'ai' ? 1 : 0) : aiSeats;

  function closeDialog() {
    setChatMode('quiet');
    setOpponent('friend');
    setGuest('');
    onOpenChange(false);
  }

  function chooseOpponent(next: HostOpponent) {
    setOpponent(next);
    if (next === 'mcp' && !mcpConnectionGuideHidden()) setMcpGuideOpen(true);
  }

  async function host() {
    if (!roomId || !deckId) return;
    setBusy(true);
    setError(null);
    let createdTableId: string | undefined;
    try {
      const { deck, id } = await loadForPlay(deckId);
      // the pictures download while the table fills, so the first hand lands with its art
      warmDeck(deck);
      const playerTypes = Array.from({ length: seatCount }, (_, index) => (index > 0 && index <= aiCount ? 'COMPUTER_MAD' : 'HUMAN'));
      const tablePassword = PRIVATE_PLAYTESTING ? crypto.randomUUID() : password;
      const table = await api.roomCreateTable(roomId, matchOptions({
        name: name.trim() || `${userName}'s table`,
        gameType: chosenGame,
        deckType,
        // a free-for-all is one game
        winsNeeded: seatCount > 2 ? 1 : wins,
        password: tablePassword,
        playerTypes,
        advanced,
        // players you ignore can't sit at your table or watch it
        bannedUsers: useSocial.getState().ignored,
      }));
      if (!table?.tableId) throw new Error('The server did not create the table.');
      createdTableId = table.tableId;
      const wire = selectedDeckForPlay(deck, id);
      if (!await api.roomJoinTable(roomId, table.tableId, userName, 'HUMAN', 1, wire, tablePassword)) {
        throw new Error(`Your deck is not legal in ${formatRules(deckType).label}.`);
      }
      if (PRIVATE_PLAYTESTING && opponent !== 'ai') {
        await createPlaytestingInvite({ tableId: table.tableId, roomId, format: deckType, password: tablePassword },
          opponent === 'mcp' ? { mode: 'mcp', chatMode }
            : { mode: 'friend', guestEngineName: invitedFriend });
      }
      if (aiCount > 0) {
        // the AI brings the format's own decks, or starter decks of the right kind; a deck that doesn't fit gets a copy of yours
        const rivals = await (await import('../stores/aiDecks')).aiDecks([], aiCount, commander, { format: deckType }).catch(() => []);
        rivals.forEach(warmDeck);
        for (let seat = 1; seat <= aiCount; seat++) {
          const rival = rivals[seat - 1] ? toWire(rivals[seat - 1]) : wire;
          const joined = await api.roomJoinTable(roomId, table.tableId, `AI ${seat}`, 'COMPUTER_MAD', 4, rival, tablePassword);
          if (!joined && (rival === wire || !await api.roomJoinTable(roomId, table.tableId, `AI ${seat}`, 'COMPUTER_MAD', 4, wire, tablePassword))) {
            throw new Error('The AI could not join with a legal deck.');
          }
        }
      }
      refreshTables();
      closeDialog();
    } catch (reason) {
      if (PRIVATE_PLAYTESTING && createdTableId) {
        await api.tableRemove(roomId, createdTableId).catch(() => undefined);
        refreshTables();
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (open && mcpGuideOpen) return <McpConnectionDialog onClose={() => setMcpGuideOpen(false)} />;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => next ? onOpenChange(true) : closeDialog()}
      title="Host a table"
      description={PRIVATE_PLAYTESTING ? undefined : 'Friends on this server will see it under Open tables.'}
      width="lg"
      footer={
        <>
          <Button variant="quiet" onClick={closeDialog}>Cancel</Button>
          <Button variant="decision" busy={busy} disabled={!deckId} onClick={() => void host()}>Host</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label="Table name" value={name} placeholder={`${userName}'s table`} onChange={(event) => setName(event.target.value)} />
        <div className={styles.pair}>
          <label className={styles.selectField}>
            <span>Format</span>
            <select value={deckType} onChange={(event) => setDeckType(event.target.value)}>
              {!listed && <option value={deckType}>{formatRules(deckType).label}</option>}
              {menu.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.types.map((item) => <option key={item} value={item}>{formatRules(item).label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className={styles.selectField}>
            <span>Game</span>
            <select value={chosenGame} onChange={(event) => setGameType(event.target.value)}>
              {gameTypes.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.pair}>
          {maxSeats > 2 ? (
            <label className={styles.selectField}>
              <span>Players</span>
              <select value={seatCount} onChange={(event) => setSeats(Number(event.target.value))}>
                {Array.from({ length: maxSeats - minSeats + 1 }, (_, index) => minSeats + index).map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
          ) : (
            <label className={styles.selectField}>
              <span>Games to win</span>
              <select value={wins} onChange={(event) => setWins(Number(event.target.value))}>
                {!PRIVATE_PLAYTESTING && <option value={1}>1 (single game)</option>}
                <option value={2}>2 (best of three)</option>
                {!PRIVATE_PLAYTESTING && <option value={3}>3 (best of five)</option>}
              </select>
            </label>
          )}
          {PRIVATE_PLAYTESTING ? <label className={styles.selectField}>
            <span>Opponent</span>
            <select value={opponent} onChange={(event) => chooseOpponent(event.target.value as HostOpponent)}>
              <option value="friend">Friend</option>
              <option value="mcp">Rival MCP</option>
              <option value="ai">XMage AI</option>
            </select>
          </label> : <label className={styles.selectField}>
            <span>AI players</span>
            <select value={Math.min(aiSeats, seatCount - 1)} onChange={(event) => setAiSeats(Number(event.target.value))}>
              {Array.from({ length: seatCount }, (_, index) => <option key={index} value={index}>{index === 0 ? 'None' : index}</option>)}
            </select>
          </label>}
        </div>
        {PRIVATE_PLAYTESTING ? (opponent === 'friend' && (
          <label className={styles.selectField}>
            <span>{t('tableInvite.guest')}</span>
            <select value={invitedFriend ?? ''} onChange={(event) => setGuest(event.target.value)}>
              <option value="">{t('tableInvite.anyoneWithLink')}</option>
              {friends.map((friend) => <option key={friend} value={friend}>{friend}</option>)}
            </select>
          </label>
        ))
          : <Field label="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} hint="Leave empty for an open table." />}
        {PRIVATE_PLAYTESTING && opponent === 'mcp' && (
          <div>
            <p className={styles.selectionHint}>{t('mcpInvite.accountRival')}</p>
            <label className={styles.selectField}>
              <span>{t('mcpInvite.chat.label')}</span>
              <select value={chatMode} aria-describedby="mcp-chat-description" onChange={(event) => setChatMode(event.target.value as McpChatMode)}>
                {MCP_CHAT_MODES.map((mode) => <option key={mode} value={mode}>{t(`mcpInvite.chat.${mode}`)}</option>)}
              </select>
            </label>
            <p id="mcp-chat-description" className={styles.selectionHint}>{t(`mcpInvite.chat.${chatMode}.description`)}</p>
            <Button size="sm" variant="quiet" onClick={() => setMcpGuideOpen(true)}>{t('mcpConnection.openGuide')}</Button>
          </div>
        )}
        <TableAdvancedFields
          value={advanced}
          onChange={(patch) => setAdvanced((current) => ({ ...current, ...patch }))}
          multiplayer={seatCount > 2}
          commander={commander}
        />
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
