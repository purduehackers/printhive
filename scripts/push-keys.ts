import webPush from 'web-push';

const keys = webPush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('# Set VAPID_SUBJECT to your real contact URI, for example mailto:you@your-domain.edu.');
