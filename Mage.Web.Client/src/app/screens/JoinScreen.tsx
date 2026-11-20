import { useQuery } from '@tanstack/react-query';
import { Bot, Lock, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { APP_NAME } from '../brand';
import { api } from '../connection';
import { formatRules } from '../../core/decks/formats';
import { inviteLink } from '../../core/social/chatLine';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/social';
import { McpConnectionEndpoint } from '../mcp/McpConnection';
import { mcpEndpoint } from '../mcp/connectionGuide';
import { useTables } from '../queries';
import { claimPlaytestingInvite, PRIVATE_PLAYTESTING, type McpChatMode } from '../playtesting';
import { useDecks } from '../stores/decks';
import { useDeckRoster } from '../stores/useDeckRoster';
import { useSession } from '../stores/session';
import { usePlaytestingInvitation } from '../usePlaytestingInvitation';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Zone } from '../ui/Zone';
import { isSiteToolOrigin, NO_INPUT, useSiteTool } from '../webmcp';
import { joinTable } from './joinTable';
import styles from './JoinScreen.module.css';

registerMessages(messages);

const JOIN_MATCH = {
  name: 'join_match',
  description: 'Accept the invitation on this page as the signed-in player using the deck currently selected.',
  inputSchema: NO_INPUT,
};

function RecoveryFromInvite({ tableId }: { tableId: string }) {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (PRIVATE_PLAYTESTING) void api.recoveryList().then((rows) => {
      if (active) setLink(rows.find((row) => row.originalTableId === tableId)?.link ?? null);
    }).catch(() => {});
    return () => { active = false; };
  }, [tableId]);
  return link ? <p><Link to={link}>Return to this match from its confirmed saved boundary</Link></p> : null;
}

const MCP_GUIDES = [
  'playmat://guides/getting-started',
  'playmat://guides/card-catalog',
  'playmat://guides/turn-planning',
  'playmat://guides/rules',
];

function McpInviteGuide({ tableId, name, chatMode = 'quiet' }: { tableId: string; name?: string | null; chatMode?: McpChatMode }) {
  const navigate = useNavigate();
  const t = useT();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'manual' | null>(null);
  const origin = window.location.origin;
  const endpoint = mcpEndpoint();
  const instructions = [
    t('mcpInvite.instructions.connect', { app: APP_NAME, endpoint }),
    t('mcpInvite.instructions.read'),
    ...MCP_GUIDES.map((uri) => `- ${uri}`),
    t('mcpInvite.instructions.join', { link: inviteLink(origin, tableId) }),
    t('mcpInvite.instructions.chat', { mode: t(`mcpInvite.chat.${chatMode}`), description: t(`mcpInvite.chat.${chatMode}.description`) }),
    ...(chatMode === 'coach' ? [t('mcpInvite.instructions.coach')] : []),
  ].join('\n');

  async function copyInstructions() {
    try {
      await navigator.clipboard.writeText(instructions);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('manual');
    }
  }

  return (
    <Zone label="Rival MCP" className={styles.card}>
      <h2 className={styles.name}>{name}</h2>
      <McpConnectionEndpoint endpoint={endpoint} />
      <div className={styles.guide}>
        <h3>{t('mcpInvite.resources', { app: APP_NAME })}</h3>
        <p className={styles.note}>{t('mcpInvite.instructions.read')}</p>
        <ul>
          {MCP_GUIDES.map((uri) => <li key={uri}><code>{uri}</code></li>)}
        </ul>
        <p className={styles.note}><strong>{t(`mcpInvite.chat.${chatMode}`)}</strong> · {t(`mcpInvite.chat.${chatMode}.description`)}</p>
      </div>
      <div className={styles.actions}>
        <Button variant="quiet" onClick={() => navigate('/tables')}>{t('mcpInvite.back')}</Button>
        <Button variant="decision" onClick={() => void copyInstructions()}>{t('mcpInvite.copy')}</Button>
      </div>
      {copyStatus && <p className={styles.note} role="status">{t(copyStatus === 'copied' ? 'mcpInvite.copied' : 'mcpInvite.manualNotice')}</p>}
      {copyStatus === 'manual' && <textarea className={styles.manualCopy} aria-label={t('mcpInvite.manualLabel')} readOnly value={instructions} rows={8} />}
    </Zone>
  );
}

/** Where an invite link leads: the table, and a seat at it with one of your decks. */
export function JoinScreen() {
  const t = useT();
  const { tableId = '' } = useParams();
  const navigate = useNavigate();
  const { data: tables = [], dataUpdatedAt, refetch } = useTables();
  const { data: invitation, isPending: invitationPending, isFetching: invitationFetching, isError: invitationError } =
    usePlaytestingInvitation(tableId);
  // the cached list may predate the table: only a list fetched after the link was opened can say it's gone
  const [openedAt] = useState(() => Date.now());
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const fresh = dataUpdatedAt >= openedAt;
  const userName = useSession((state) => state.userName);
  const roomId = useSession((state) => state.roomId);
  const serverUrl = useSession((state) => state.serverUrl);
  const connected = useSession((state) => state.phase === 'signedIn' && state.connection === 'open' && !!state.roomId);
  const decks = useDecks();
  const roster = useDeckRoster();
  const [deckId, setDeckId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joining = useRef(false);

  useEffect(() => {
    if (!decks.loaded) void decks.refresh();
  }, [decks]);

  const listedTable = tables.find((candidate) => candidate.tableId === tableId);
  const lookupUnlisted = connected && !!roomId && invitation?.unlisted === true && !listedTable;
  const linkedTable = useQuery({
    queryKey: ['linked-table', roomId, tableId, userName],
    queryFn: () => api.roomGetTableById(roomId!, tableId),
    enabled: lookupUnlisted,
    refetchInterval: lookupUnlisted ? 2_000 : false,
    retry: false,
  });
  const table = listedTable ?? (lookupUnlisted ? linkedTable.data : null);
  const chosen = roster.find((deck) => deck.id === (deckId ?? decks.selectedId)) ?? roster[0] ?? null;
  const seated = !!table?.seats?.some((seat) => seat.playerName === userName);
  const open = table?.tableState === 'WAITING' && !!table.seats?.some((seat) => !seat.playerName);
  const allowedInvite = PRIVATE_PLAYTESTING
    ? !invitationPending && !invitationError && invitation?.mode === 'friend'
      && (invitation.guestEngineName
        ? invitation.guestEngineName.toLowerCase() === userName.toLowerCase()
        : invitation.unlisted === true)
    : !table?.passworded;
  const siteToolAvailable = connected && !!userName && (fresh || !!linkedTable.data) && open
    && !!chosen && !seated && allowedInvite && (!PRIVATE_PLAYTESTING || !invitationFetching)
    && isSiteToolOrigin(serverUrl);

  useSiteTool(siteToolAvailable, JOIN_MATCH, (_, signal) => siteToolAvailable
    ? join(signal)
    : { error: 'The invitation has no available seat for this session.' }, `${serverUrl}|${userName}|${tableId}`);

  async function join(signal?: AbortSignal) {
    if (!table || !chosen || !open || seated || joining.current || (PRIVATE_PLAYTESTING && !allowedInvite)) {
      return { error: 'This invitation has no available seat or deck.' };
    }
    joining.current = true;
    setBusy(true);
    setError(null);
    try {
      signal?.throwIfAborted();
      const tablePassword = PRIVATE_PLAYTESTING ? (await claimPlaytestingInvite(tableId, signal)).password : password;
      await joinTable(table, chosen.id, tablePassword, signal);
      if (!signal?.aborted) {
        decks.select(chosen.id);
        navigate('/tables');
      }
      return { joined: true, tableId };
    } catch (reason) {
      signal?.throwIfAborted();
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      return { error: message };
    } finally {
      joining.current = false;
      setBusy(false);
    }
  }

  const loading = (PRIVATE_PLAYTESTING && invitationPending) || (lookupUnlisted ? linkedTable.isPending : !fresh);
  if (!table || (PRIVATE_PLAYTESTING && invitationPending)) {
    return (
      <div className={styles.page}>
        <Zone label="Invite" className={styles.card}>
          {loading ? <p className={styles.note} role="status">Looking for the table…</p> : (
            <>
              <p className={styles.note}>This table is gone: the game may have started, or the host closed it.</p>
              <RecoveryFromInvite tableId={tableId} />
              <Button variant="print" onClick={() => navigate('/tables')}>See open tables</Button>
            </>
          )}
        </Zone>
      </div>
    );
  }

  if (invitation?.mode === 'mcp') {
    return (
      <div className={styles.page}>
        <McpInviteGuide key={tableId} tableId={tableId} name={table.tableName} chatMode={invitation.chatMode} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Zone label="You're invited" className={styles.card}>
        <h2 className={styles.name}>
          {table.passworded && <Lock size={18} aria-label="Password required" />}
          {table.tableName}
        </h2>
        <p className={styles.meta}>
          {formatRules(table.deckType ?? '').label} · {table.gameType} · hosted by {(table.controllerName ?? '').split(', ')[0]}
        </p>
        <ul className={styles.seats} aria-label="Seats">
          {(table.seats ?? []).map((seat, index) => (
            <li key={index} className={seat.playerName ? styles.taken : styles.free}>
              {seat.playerType && seat.playerType !== 'HUMAN' ? <Bot size={14} aria-hidden="true" /> : <UserRound size={14} aria-hidden="true" />}
              {seat.playerName || 'Open seat'}
            </li>
          ))}
        </ul>

        {seated ? (
          <>
            <p className={styles.note}>You have a seat at this table.</p>
            <Button variant="decision" onClick={() => navigate('/tables')}>Go to your tables</Button>
          </>
        ) : !open ? (
          <>
            <p className={styles.note}>This table has no open seat any more.</p>
            <Button variant="print" onClick={() => navigate('/tables')}>See open tables</Button>
          </>
        ) : PRIVATE_PLAYTESTING && !allowedInvite ? (
          <p className={styles.note}>{t('tableInvite.unavailable')}</p>
        ) : (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void join();
            }}
          >
            <label className={styles.select}>
              <span>Deck</span>
              <select value={chosen?.id ?? ''} onChange={(event) => setDeckId(event.target.value)} disabled={roster.length === 0}>
                {roster.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
              </select>
            </label>
            {!PRIVATE_PLAYTESTING && table.passworded && (
              <Field label="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} hint="Ask the host for it." />
            )}
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.actions}>
              <Button variant="quiet" onClick={() => navigate('/tables')}>Not now</Button>
              <Button type="submit" variant="decision" busy={busy} disabled={!chosen || (!PRIVATE_PLAYTESTING && table.passworded && !password)}>Take a seat</Button>
            </div>
          </form>
        )}
      </Zone>
    </div>
  );
}
