import PocketBase from 'pocketbase';
import fs from 'node:fs';
import path from 'node:path';

export interface PrintJobRecord {
  id: string;
  title: string;
  email: string;
  fileName: string;
  fileUrl?: string;
  filePath?: string;
  fileSize: number;
  settingsDiff: Record<string, any>;
  settingsFull: Record<string, any>;
  status: 'queued' | 'printing' | 'completed' | 'cancelled';
  notes?: string;
  created: string;
  updated: string;
}

const pbUrl = process.env.POCKETBASE_URL || 'https://pocketbase.amcloud.dev';
const userEmail = process.env.POCKETBASE_USER_EMAIL || process.env.POCKETBASE_EMAIL || process.env.POCKETBASE_ADMIN_EMAIL || '';
const userPassword = process.env.POCKETBASE_USER_PASSWORD || process.env.POCKETBASE_PASSWORD || process.env.POCKETBASE_ADMIN_PASSWORD || '';
export const COLLECTION_NAME = process.env.POCKETBASE_COLLECTION || 'printhive_v1';

export const pb = new PocketBase(pbUrl);

// Data directory for local fallback persistence
const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function readLocalJobs(): PrintJobRecord[] {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = fs.readFileSync(JOBS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('[Storage] Error reading local jobs:', err);
  }
  return [];
}

function writeLocalJobs(jobs: PrintJobRecord[]) {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Storage] Error writing local jobs:', err);
  }
}

let isPbAuthenticated = false;

/**
 * Authenticate with PocketBase using the standard 'users' auth collection
 */
export async function initPocketBase(): Promise<boolean> {
  if (!userEmail || !userPassword) {
    console.log('[PocketBase] No user credentials configured in .env. Will attempt public access or local fallback.');
    return false;
  }

  try {
    // Authenticate using the standard 'users' collection
    await pb.collection('users').authWithPassword(userEmail, userPassword);
    isPbAuthenticated = true;
    console.log(`[PocketBase] Successfully authenticated via 'users' collection: ${userEmail}`);
    return true;
  } catch (err: any) {
    console.warn(`[PocketBase] 'users' authentication failed: ${err.message}. Running in hybrid mode.`);
    return false;
  }
}

/**
 * Ensure PocketBase auth token is valid before database operations
 */
export async function ensureAuth(): Promise<void> {
  if (userEmail && userPassword && !pb.authStore.isValid) {
    await initPocketBase();
  }
}

/**
 * Fetch all print jobs from PocketBase or local store
 */
export async function getQueueJobs(): Promise<{
  currentlyPrinting: PrintJobRecord[];
  nextInQueue: PrintJobRecord[];
  completed: PrintJobRecord[];
  all: PrintJobRecord[];
  source: 'pocketbase' | 'local';
}> {
  // Try PocketBase first
  try {
    await ensureAuth();
    const records = await pb.collection(COLLECTION_NAME).getFullList({
      sort: '+created',
    });

    if (records && records.length > 0) {
      const all: PrintJobRecord[] = records.map((r: any) => {
        let diff = {};
        let full = {};
        try {
          diff = typeof r.settings_diff === 'string' ? JSON.parse(r.settings_diff) : r.settings_diff || {};
        } catch {}
        try {
          full = typeof r.settings_full === 'string' ? JSON.parse(r.settings_full) : r.settings_full || {};
        } catch {}

        const fileToken = r.file;
        const fileUrl = fileToken ? pb.files.getURL(r, fileToken) : undefined;

        return {
          id: r.id,
          title: r.title || 'Untitled Part',
          email: r.email,
          fileName: r.file || 'model.stl',
          fileUrl,
          fileSize: r.file_size || 0,
          settingsDiff: diff,
          settingsFull: full,
          status: r.status || 'queued',
          notes: r.notes || '',
          created: r.created,
          updated: r.updated,
        };
      });

      const currentlyPrinting = all.filter((j) => j.status === 'printing');
      const nextInQueue = all.filter((j) => j.status === 'queued');
      const completed = all.filter((j) => j.status === 'completed');

      return {
        currentlyPrinting,
        nextInQueue,
        completed,
        all,
        source: 'pocketbase',
      };
    }
  } catch (err: any) {
    // If PocketBase fetch fails, use local backup
  }

  // Fallback to local store
  const localJobs = readLocalJobs();
  const currentlyPrinting = localJobs.filter((j) => j.status === 'printing');
  const nextInQueue = localJobs.filter((j) => j.status === 'queued');
  const completed = localJobs.filter((j) => j.status === 'completed');

  return {
    currentlyPrinting,
    nextInQueue,
    completed,
    all: localJobs,
    source: 'local',
  };
}

/**
 * Save new print job to PocketBase (with local store fallback)
 */
export async function createJob(params: {
  title: string;
  email: string;
  fileBuffer: Buffer;
  fileName: string;
  fileSize: number;
  settingsDiff: Record<string, any>;
  settingsFull: Record<string, any>;
  notes?: string;
}): Promise<PrintJobRecord> {
  const localId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString();
  
  // Save file locally as well
  const safeFileName = `${localId}_${params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const localFilePath = path.join(UPLOADS_DIR, safeFileName);
  fs.writeFileSync(localFilePath, params.fileBuffer);

  const localJob: PrintJobRecord = {
    id: localId,
    title: params.title || params.fileName.replace(/\.stl$/i, ''),
    email: params.email,
    fileName: params.fileName,
    filePath: localFilePath,
    fileSize: params.fileSize,
    settingsDiff: params.settingsDiff,
    settingsFull: params.settingsFull,
    status: 'queued',
    notes: params.notes || '',
    created: now,
    updated: now,
  };

  // Attempt PocketBase create
  try {
    await ensureAuth();
    const formData = new FormData();
    formData.append('title', localJob.title);
    formData.append('email', localJob.email);
    formData.append('status', 'queued');
    formData.append('settings_diff', JSON.stringify(params.settingsDiff));
    formData.append('settings_full', JSON.stringify(params.settingsFull));
    if (params.notes) formData.append('notes', params.notes);
    
    // Convert Buffer to Blob for PocketBase FormData upload
    const blob = new Blob([params.fileBuffer], { type: 'application/octet-stream' });
    formData.append('file', blob, params.fileName);

    const pbRecord = await pb.collection(COLLECTION_NAME).create(formData);
    
    if (pbRecord) {
      localJob.id = pbRecord.id;
      localJob.fileUrl = pb.files.getURL(pbRecord, pbRecord.file);
      console.log(`[PocketBase] Successfully created job record: ${pbRecord.id}`);
    }
  } catch (err: any) {
    console.warn(`[PocketBase] Remote record creation skipped or failed: ${err.message}. Stored in resilient local queue.`);
  }

  // Persist to local backup
  const allJobs = readLocalJobs();
  allJobs.push(localJob);
  writeLocalJobs(allJobs);

  return localJob;
}

/**
 * Update the status of a print job
 */
export async function updateJobStatus(
  id: string,
  newStatus: 'queued' | 'printing' | 'completed' | 'cancelled'
): Promise<PrintJobRecord | null> {
  const allJobs = readLocalJobs();
  const job = allJobs.find((j) => j.id === id);

  if (job) {
    job.status = newStatus;
    job.updated = new Date().toISOString();
    writeLocalJobs(allJobs);
  }

  // Update in PocketBase if possible
  try {
    await ensureAuth();
    if (newStatus === 'cancelled') {
      try {
        const updated = await pb.collection(COLLECTION_NAME).update(id, { status: newStatus });
        if (updated && job) job.updated = updated.updated;
      } catch {
        // If PocketBase schema doesn't have 'cancelled' in its select values, delete the record from queue
        await pb.collection(COLLECTION_NAME).delete(id).catch(() => {});
      }
    } else {
      const updated = await pb.collection(COLLECTION_NAME).update(id, {
        status: newStatus,
      });
      if (updated && job) {
        job.updated = updated.updated;
      }
    }
  } catch (err: any) {
    // PocketBase update warning
  }

  return job || null;
}

/**
 * Get job by ID
 */
export function getJobById(id: string): PrintJobRecord | null {
  const allJobs = readLocalJobs();
  return allJobs.find((j) => j.id === id) || null;
}

/**
 * Authenticate staff operator using PocketBase 'users' collection
 */
export async function authenticateOperator(
  identity: string,
  password: string
): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
  try {
    const res = await fetch(`${pbUrl}/api/collections/users/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, password }),
    });

    const data: any = await res.json();
    if (!res.ok) {
      return {
        success: false,
        error: data.message || 'Invalid username/email or password.',
      };
    }

    return {
      success: true,
      token: data.token,
      user: {
        id: data.record.id,
        email: data.record.email,
        name: data.record.name || data.record.email,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: 'Failed to connect to PocketBase authentication service.',
    };
  }
}

/**
 * Verify whether an operator token is valid with PocketBase 'users' auth
 */
export async function verifyOperatorToken(authHeader: string): Promise<boolean> {
  if (!authHeader) return false;
  try {
    const cleanToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) return false;

    const res = await fetch(`${pbUrl}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: cleanToken,
      },
    });

    return res.ok;
  } catch {
    return false;
  }
}

