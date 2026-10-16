import path from 'node:path';
import fs from 'node:fs';
import { isPurdueEmail, issueVerificationCode, verifyCode, isEmailVerified, consumeVerification, canRequestCode } from './verification';
import { sendVerificationEmail, sendJobCompletedEmail } from './mailer';
import { initPocketBase, getQueueJobs, createJob, updateJobStatus, getJobById, authenticateOperator, verifyOperatorToken, type PrintJobRecord } from './pocketbase';

const PORT = parseInt(process.env.PORT || '3001', 10);
// Strict fail-closed dev mode check
const isDev = process.env.DEV_MODE === 'true';

if (isDev) {
  console.warn('⚠️  [SECURITY WARNING] DEV_MODE is enabled. Verification codes will be returned in API responses.');
}

// Initialize PocketBase on startup
initPocketBase().catch((err) => console.warn('[PocketBase] Startup init error:', err));

// Standard 3D print defaults
const DEFAULT_SETTINGS = {
  infill: 15,
  layerHeight: 0.20,
  material: 'PLA',
  supports: 'default',
  color: 'Any',
};

const ALLOWED_MATERIALS = ['PLA', 'PETG', 'ABS', 'TPU', 'Resin'];
const ALLOWED_SUPPORTS = ['none', 'default', 'tree', 'organic'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function calculateSettingsDiff(userSettings: Record<string, any>): Record<string, any> {
  const diff: Record<string, any> = {};
  
  if (userSettings.infill !== undefined && Number(userSettings.infill) !== DEFAULT_SETTINGS.infill) {
    diff.infill = Number(userSettings.infill);
  }
  if (userSettings.layerHeight !== undefined && Number(userSettings.layerHeight) !== DEFAULT_SETTINGS.layerHeight) {
    diff.layerHeight = Number(userSettings.layerHeight);
  }
  if (userSettings.material && userSettings.material !== DEFAULT_SETTINGS.material) {
    diff.material = userSettings.material;
  }
  if (userSettings.supports && userSettings.supports !== DEFAULT_SETTINGS.supports) {
    diff.supports = userSettings.supports;
  }
  if (userSettings.color && userSettings.color !== DEFAULT_SETTINGS.color) {
    diff.color = userSettings.color;
  }

  return diff;
}

/**
 * Mask student emails for public queue view (e.g. "jo***@purdue.edu")
 */
function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') return '';
  const atIdx = email.indexOf('@');
  if (atIdx === -1) return '***@purdue.edu';
  const name = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (name.length <= 2) {
    return `${name.charAt(0)}***@${domain}`;
  }
  return `${name.slice(0, 2)}***@${domain}`;
}

function sanitizeJobForPublic(job: PrintJobRecord) {
  // fileUrl points at PocketBase storage; unless the file field is marked "Protected",
  // PocketBase serves it to anyone with the URL, so never expose it publicly.
  const { filePath, fileUrl, ...rest } = job;
  return {
    ...rest,
    email: maskEmail(job.email),
  };
}

function sanitizeJobForOperator(job: PrintJobRecord) {
  const { filePath, ...rest } = job;
  return rest;
}

/**
 * Verify whether incoming request is from an authenticated operator.
 * Header-only: tokens in query strings leak into logs, history and Referer headers.
 */
async function checkOperatorAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return false;
  return await verifyOperatorToken(authHeader);
}

/**
 * Minimal fixed-window per-IP rate limiter.
 * NOTE: behind a reverse proxy, every request shares the proxy's IP; set TRUST_PROXY=true
 * to use the last X-Forwarded-For hop (the one appended by your proxy; earlier hops are client-controlled).
 */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, 5 * 60 * 1000);

function clientIp(req: Request, srv: { requestIP(r: Request): { address: string } | null }): string {
  if (process.env.TRUST_PROXY === 'true') {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return srv.requestIP(req)?.address || 'unknown';
}

/**
 * Validate STL header structure (Binary or ASCII)
 */
function isValidStlBuffer(buffer: Buffer): boolean {
  if (buffer.length < 84) return false;

  // Check ASCII STL (starts with "solid" case-insensitively)
  const headerStr = buffer.subarray(0, 80).toString('utf8').trim().toLowerCase();
  if (headerStr.startsWith('solid')) {
    return true;
  }

  // Check Binary STL: 80 bytes header + 4 bytes uint32 triangle count (little-endian)
  const triangleCount = buffer.readUInt32LE(80);
  const expectedLength = 84 + (triangleCount * 50);
  if (expectedLength === buffer.length) {
    return true;
  }

  return false;
}

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_FILE_SIZE,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const ip = clientIp(req, srv);

    // Enable CORS for development
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    };

    try {
      // -------------------------------------------------------------
      // API: Health Check
      // -------------------------------------------------------------
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return Response.json({
          status: 'ok',
          service: 'PrintHive V1 API',
          devMode: isDev,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Send 6-digit verification code to Purdue Email
      // -------------------------------------------------------------
      if (url.pathname === '/api/auth/send-code' && req.method === 'POST') {
        // Per-IP limit stops one client from mailing many different addresses
        if (!rateLimit(`send:${ip}`, 10, 15 * 60 * 1000)) {
          return Response.json({ error: 'Too many requests. Please try again later.' }, { status: 429, headers: corsHeaders });
        }

        const body = await req.json().catch(() => ({}));
        const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();

        if (!email) {
          return Response.json({ error: 'Email address is required.' }, { status: 400, headers: corsHeaders });
        }

        // Domain validation: MUST match purdue.edu
        if (!isPurdueEmail(email)) {
          return Response.json({
            error: 'Submission rejected: Only @purdue.edu email addresses are authorized to submit 3D print jobs.',
          }, { status: 400, headers: corsHeaders });
        }

        // Rate limiting check
        const rateCheck = canRequestCode(email);
        if (!rateCheck.allowed) {
          return Response.json({
            error: rateCheck.message,
            retryAfterSeconds: rateCheck.retryAfterSeconds,
          }, { status: 429, headers: corsHeaders });
        }

        // Issue 6-digit code
        const code = issueVerificationCode(email);
        const mailResult = await sendVerificationEmail(email, code);

        if (!mailResult.success) {
          return Response.json({ error: 'Could not send the verification email. Please try again later.' }, { status: 502, headers: corsHeaders });
        }

        return Response.json({
          success: true,
          message: `Verification code sent to ${email}. Please check your inbox.`,
          devCode: isDev ? mailResult.devCode : undefined,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Verify 6-digit code
      // -------------------------------------------------------------
      if (url.pathname === '/api/auth/verify-code' && req.method === 'POST') {
        if (!rateLimit(`verify:${ip}`, 30, 15 * 60 * 1000)) {
          return Response.json({ error: 'Too many attempts. Please try again later.' }, { status: 429, headers: corsHeaders });
        }

        const body = await req.json().catch(() => ({}));
        const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
        const code = (typeof body.code === 'string' ? body.code : '').trim();

        if (!email || !code) {
          return Response.json({ error: 'Both email and 6-digit code are required.' }, { status: 400, headers: corsHeaders });
        }

        if (!isPurdueEmail(email)) {
          return Response.json({ error: 'Email must be a valid @purdue.edu address.' }, { status: 400, headers: corsHeaders });
        }

        const result = verifyCode(email, code);
        if (!result.valid) {
          return Response.json({
            valid: false,
            error: result.message || "Code doesn't match. Please try again.",
          }, { status: 400, headers: corsHeaders });
        }

        return Response.json({
          valid: true,
          message: 'Purdue email verified successfully.',
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Operator Login (PocketBase 'users' auth collection)
      // -------------------------------------------------------------
      if (url.pathname === '/api/auth/operator/login' && req.method === 'POST') {
        if (!rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
          return Response.json({ error: 'Too many login attempts. Please try again later.' }, { status: 429, headers: corsHeaders });
        }

        const body = await req.json().catch(() => ({}));
        const identity = (typeof (body.identity ?? body.email) === 'string' ? (body.identity ?? body.email) : '').trim();
        // Don't trim passwords: leading/trailing spaces can be part of the password
        const password = typeof body.password === 'string' ? body.password : '';

        if (!identity || !password) {
          return Response.json({ error: 'Username/email and password are required.' }, { status: 400, headers: corsHeaders });
        }

        const result = await authenticateOperator(identity, password);
        if (!result.success) {
          return Response.json({ error: result.error || 'Invalid credentials' }, { status: 401, headers: corsHeaders });
        }

        return Response.json({
          success: true,
          token: result.token,
          user: result.user,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Verify Operator Session Token
      // -------------------------------------------------------------
      if (url.pathname === '/api/auth/operator/verify' && req.method === 'GET') {
        const isValid = await checkOperatorAuth(req);
        return Response.json({ valid: isValid }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Get Current Queue & Printing Status
      // (Student emails masked for public, full details for operators)
      // -------------------------------------------------------------
      if (url.pathname === '/api/jobs' && req.method === 'GET') {
        const isOperator = await checkOperatorAuth(req);
        const queueData = await getQueueJobs();

        if (!isOperator) {
          return Response.json({
            currentlyPrinting: queueData.currentlyPrinting.map(sanitizeJobForPublic),
            nextInQueue: queueData.nextInQueue.map(sanitizeJobForPublic),
            completed: queueData.completed.map(sanitizeJobForPublic),
            all: queueData.all.map(sanitizeJobForPublic),
            source: queueData.source,
          }, { headers: corsHeaders });
        }

        return Response.json({
          currentlyPrinting: queueData.currentlyPrinting.map(sanitizeJobForOperator),
          nextInQueue: queueData.nextInQueue.map(sanitizeJobForOperator),
          completed: queueData.completed.map(sanitizeJobForOperator),
          all: queueData.all.map(sanitizeJobForOperator),
          source: queueData.source,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Submit STL Print Job
      // -------------------------------------------------------------
      if (url.pathname === '/api/jobs' && req.method === 'POST') {
        const formData = await req.formData();
        const str = (key: string) => {
          const v = formData.get(key);
          return typeof v === 'string' ? v.trim() : '';
        };

        const file = formData.get('file') as File | null;
        const email = str('email').toLowerCase();
        const code = str('code');
        const rawTitle = str('title');
        const rawNotes = str('notes');

        // 1. Email domain check
        if (!isPurdueEmail(email)) {
          return Response.json({
            error: 'Submission rejected: You must use a valid @purdue.edu email address.',
          }, { status: 400, headers: corsHeaders });
        }

        // 2. 6-digit code verification check. The code is always required here, so knowing
        //    that someone else just verified their email isn't enough to submit as them.
        const verifyResult = verifyCode(email, code);
        if (!verifyResult.valid || !isEmailVerified(email)) {
          return Response.json({
            error: verifyResult.message || "Verification code doesn't match.",
          }, { status: 400, headers: corsHeaders });
        }

        // 3. File validation
        if (!file || typeof file === 'string' || file.size === 0) {
          return Response.json({ error: 'Please upload a valid .STL file.' }, { status: 400, headers: corsHeaders });
        }

        if (file.size > MAX_FILE_SIZE) {
          return Response.json({ error: 'File size exceeds maximum limit of 50MB.' }, { status: 400, headers: corsHeaders });
        }

        if (!file.name.toLowerCase().endsWith('.stl')) {
          return Response.json({ error: 'File format not supported. Only .STL 3D files are accepted.' }, { status: 400, headers: corsHeaders });
        }

        // Read file buffer
        const arrayBuffer = await file.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);

        // STL header structure validation
        if (!isValidStlBuffer(fileBuffer)) {
          return Response.json({ error: 'Invalid or corrupted STL file. Please check your exported 3D model.' }, { status: 400, headers: corsHeaders });
        }

        // Sanitize strings
        const title = rawTitle.slice(0, 100);
        const notes = rawNotes.slice(0, 500);

        // Extract and validate settings
        let infill = Number(formData.get('infill') ?? DEFAULT_SETTINGS.infill);
        if (isNaN(infill) || infill < 0 || infill > 100) infill = DEFAULT_SETTINGS.infill;

        let layerHeight = Number(formData.get('layerHeight') ?? DEFAULT_SETTINGS.layerHeight);
        if (isNaN(layerHeight) || layerHeight < 0.05 || layerHeight > 1.0) layerHeight = DEFAULT_SETTINGS.layerHeight;

        const rawMaterial = str('material');
        const material = ALLOWED_MATERIALS.includes(rawMaterial) ? rawMaterial : DEFAULT_SETTINGS.material;

        const rawSupports = str('supports').toLowerCase();
        const supports = ALLOWED_SUPPORTS.includes(rawSupports) ? rawSupports : DEFAULT_SETTINGS.supports;

        const rawColor = str('color').slice(0, 30);
        const color = rawColor || DEFAULT_SETTINGS.color;

        const userSettings = { infill, layerHeight, material, supports, color };
        const settingsDiff = calculateSettingsDiff(userSettings);

        const newJob = await createJob({
          title: title || file.name.replace(/\.stl$/i, ''),
          email,
          fileBuffer,
          fileName: file.name,
          fileSize: file.size,
          settingsDiff,
          settingsFull: userSettings,
          notes,
        });

        // Mark verification used
        consumeVerification(email);

        return Response.json({
          success: true,
          message: 'Print job added to queue!',
          job: sanitizeJobForPublic(newJob),
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Update Job Status (Operator Protected)
      // -------------------------------------------------------------
      const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (statusMatch && (req.method === 'POST' || req.method === 'PATCH')) {
        // Enforce operator authentication
        const isOperator = await checkOperatorAuth(req);
        if (!isOperator) {
          return Response.json({ error: 'Unauthorized: Operator authorization required.' }, { status: 401, headers: corsHeaders });
        }

        const jobId = statusMatch[1];
        const body = await req.json().catch(() => ({}));
        const newStatus = body.status as 'queued' | 'printing' | 'completed' | 'cancelled';
        const rawPickupNotes = typeof body.pickupNotes === 'string' ? body.pickupNotes.trim() : undefined;
        const pickupNotes = rawPickupNotes ? rawPickupNotes.slice(0, 500) : undefined;

        if (!['queued', 'printing', 'completed', 'cancelled'].includes(newStatus)) {
          return Response.json({ error: 'Invalid status value.' }, { status: 400, headers: corsHeaders });
        }

        const existingJob = getJobById(jobId);
        const updatedJob = await updateJobStatus(jobId, newStatus);

        if (!updatedJob) {
          return Response.json({ error: 'Job not found.' }, { status: 404, headers: corsHeaders });
        }

        // If newly marked as completed, automatically notify student via email!
        if (newStatus === 'completed' && existingJob?.status !== 'completed') {
          console.log(`[Status] Job ${jobId} completed. Sending notification email to student...`);
          sendJobCompletedEmail(updatedJob.email, updatedJob.title, pickupNotes).catch((err) =>
            console.error('[Status] Email notification error:', err)
          );
        }

        return Response.json({
          success: true,
          job: sanitizeJobForOperator(updatedJob),
          notificationSent: newStatus === 'completed',
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Download STL File (Operator Protected)
      // -------------------------------------------------------------
      const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/file$/);
      if (downloadMatch && req.method === 'GET') {
        // Enforce operator authentication
        const isOperator = await checkOperatorAuth(req);
        if (!isOperator) {
          return Response.json({ error: 'Unauthorized: Operator authorization required to download STL files.' }, { status: 401, headers: corsHeaders });
        }

        const jobId = downloadMatch[1];
        const job = getJobById(jobId);

        if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
          return Response.json({ error: 'File not found on server.' }, { status: 404, headers: corsHeaders });
        }

        // Prevent path traversal
        const uploadsDir = path.resolve(process.cwd(), 'uploads');
        const resolvedPath = path.resolve(job.filePath);
        if (!resolvedPath.startsWith(uploadsDir + path.sep)) {
          return Response.json({ error: 'Access denied.' }, { status: 403, headers: corsHeaders });
        }

        const safeFilename = path.basename(job.fileName).replace(/["\r\n\\]/g, '_');
        const encodedFilename = encodeURIComponent(path.basename(job.fileName));

        const fileStream = fs.createReadStream(resolvedPath);
        return new Response(fileStream as any, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }

      // -------------------------------------------------------------
      // Static File Serving (Production Build from dist/)
      // -------------------------------------------------------------
      const distDir = path.resolve(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        const reqPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const targetPath = path.resolve(distDir, reqPath);

        // Path containment check
        if (targetPath.startsWith(distDir + path.sep) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          return new Response(Bun.file(targetPath));
        }

        // SPA fallback to index.html
        const indexPath = path.join(distDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          return new Response(Bun.file(indexPath));
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Server Error]', err);
      return Response.json(
        { error: isDev ? (err.message || 'Internal Server Error') : 'An unexpected error occurred.' },
        { status: 500, headers: corsHeaders }
      );
    }
  },
});

console.log(`🚀 PrintHive V1 Server running at http://localhost:${PORT}`);
console.log(`📡 Connected to PocketBase at: ${process.env.POCKETBASE_URL || 'https://pocketbase.amcloud.dev'}`);
