import { ArrowLeft, ArrowRight, Mail } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME } from '../brand';
import { useT, type MessageKey } from '../i18n';
import { TurnstileWidget } from '../screens/TurnstileWidget';
import { Field } from '../ui/Field';
import { Mark } from '../ui/Mark';
import hero from './tabletop-hero.jpg';
import { rememberSignupReturn, takeSignupReturn } from './signupReturn';
import styles from './PublicSite.module.css';

const SIGNUP_API = '/api/playtesting/signup';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNUP_CHALLENGE_ACTION = 'turnstile-spin-v2';

async function submitSignup(action: 'request' | 'complete', body: Record<string, string>): Promise<number> {
  try {
    const response = await fetch(`${SIGNUP_API}/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  } catch {
    return 0;
  }
}

export function SignupCompletionScreen() {
  return <SignupScreen completing />;
}

export function SignupScreen({ completing = false }: { completing?: boolean } = {}) {
  const { hash } = useLocation();
  const t = useT();
  const token = new URLSearchParams(hash.slice(1)).get('token') ?? '';
  return (
    <div className={styles.site}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/"><Mark size={38} />{APP_NAME}</Link>
        <a className={styles.secondary} href="/login">{t('public.signIn')}</a>
      </header>
      <main className={styles.signup}>
        <div className={styles.formPanel}>
          <Link className={styles.back} to="/"><ArrowLeft size={17} aria-hidden="true" />{t('public.back')}</Link>
          {completing ? <CompleteSignup key={token} token={token} /> : <RequestSignup />}
        </div>
        <img className={styles.signupArt} src={hero} alt="" width={1450} height={967} />
      </main>
    </div>
  );
}

function RequestSignup() {
  const t = useT();
  const { search } = useLocation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>();
  const [challengeUnavailable, setChallengeUnavailable] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [challengeAttempt, setChallengeAttempt] = useState(0);
  const ready = siteKey !== undefined && (!siteKey || !!challengeToken);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${SIGNUP_API}/config`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Signup configuration unavailable');
        const config = await response.json();
        if (config?.turnstileSiteKey !== null && (typeof config?.turnstileSiteKey !== 'string' || !config.turnstileSiteKey)) {
          throw new Error('Invalid signup configuration');
        }
        if (!controller.signal.aborted) setSiteKey(config.turnstileSiteKey);
      })
      .catch(() => {
        if (!controller.signal.aborted) setChallengeUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !ready) return;
    setPending(true);
    setError(null);
    const status = await submitSignup('request', {
      email: email.trim(),
      ...(siteKey ? { turnstileToken: challengeToken } : {}),
    });
    setChallengeToken('');
    setChallengeAttempt((previous) => previous + 1);
    if (status === 202) {
      rememberSignupReturn(new URLSearchParams(search).get('next'));
      setSent(true);
    } else setError(status === 400 ? 'public.emailInvalid' : status === 403 ? 'public.challengeInvalid'
      : status === 429 ? 'public.tryLater' : 'public.requestFailed');
    setPending(false);
  }

  if (sent) return (
    <div role="status" className={styles.formIntro}>
      <Mail className={styles.mail} size={30} strokeWidth={1.55} aria-hidden="true" />
      <h1>{t('public.checkEmail')}</h1>
      <p>{t('public.checkEmailHint', { email: email.trim() })}</p>
      <button className={styles.secondary} type="button" onClick={() => setSent(false)}>{t('public.changeEmail')}</button>
    </div>
  );

  return (
    <>
      <div className={styles.formIntro}><h1>{t('public.signupTitle')}</h1><p>{t('public.signupHint')}</p></div>
      <form className={styles.form} onSubmit={submit}>
        <Field className={styles.field} label={t('public.email')} type="email" name="email" value={email} autoComplete="email" maxLength={254} required
          onChange={(event) => setEmail(event.target.value)} />
        {siteKey && <TurnstileWidget key={challengeAttempt} siteKey={siteKey} action={SIGNUP_CHALLENGE_ACTION}
          onToken={(token) => {
            setChallengeToken(token);
            if (token) setChallengeUnavailable(false);
          }} onUnavailable={() => setChallengeUnavailable(true)} />}
        {challengeUnavailable ? <p role="alert" className={styles.error}>{t('login.turnstile.unavailable')}</p>
          : error && <p role="alert" className={styles.error}>{t(error)}</p>}
        <button className={styles.primary} disabled={pending || !ready}>{t(pending ? 'public.sending' : 'public.sendLink')} <ArrowRight size={18} aria-hidden="true" /></button>
      </form>
    </>
  );
}

function CompleteSignup({ token }: { token: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const status = await submitSignup('complete', { token, username, password });
    if (status === 201) {
      void navigate(takeSignupReturn(), { replace: true });
      return;
    }
    if (status === 410) setExpired(true);
    else setError(status === 409 ? 'public.usernameTaken' : status === 400 ? 'public.accountInvalid'
      : status === 429 ? 'public.tryLater' : 'public.completeFailed');
    setPending(false);
  }

  if (expired || !TOKEN_PATTERN.test(token)) return (
    <div className={styles.formIntro}>
      <h1>{t('public.linkInvalid')}</h1>
      <p>{t('public.linkInvalidHint')}</p>
      <Link className={styles.primary} to="/register">{t('public.freshLink')} <ArrowRight size={18} aria-hidden="true" /></Link>
    </div>
  );

  return (
    <>
      <div className={styles.formIntro}><h1>{t('public.chooseName')}</h1><p>{t('public.chooseNameHint', { app: APP_NAME })}</p></div>
      <form className={styles.form} onSubmit={submit}>
        <Field className={styles.field} label={t('public.username')} name="username" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false}
          minLength={3} maxLength={14} pattern="[A-Za-z0-9_]{3,14}" required hint={t('public.usernameHint')} aria-invalid={error === 'public.usernameTaken' ? true : undefined}
          onChange={(event) => setUsername(event.target.value)} />
        <Field className={styles.field} label={t('public.password')} type="password" name="password" value={password} autoComplete="new-password"
          minLength={12} maxLength={128} required hint={t('public.passwordHint')} onChange={(event) => setPassword(event.target.value)} />
        {error && <p role="alert" className={styles.error}>{t(error)}</p>}
        <button className={styles.primary} disabled={pending}>{t(pending ? 'public.creating' : 'public.create')} <ArrowRight size={18} aria-hidden="true" /></button>
      </form>
    </>
  );
}
