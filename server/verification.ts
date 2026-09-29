/**
 * Purdue Email Verification and 6-Digit OTP Management
 */

interface PendingVerification {
  code: string;
  expiresAt: number;
  attempts: number;
  verified: boolean;
}

// In-memory verification storage: email -> PendingVerification
const verifications = new Map<string, PendingVerification>();

// Code validity duration: 15 minutes
const EXPIRATION_MS = 15 * 60 * 1000;

// Maximum failed attempts before code is invalidated
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
 * Generates a random 6-digit verification code string
 */
export function generateSixDigitCode(): string {
  // Generates between 100000 and 999999
  const num = Math.floor(100000 + Math.random() * 900000);
  return num.toString();
}

/**
 * Store a newly issued 6-digit code for a Purdue email
 */
export function issueVerificationCode(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  const code = generateSixDigitCode();
  
  verifications.set(normalizedEmail, {
    code,
    expiresAt: Date.now() + EXPIRATION_MS,
    attempts: 0,
    verified: false,
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
    verifications.delete(normalizedEmail);
    return {
      valid: false,
      message: 'Too many incorrect attempts. Please request a new code.',
    };
  }

  const cleanInput = inputCode.trim();
  if (record.code !== cleanInput) {
    record.attempts += 1;
    return {
      valid: false,
      message: "Code doesn't match. Please enter the correct 6-digit code.",
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
