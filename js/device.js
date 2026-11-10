import { VAPID_PUBLIC_KEY, supabase, urlBase64ToUint8Array } from './config.js?v=8aaa0e5b67';
import { clearFieldNamesForPush } from './fields.js?v=8aaa0e5b67';
import { runtime, state } from './state.js?v=8aaa0e5b67';
import { esc } from './navigation.js?v=8aaa0e5b67';
import { t } from './i18n.js?v=8aaa0e5b67';
import { errorNotice, translateDbError } from './format.js?v=8aaa0e5b67';
import { render } from './main-view.js?v=8aaa0e5b67';

// --- "Zum Homescreen hinzufügen"-Hinweis --------------------------------
// Auf iOS funktioniert Web-Push NUR, wenn die Seite zum Home-Bildschirm hinzugefügt
// wurde (harte Plattform-Einschränkung seit iOS 16.4, kein normaler Safari-Tab-Push
// möglich) - auf Android/Desktop ist das "nice to have", kein Muss. Deshalb früh und
// deutlich darauf hinweisen, mit iOS-spezifischer Anleitung.
export function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
export function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// iOS übernimmt beim Start einer über "Zum Home-Bildschirm" installierten Web-App
// manchmal einen alten Zoom-Stand (z.B. von Safari zum Zeitpunkt des Hinzufügens)
// statt bei initial-scale=1.0 zu starten — wirkt wie "leicht reingezoomt". Fix ohne
// Zoomen dauerhaft zu sperren: den Viewport kurz auf maximum-scale=1 setzen (zwingt
// iOS, auf 100% zurückzuspringen), danach die Beschränkung sofort wieder entfernen,
// damit Pinch-to-Zoom für den Nutzer weiterhin uneingeschränkt funktioniert.
export function resetIOSZoomOnStandaloneStart() {
  if (!isIOSDevice() || !isStandaloneDisplay()) return;
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const original = viewport.getAttribute('content');
  viewport.setAttribute('content', original + ', maximum-scale=1.0');
  setTimeout(() => viewport.setAttribute('content', original), 300);
}
function isInstallHintDismissed() {
  try { return localStorage.getItem('installHintDismissed') === 'true'; } catch { return false; /* z.B. privater Modus */ }
}

export function isAboutSectionCollapsed(key) {
  return !runtime.openAboutSections.has(key);
}
function installHintText() {
  return isIOSDevice() ? t('installHint.ios') : t('installHint.other');
}
export function isMobileDevice() {
  return isIOSDevice() || /Android/.test(navigator.userAgent);
}
// Der dauerhafte In-App-Hinweis lohnt sich nur auf Mobilgeräten: auf iOS ist die
// Installation zwingend für Push (siehe oben), auf Android zumindest ein spürbares
// Plus. Auf Desktop funktioniert Push schon im normalen Browser-Tab genauso
// zuverlässig — "installieren" brächte dort nur kosmetische Vorteile (eigenes
// Fenster), das würde der bisherige Text aber fälschlich als Zuverlässigkeits-Vorteil
// verkaufen. Statt den Text zu verwässern, blendet der Hinweis auf Desktop komplett
// aus (genau wie die Installations-Seite vor dem Anmelden, renderInstallGate).
// Handy im Browser (nicht als App geöffnet): nur dann gibt es Hinweis und Menüpunkt.
export function canInstallFromHere() { return isMobileDevice() && !isStandaloneDisplay(); }
export function renderInstallHint() {
  if (!canInstallFromHere() || isInstallHintDismissed() || state.view === 'install') return '';
  return `
    <div class="install-hint">
      <span>${esc(installHintText())}<button type="button" class="install-hint-show" data-action="open-install">${t('installHint.show')}</button></span>
      <button type="button" class="install-hint-close" data-action="dismiss-install-hint" aria-label="${esc(t('ariaLabel.dismissHint'))}">×</button>
    </div>
  `;
}

// --- Push-Benachrichtigungen ------------------------------------------
export async function checkPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    state.pushStatus = 'unsupported';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const sub = await reg.pushManager.getSubscription();
    // Das Abo des Browsers gehört nicht zwingend zu diesem Konto: es kann von einem
    // anderen Konto auf diesem Gerät stammen oder serverseitig schon aufgeräumt sein
    // (abgelaufen). Fehlt die eigene Server-Zeile, ist es für dieses Konto nutzlos - dann
    // kündigen, damit "Erinnerungen einschalten" ein frisches anlegen kann. Nur bei
    // eindeutiger Antwort, nicht bei einem Netzwerkfehler.
    if (sub && state.session) {
      const { data, error } = await supabase.from('push_subscriptions')
        .select('id').eq('endpoint', sub.endpoint).maybeSingle();
      if (!error && !data) {
        await sub.unsubscribe();
        state.pushStatus = pushOffStatus();
        return;
      }
    }
    state.pushStatus = sub ? 'on' : pushOffStatus();
  } catch {
    state.pushStatus = 'unsupported';
  }
}

// Beendet die Erinnerungen dieses Geräts für das angemeldete Konto - beim Abmelden und
// beim Löschen des Kontos: Server-Zeile löschen (solange die Session noch gilt), das Abo
// im Browser kündigen und die lokale Namensliste leeren. Sonst kämen die Erinnerungen
// des alten Kontos samt Feldnamen weiter auf das Gerät, auch wenn sich danach jemand
// anders anmeldet. getRegistration statt serviceWorker.ready: ready wartet ohne
// registrierten Service Worker für immer. Best effort, darf das Abmelden nie blockieren.
export async function endPushForThisDevice({ deleteServerRow = true } = {}) {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      if (deleteServerRow) await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* best effort */ }
  await clearFieldNamesForPush();
  if (state.pushStatus !== 'unsupported') state.pushStatus = 'off';
}

// Ohne Abo: 'blocked', wenn Mitteilungen für Logbuch verboten sind (einmal "Blockieren"
// gedrückt - der Browser fragt dann nie wieder, nur eine Anleitung hilft weiter), sonst 'off'.
export function pushOffStatus() {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'off';
}
// Kurze Anleitung, wie man Mitteilungen wieder erlaubt - je nach Gerät und ob Logbuch
// installiert ist. Steht in den Einstellungen und im Tutorial statt einer Sackgasse.
export function pushBlockedHelp() {
  const key = isIOSDevice() ? 'push.blocked.ios'
    : /Android/.test(navigator.userAgent) ? (isStandaloneDisplay() ? 'push.blocked.androidApp' : 'push.blocked.androidBrowser')
      : 'push.blocked.other';
  return `
    <div class="push-blocked">
      <p>${t('push.blocked.intro')}</p>
      <p>${t(key)}</p>
      <p>${t('push.blocked.retryHint')}</p>
      <button type="button" class="push-toggle" data-action="enable-push">${t('push.blocked.retry')}</button>
    </div>
  `;
}
export async function enablePush() {
  state.pushStatus = 'busy';
  render();
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      // 'denied': Anleitung statt Meldung (pushBlockedHelp); 'default' = Dialog nur
      // weggeklickt, dann fragt der Browser beim nächsten Versuch wieder.
      state.pushStatus = pushOffStatus();
      // Blockiert fragt der Browser gar nicht erst - ohne Meldung wirkte "Nochmal versuchen"
      // wie kaputt.
      state.notice = { type: 'error', text: t(state.pushStatus === 'blocked' ? 'push.blocked.still' : 'notice.pushPermissionDenied') };
      render();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const json = sub.toJSON();
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: state.session.user.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth_key: json.keys.auth,
      },
      { onConflict: 'endpoint' }
    );
    if (error) throw new Error(translateDbError(error.message));
    state.pushStatus = 'on';
    state.notice = { type: 'ok', text: t('notice.pushEnabled') };
  } catch (err) {
    state.pushStatus = 'off';
    state.notice = errorNotice('notice.enableFailed', (err.message || err));
  }
  render();
}

export async function disablePush() {
  state.pushStatus = 'busy';
  render();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    state.pushStatus = 'off';
  } catch (err) {
    state.notice = errorNotice('notice.disableFailed', (err.message || err));
  }
  render();
}
