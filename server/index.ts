import path from 'node:path';
import fs from 'node:fs';
import { isPurdueEmail, issueVerificationCode, verifyCode, isEmailVerified, consumeVerification } from './verification';
import { sendVerificationEmail, sendJobCompletedEmail } from './mailer';
import { initPocketBase, getQueueJobs, createJob, updateJobStatus, getJobById } from './pocketbase';

const PORT = parseInt(process.env.PORT || '3001', 10);
const isDev = process.env.NODE_ENV !== 'production';

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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

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
    };

    try {
      // -------------------------------------------------------------
      // API: Health Check
      // -------------------------------------------------------------
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return Response.json({
          status: 'ok',
          service: 'PrintHive Simple API',
          pocketbaseUrl: process.env.POCKETBASE_URL || 'https://pocketbase.amcloud.dev',
          devMode: isDev,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Send 6-digit verification code to Purdue Email
      // -------------------------------------------------------------
      if (url.pathname === '/api/auth/send-code' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const email = (body.email || '').trim().toLowerCase();

        if (!email) {
          return Response.json({ error: 'Email address is required.' }, { status: 400, headers: corsHeaders });
        }

        // Domain validation: MUST match purdue.edu
        if (!isPurdueEmail(email)) {
          return Response.json({
            error: 'Submission rejected: Only @purdue.edu email addresses are authorized to submit 3D print jobs.',
          }, { status: 400, headers: corsHeaders });
        }

        // Issue 6-digit code
        const code = issueVerificationCode(email);
        const mailResult = await sendVerificationEmail(email, code);

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
        const body = await req.json().catch(() => ({}));
        const email = (body.email || '').trim().toLowerCase();
        const code = (body.code || '').trim();

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
      // API: Get Current Queue & Printing Status
      // -------------------------------------------------------------
      if (url.pathname === '/api/jobs' && req.method === 'GET') {
        const queueData = await getQueueJobs();
        return Response.json(queueData, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Submit STL Print Job
      // -------------------------------------------------------------
      if (url.pathname === '/api/jobs' && req.method === 'POST') {
        const formData = await req.formData();
        
        const file = formData.get('file') as File | null;
        const email = ((formData.get('email') as string) || '').trim().toLowerCase();
        const code = ((formData.get('code') as string) || '').trim();
        const title = ((formData.get('title') as string) || '').trim();
        const notes = ((formData.get('notes') as string) || '').trim();

        // 1. Email domain check
        if (!isPurdueEmail(email)) {
          return Response.json({
            error: 'Submission rejected: You must use a valid @purdue.edu email address.',
          }, { status: 400, headers: corsHeaders });
        }

        // 2. 6-digit code verification check
        if (!isEmailVerified(email)) {
          const verifyResult = verifyCode(email, code);
          if (!verifyResult.valid) {
            return Response.json({
              error: verifyResult.message || "Verification code doesn't match.",
            }, { status: 400, headers: corsHeaders });
          }
        }

        // 3. File validation
        if (!file || typeof file === 'string' || file.size === 0) {
          return Response.json({ error: 'Please upload a valid .STL file.' }, { status: 400, headers: corsHeaders });
        }

        if (!file.name.toLowerCase().endsWith('.stl')) {
          return Response.json({ error: 'File format not supported. Only .STL 3D files are accepted.' }, { status: 400, headers: corsHeaders });
        }

        // Extract settings
        const infill = formData.get('infill') ? Number(formData.get('infill')) : DEFAULT_SETTINGS.infill;
        const layerHeight = formData.get('layerHeight') ? Number(formData.get('layerHeight')) : DEFAULT_SETTINGS.layerHeight;
        const material = (formData.get('material') as string) || DEFAULT_SETTINGS.material;
        const supports = (formData.get('supports') as string) || DEFAULT_SETTINGS.supports;
        const color = (formData.get('color') as string) || DEFAULT_SETTINGS.color;

        const userSettings = { infill, layerHeight, material, supports, color };
        const settingsDiff = calculateSettingsDiff(userSettings);

        // Read file buffer
        const arrayBuffer = await file.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);

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
          job: newJob,
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Update Job Status (Start print, Mark complete, etc.)
      // -------------------------------------------------------------
      const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
      if (statusMatch && (req.method === 'POST' || req.method === 'PATCH')) {
        const jobId = statusMatch[1];
        const body = await req.json().catch(() => ({}));
        const newStatus = body.status as 'queued' | 'printing' | 'completed' | 'cancelled';
        const pickupNotes = body.pickupNotes as string | undefined;

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
          console.log(`[Status] Job ${jobId} completed. Sending notification email to ${updatedJob.email}...`);
          sendJobCompletedEmail(updatedJob.email, updatedJob.title, pickupNotes).catch((err) =>
            console.error('[Status] Email notification error:', err)
          );
        }

        return Response.json({
          success: true,
          job: updatedJob,
          notificationSent: newStatus === 'completed',
        }, { headers: corsHeaders });
      }

      // -------------------------------------------------------------
      // API: Download STL File
      // -------------------------------------------------------------
      const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/file$/);
      if (downloadMatch && req.method === 'GET') {
        const jobId = downloadMatch[1];
        const job = getJobById(jobId);

        if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
          return Response.json({ error: 'File not found on server.' }, { status: 404, headers: corsHeaders });
        }

        const fileStream = fs.createReadStream(job.filePath);
        return new Response(fileStream as any, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${job.fileName}"`,
          },
        });
      }

      // -------------------------------------------------------------
      // Static File Serving (Production Build from dist/)
      // -------------------------------------------------------------
      const distDir = path.resolve(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        let filePath = path.join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
        if (!fs.existsSync(filePath)) {
          filePath = path.join(distDir, 'index.html');
        }
        if (fs.existsSync(filePath)) {
          const file = Bun.file(filePath);
          return new Response(file);
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Server Error]', err);
      return Response.json({ error: err.message || 'Internal Server Error' }, { status: 500, headers: corsHeaders });
    }
  },
});

console.log(`🚀 PrintHive Simple Server running at http://localhost:${PORT}`);
console.log(`📡 Connected to PocketBase at: ${process.env.POCKETBASE_URL || 'https://pocketbase.amcloud.dev'}`);
