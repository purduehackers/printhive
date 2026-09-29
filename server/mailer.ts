import nodemailer, { type Transporter } from 'nodemailer';

interface MailerConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

const config: MailerConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASSWORD || '',
  from: process.env.SMTP_FROM || 'PrintHive Purdue <noreply@purdue.edu>',
};

let transporter: Transporter | null = null;

if (config.user && config.pass) {
  try {
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
    console.log(`[Mailer] Initialized SMTP transporter with ${config.host}:${config.port}`);
  } catch (err) {
    console.warn('[Mailer] Could not initialize SMTP transporter:', err);
  }
} else {
  console.log('[Mailer] No SMTP credentials provided. Running in DEV/CONSOLE mailer mode.');
}

/**
 * Send 6-digit verification code to a Purdue email address
 */
export async function sendVerificationEmail(email: string, code: string): Promise<{ success: boolean; devCode?: string }> {
  const subject = 'Your PrintHive 3D Print Verification Code';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #CEB888; margin: 0; font-size: 28px; font-weight: 800; letter-spacing: -0.5px;">PrintHive</h1>
        <p style="color: #64748b; margin: 4px 0 0 0; font-size: 14px;">Purdue University Makerspace 3D Print Queue</p>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <p style="color: #334155; font-size: 15px; margin: 0 0 12px 0;">Use the 6-digit verification code below to confirm your print submission:</p>
        <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0f172a; padding: 12px; background: #ffffff; border-radius: 6px; border: 2px dashed #CEB888; display: inline-block;">
          ${code}
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 12px 0 0 0;">This code will expire in 15 minutes.</p>
      </div>

      <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
        If you did not request this print job submission, you can safely ignore this email.
      </p>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <div style="text-align: center; color: #94a3b8; font-size: 12px;">
        Purdue Hackers & Makerspace · Boiler Up! 🚂
      </div>
    </div>
  `;

  console.log(`\n======================================================`);
  console.log(`[DEV MAILER] Verification code for ${email}: ${code}`);
  console.log(`======================================================\n`);

  if (transporter) {
    try {
      await transporter.sendMail({
        from: config.from,
        to: email,
        subject,
        html,
      });
      console.log(`[Mailer] Verification email sent to ${email}`);
      return { success: true };
    } catch (error) {
      console.error(`[Mailer] Failed to send email via SMTP:`, error);
      // Fallback: still return success in dev mode so flow isn't blocked
      return { success: true, devCode: code };
    }
  }

  return { success: true, devCode: code };
}

/**
 * Send notification to user that their print is finished
 */
export async function sendJobCompletedEmail(email: string, jobTitle: string, pickupNotes?: string): Promise<boolean> {
  const subject = `Your 3D Print is Ready for Pickup! (${jobTitle})`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #16a34a; margin: 0; font-size: 28px; font-weight: 800;">Print Complete! 🎉</h1>
        <p style="color: #64748b; margin: 4px 0 0 0; font-size: 14px;">PrintHive Makerspace Notification</p>
      </div>

      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <h2 style="color: #15803d; font-size: 18px; margin: 0 0 8px 0;">Good news!</h2>
        <p style="color: #166534; font-size: 15px; margin: 0;">
          Your 3D print <strong>${jobTitle}</strong> has finished printing and has been cleared from the build plate.
        </p>
      </div>

      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <h3 style="color: #0f172a; font-size: 14px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">Pickup Instructions</h3>
        <p style="color: #475569; font-size: 14px; margin: 0;">
          ${pickupNotes || 'Your part is waiting in the completed print bin at the makerspace. Please pick it up at your earliest convenience!'}
        </p>
      </div>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <div style="text-align: center; color: #94a3b8; font-size: 12px;">
        Purdue Hackers & Makerspace · Boiler Up! 🚂
      </div>
    </div>
  `;

  console.log(`\n======================================================`);
  console.log(`[DEV MAILER] Completion notice for ${email}: "${jobTitle}" is done!`);
  console.log(`======================================================\n`);

  if (transporter) {
    try {
      await transporter.sendMail({
        from: config.from,
        to: email,
        subject,
        html,
      });
      console.log(`[Mailer] Completion email sent to ${email}`);
      return true;
    } catch (error) {
      console.error(`[Mailer] Failed to send completion email via SMTP:`, error);
      return false;
    }
  }

  return true;
}
