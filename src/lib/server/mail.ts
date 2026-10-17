import nodemailer from 'nodemailer';
import { config } from './config';
import { reference, type Job } from '../shared';

export interface Message { to: string; subject: string; text: string }
export type Mailer = (message: Message) => Promise<void>;
export const sendMail: Mailer = async (message) => {
  const secure = process.env.SMTP_SECURE !== 'false';
  if (config().production && !secure) throw new Error('Production SMTP requires implicit TLS');
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('SMTP_HOST and SMTP_FROM are required');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? (secure ? 465 : 1025)), secure,
    auth: process.env.SMTP_USERNAME ? { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  try {
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, ...message, disableFileAccess: true, disableUrlAccess: true });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP did not accept recipient');
  } finally { transport.close(); }
};
export function confirmationMessage(job: Job, token: string): Message {
  return { to: job.email, subject: `Confirm your PrintHive job · ${reference(job.id)}`,
    text: `Your print: ${job.title}\nReference: ${reference(job.id)}\n\nOpen this link, then press Confirm print to join the queue:\n${config().origin}/confirm?token=${encodeURIComponent(token)}\n\nThis link expires in 24 hours. Your job is not queued until you confirm it.\n\nIf you did not request this print, ignore this email.` };
}
export function statusMessage(job: Job): Message {
  return { to: job.email, subject: `PrintHive · ${job.title} is ${job.status}`,
    text: `Your print “${job.title}” (${reference(job.id)}) is now ${job.status}.\n\nView the queue: ${config().origin}/\n\nPrintHive` };
}
