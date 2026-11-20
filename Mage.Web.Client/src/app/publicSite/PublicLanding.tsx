import { ArrowRight, History, Layers, Swords } from 'lucide-react';
import { Link } from 'react-router-dom';
import { APP_NAME } from '../brand';
import { useT } from '../i18n';
import { Mark } from '../ui/Mark';
import hero from './tabletop-hero.jpg';
import styles from './PublicSite.module.css';

const features = [
  { Icon: Layers, title: 'public.decks.title', description: 'public.decks.description' },
  { Icon: Swords, title: 'public.play.title', description: 'public.play.description' },
  { Icon: History, title: 'public.review.title', description: 'public.review.description' },
] as const;

export function PublicLanding() {
  const t = useT();
  return (
    <div className={styles.site}>
      <header className={styles.header}>
        <span className={styles.brand}><Mark size={38} />{APP_NAME}</span>
        <a className={styles.secondary} href="/login">{t('public.signIn')}</a>
      </header>
      <main className={styles.content}>
        <section className={styles.hero} aria-labelledby="public-title">
          <img className={styles.heroArt} src={hero} alt="" fetchPriority="high" width={1450} height={967} />
          <div className={styles.heroCopy}>
            <h1 id="public-title">{t('public.title')} <em>{t('public.secondLine')}</em></h1>
            <p>{t('public.lead')}</p>
            <Link className={styles.primary} to="/register">{t('public.create')} <ArrowRight size={19} aria-hidden="true" /></Link>
          </div>
        </section>
        <ul className={styles.features}>
          {features.map(({ Icon, title, description }) => (
            <li className={styles.feature} key={title}>
              <Icon size={23} strokeWidth={1.55} aria-hidden="true" />
              <div><h2>{t(title)}</h2><p>{t(description)}</p></div>
            </li>
          ))}
        </ul>
      </main>
      <footer className={styles.footer}>
        <p>{t('public.fanProject')}</p>
      </footer>
    </div>
  );
}
