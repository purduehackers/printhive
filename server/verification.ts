/**
 * Purdue Email Verification and 6-Digit OTP Management
 */
import { randomInt, timingSafeEqual } from 'node:crypto';

interface PendingVerification {
  code: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
  lastRequestedAt: number;
  requestCount: number;
}

// In-memory verification storage: email -> PendingVerification
const verifications = new Map<string, PendingVerification>();

// Code validity duration: 15 minutes
const EXPIRATION_MS = 15 * 60 * 1000;

// Minimum cooldown between code requests: 60 seconds
const REQUEST_COOLDOWN_MS = 60 * 1000;

// Maximum code requests per 15-minute window
const MAX_REQUESTS_PER_WINDOW = 5;

// Maximum failed attempts across a window before lockout
const MAX_ATTEMPTS = 5;

/**
 * Checks whether an email belongs to the purdue.edu domain
 */
export function isPurdueEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  
  // Standard email format with purdue.edu or any subdomain like @alumni.purdue.edu
  const purdueRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-zA-Z0-9-]+\.)*purdue\.edu$/;
  return purdueRegex.test(trimmed);
}

/**
 * Generates a cryptographically secure random 6-digit verification code string
 */
export function generateSixDigitCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * Constant time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Rate limit check for code requests
 */
export function canRequestCode(email: string): { allowed: boolean; message?: string; retryAfterSeconds?: number } {
  const normalizedEmail = email.trim().toLowerCase();
  const record = verifications.get(normalizedEmail);
  const now = Date.now();

  if (!record) {
    return { allowed: true };
  }

  // Check cooldown between requests
  const elapsed = now - record.lastRequestedAt;
  if (elapsed < REQUEST_COOLDOWN_MS) {
    const remaining = Math.ceil((REQUEST_COOLDOWN_MS - elapsed) / 1000);
    return {
      allowed: false,
      message: `Please wait ${remaining} second${remaining > 1 ? 's' : ''} before requesting another code.`,
      retryAfterSeconds: remaining,
    };
  }

  // Check max requests per window
  if (record.requestCount >= MAX_REQUESTS_PER_WINDOW) {
    const remainingMinutes = Math.ceil((record.expiresAt - now) / 60000);
    return {
      allowed: false,
      message: `Too many code requests for this email. Please try again in ${remainingMinutes > 0 ? remainingMinutes : 15} minutes.`,
    };
  }

  // Check if locked out due to excessive failed attempts
  if (record.attempts >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      message: 'This email is temporarily locked due to too many failed attempts. Please try again later.',
    };
  }

  return { allowed: true };
}

/**
 * Store a newly issued 6-digit code for a Purdue email with rate limiting
 */
export function issueVerificationCode(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const code = generateSixDigitCode();
  const now = Date.now();
  const existing = verifications.get(normalizedEmail);
  
  verifications.set(normalizedEmail, {
    code,
    expiresAt: now + EXPIRATION_MS,
    attempts: existing ? existing.attempts : 0,
    verified: false,
    lastRequestedAt: now,
    requestCount: existing ? existing.requestCount + 1 : 1,
  });

  return code;
}

export interface VerificationResult {
  valid: boolean;
  message?: string;
}

/**
 * Verify a submitted 6-digit code for an email
 */
export function verifyCode(email: string, inputCode: string): VerificationResult {
  const normalizedEmail = email.trim().toLowerCase();
  const record = verifications.get(normalizedEmail);

  if (!record) {
    return {
      valid: false,
      message: 'No verification code requested for this email. Please request a new code.',
    };
  }

  if (Date.now() > record.expiresAt) {
    verifications.delete(normalizedEmail);
    return {
      valid: false,
      message: 'Verification code has expired. Please request a new code.',
    };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    return {
      valid: false,
      message: 'Too many incorrect attempts. Please request a new code later.',
    };
  }

  const cleanInput = (inputCode || '').trim();
  if (!constantTimeCompare(record.code, cleanInput)) {
    record.attempts += 1;
    const remainingAttempts = MAX_ATTEMPTS - record.attempts;
    if (remainingAttempts <= 0) {
      return {
        valid: false,
        message: 'Too many incorrect attempts. Please request a new code later.',
      };
    }
    return {
      valid: false,
      message: `Incorrect code. ${remainingAttempts} attempt${remainingAttempts > 1 ? 's' : ''} remaining.`,
    };
  }

  // Mark verified
  record.verified = true;
  return { valid: true };
}

/**
 * Check if the email was successfully verified
 */
export function isEmailVerified(email: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const record = verifications.get(normalizedEmail);
  return !!record && record.verified && Date.now() <= record.expiresAt;
}

/**
 * Consume verification code after successful print job submission
 */
export function consumeVerification(email: string): void {
  const normalizedEmail = email.trim().toLowerCase();
  verifications.delete(normalizedEmail);
}

// Clean up expired verification codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of verifications.entries()) {
    if (now > record.expiresAt) {
      verifications.delete(email);
    }
  }
}, 5 * 60 * 1000);
