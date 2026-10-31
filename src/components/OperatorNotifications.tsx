import { useEffect, useRef, useState } from 'react';
import '../styles/notifications.css';

interface Settings { configured: boolean; publicKey: string | null; enabled: boolean; endpoint: string | null }
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function applicationKey(value: string) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

export default function OperatorNotifications() {
  const [supported, setSupported] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const actionVersion = useRef(0);
  const actionInProgress = useRef(false);

  useEffect(() => {
    const available = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setSupported(available);
    setInstalled(window.matchMedia('(display-mode: standalone)').matches);
    if ('Notification' in window) setPermission(Notification.permission);
    let disposed = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (actionInProgress.current) return;
      const version = actionVersion.current;
      try {
        const response = await fetch('/api/push', { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to manage notifications.' : 'Could not load notification settings.');
        const result: Settings = await response.json();
        let subscription: PushSubscription | null = null;
        if (available) {
          await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
          const registration = await navigator.serviceWorker.ready;
          subscription = await registration.pushManager.getSubscription();
        }
        if (!disposed && version === actionVersion.current) {
          setSettings(result);
          const existingKey = subscription?.options.applicationServerKey;
          const matchingKey = result.publicKey && existingKey && Array.from(new Uint8Array(existingKey)).join(',') === Array.from(applicationKey(result.publicKey)).join(',');
          setEnabled(Boolean(result.enabled && matchingKey && subscription?.endpoint === result.endpoint && Notification.permission === 'granted'));
          if (available) setPermission(Notification.permission);
        }
      } catch (cause) {
        if (!disposed && version === actionVersion.current) { setError(true); setMessage(cause instanceof Error ? cause.message : 'Could not load notification settings.'); }
      }
    };
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    const appInstalled = () => { setInstalled(true); setInstallPrompt(null); };
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', appInstalled);
    return () => {
      disposed = true; controller.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', appInstalled);
    };
  }, []);

  async function request(path: string, method: string, body?: unknown) {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not update notifications.');
    return result;
  }

  async function enable() {
    if (!settings?.publicKey || !supported) return;
    actionVersion.current++; actionInProgress.current = true;
    setBusy(true); setMessage(''); setError(false);
    try {
      // Request directly from the button gesture, before any network work.
      const allowed = await Notification.requestPermission();
      setPermission(allowed);
      if (allowed !== 'granted') throw new Error('Notifications were not enabled. You can allow them in your browser’s site settings.');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      const key = applicationKey(settings.publicKey);
      const existingKey = subscription?.options.applicationServerKey;
      if (subscription && (!existingKey || Array.from(new Uint8Array(existingKey)).join(',') !== Array.from(key).join(','))) {
        await subscription.unsubscribe(); subscription = null;
      }
      if (!subscription) {
        try {
          subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === 'AbortError') {
            throw new Error('Your browser could not register with its push service. In Brave, enable “Use Google services for push messaging” in Privacy and security settings, then restart Brave. Otherwise, try a normal Chrome or Edge window and check whether your network allows push notifications.');
          }
          throw cause;
        }
      }
      await request('/api/push', 'POST', subscription.toJSON());
      const endpoint = subscription.endpoint;
      setSettings(current => current ? { ...current, enabled: true, endpoint } : current);
      setEnabled(true);
      setMessage('Notifications enabled.');
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : 'Could not enable notifications.'); }
    finally { actionInProgress.current = false; setBusy(false); }
  }

  async function disable() {
    actionVersion.current++; actionInProgress.current = true;
    setBusy(true); setMessage(''); setError(false);
    try {
      await request('/api/push', 'DELETE');
      setSettings(current => current ? { ...current, enabled: false, endpoint: null } : current);
      setEnabled(false);
      if (supported) {
        const registration = await navigator.serviceWorker.ready;
        await (await registration.pushManager.getSubscription())?.unsubscribe();
      }
      setMessage('Notifications disabled.');
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : 'Could not disable notifications.'); }
    finally { actionInProgress.current = false; setBusy(false); }
  }

  async function test() {
    actionVersion.current++; actionInProgress.current = true;
    setBusy(true); setMessage(''); setError(false);
    try {
      // Activation does not reload pages: this worker has no fetch/cache behavior.
      const registration = await navigator.serviceWorker.getRegistration('/');
      await registration?.update();
      await request('/api/push/test', 'POST'); setMessage('Test sent.');
    }
    catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : 'Could not send a test.'); }
    finally { actionInProgress.current = false; setBusy(false); }
  }

  async function install() {
    if (!installPrompt) return;
    try { await installPrompt.prompt(); await installPrompt.userChoice; }
    catch { setError(true); setMessage('Use your browser’s menu to install PrintHive.'); }
    finally { setInstallPrompt(null); }
  }

  return <section className="operator-notifications" aria-labelledby="notifications-heading">
    <div>
      <h2 id="notifications-heading">Print alerts</h2>
      {settings && !settings.configured && <p className="small">Notifications aren’t configured.</p>}
      {settings && !supported && <p className="small">Notifications are unavailable in this browser or connection.</p>}
      {supported && permission === 'denied' && <p className="small">Notifications are blocked. Allow them in your browser settings.</p>}
      {message && <p className={`small ${error ? 'notification-error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
    </div>
    <div className="notification-actions">
      {enabled ? <>
        <button className="button secondary" disabled={busy || !settings?.configured} onClick={test}>Send test</button>
        <button className="text-button" disabled={busy} onClick={disable}>Disable notifications</button>
      </> : <>
        <button className="button secondary" disabled={busy || !settings?.configured || !supported || permission === 'denied'} onClick={enable}>Enable notifications</button>
        {settings?.enabled && <button className="text-button" disabled={busy} onClick={disable}>Disable notifications</button>}
      </>}
      {!installed && <>
        {installPrompt && <button className="button secondary" onClick={install}>Install PrintHive</button>}
      </>}
    </div>
  </section>;
}
