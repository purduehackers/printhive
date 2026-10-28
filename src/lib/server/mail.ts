import nodemailer from 'nodemailer';
import { config } from './config';
import { effectiveGroupName, reference, type Job } from '../shared';
import { logError } from './log';

export interface Message { to: string; subject: string; text: string }
export type Mailer = (message: Message, context?: { jobId: string; purpose: 'confirmation' | 'status' }) => Promise<void>;
export const sendMail: Mailer = async (message, context) => {
  const secure = process.env.SMTP_SECURE !== 'false';
  const port = Number(process.env.SMTP_PORT ?? (secure ? 465 : 1025));
  const started = Date.now();
  let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
  try {
    if (config().production && !secure) throw new Error('Production SMTP requires implicit TLS');
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('SMTP_HOST and SMTP_FROM are required');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure,
      auth: process.env.SMTP_USERNAME ? { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    });
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, ...message, disableFileAccess: true, disableUrlAccess: true });
    if (!result.accepted?.length || result.rejected?.length) throw Object.assign(new Error('SMTP did not accept recipient'), {
      code: 'EENVELOPE', response: result.response,
    });
  } catch (error) {
    logError('email.send_failed', error, { ...context, smtpHost: process.env.SMTP_HOST, smtpPort: port,
      secure, authConfigured: Boolean(process.env.SMTP_USERNAME), durationMs: Date.now() - started });
    throw error;
  } finally { transport?.close(); }
};
export function confirmationMessage(job: Job | Job[], token: string): Message {
  const jobs = Array.isArray(job) ? job : [job];
  if (jobs.length === 1) {
    const single = jobs[0];
    return { to: single.email, subject: `Confirm your PrintHive job · ${reference(single.id)}`,
      text: `Your print: ${single.title}\nReference: ${reference(single.id)}\n\nOpen this link, then press Confirm print to join the queue:\n${config().origin}/confirm?token=${encodeURIComponent(token)}\n\nThis link expires in 24 hours. Your job is not queued until you confirm it.\n\nIf you did not request this print, ignore this email.` };
  }
  const groupLabel = effectiveGroupName(jobs[0]);
  const list = jobs.map(j => `- ${j.title} (#${reference(j.id)})`).join('\n');
  return {
    to: jobs[0].email,
    subject: `Confirm your PrintHive batch${groupLabel ? ` · ${groupLabel}` : ''} (${jobs.length} prints) · ${reference(jobs[0].id)}`,
    text: `Your batch submission${groupLabel ? ` “${groupLabel}”` : ''} (${jobs.length} prints):\n${list}\n\nOpen this link, then press Confirm prints to join the queue:\n${config().origin}/confirm?token=${encodeURIComponent(token)}\n\nThis link expires in 24 hours. Your jobs are not queued until you confirm them.\n\nIf you did not request these prints, ignore this email.`,
  };
}
export function statusMessage(job: Job | Job[], feedback = ''): Message {
  const jobs = Array.isArray(job) ? job : [job];
  if (jobs.length === 1) {
    const single = jobs[0];
    if (single.status === 'rejected') return {
      to: single.email, subject: `PrintHive · ${single.title} was returned with feedback`,
      text: `Your print “${single.title}” (${reference(single.id)}) was rejected and returned for changes. It is no longer in the active queue.\n\nOperator feedback:\n${feedback}\n\nPlease address the feedback and submit a revised print:\n${config().origin}/submit\n\nPrintHive`,
    };
    return { to: single.email, subject: `PrintHive · ${single.title} is ${single.status}`,
      text: `Your print “${single.title}” (${reference(single.id)}) is now ${single.status}.\n\nView the queue: ${config().origin}/\n\nPrintHive` };
  }
  const firstGroup = effectiveGroupName(jobs[0]);
  const sharedGroup = firstGroup && jobs.every(j => effectiveGroupName(j) === firstGroup) ? firstGroup : null;
  const list = jobs.map(j => `- ${j.title} (#${reference(j.id)})`).join('\n');
  const status = jobs[0].status;
  if (status === 'rejected') return {
    to: jobs[0].email,
    subject: `PrintHive · ${sharedGroup ? `${sharedGroup} (${jobs.length} prints)` : `${jobs.length} prints`} returned with feedback`,
    text: `Your prints${sharedGroup ? ` in “${sharedGroup}”` : ''} (${jobs.length} prints) were rejected and returned for changes. They are no longer in the active queue:\n${list}\n\nOperator feedback:\n${feedback}\n\nPlease address the feedback and submit revised prints:\n${config().origin}/submit\n\nPrintHive`,
  };
  return {
    to: jobs[0].email,
    subject: `PrintHive · ${sharedGroup ? `${sharedGroup} (${jobs.length} prints)` : `${jobs.length} prints`} are ${status}`,
    text: `Your prints${sharedGroup ? ` in “${sharedGroup}”` : ''} (${jobs.length} prints) are now ${status}:\n${list}\n\nView the queue: ${config().origin}/\n\nPrintHive`,
  };
}
