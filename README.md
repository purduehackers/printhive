# PrintHive Simple (Purdue 3D Print Queue)

A streamlined, modern 3D print queue and submission portal built specifically for university makerspaces (Purdue University).

Replaces the complex optimization engine of PH-printingv2 with a clean, fast, and intuitive queue workflow.

---

## Key Features

1. **Purdue Domain Protection (`@purdue.edu`)**:
   - Strictly enforces that only `@purdue.edu` email addresses can submit 3D print jobs.
   - Non-Purdue domains are rejected immediately with a friendly alert.

2. **6-Digit Email Verification (OTP)**:
   - When a valid Purdue email is entered, a secure 6-digit code is dispatched via email (or logged to terminal in dev mode).
   - Verifies the code before allowing the print job to be submitted to the queue.
   - If the code is incorrect, alerts the user and waits for the correct code.

3. **STL File Upload & Interactive 3D Preview**:
   - Drag-and-drop or select any `.stl` model.
   - Built-in Three.js WebGL canvas provides instant 3D model rotation, mesh statistics, and bounding box dimensions (X × Y × Z mm).

4. **Basic Settings & Non-Default Storage**:
   - Presets for Infill (20% default), Layer Height (0.20mm default), Material (PLA default), and Supports (None default).
   - Only **non-default settings** are saved to the database (e.g. `{"infill": 35, "material": "PETG"}`), keeping records lightweight and clear.

5. **PocketBase Integration (`pocketbase.amcloud.dev`)**:
   - Direct integration with PocketBase server for persistent storage of print jobs, STL files, and settings.
   - Includes local storage fallback with zero-downtime queue resilience.

6. **Live Queue & Real-Time Status**:
   - **Currently Printing**: Highlights active prints with elapsed timers, submitter email, and non-default settings.
   - **Next in Queue**: Ordered waiting list (#1 Next Up, #2, #3...) with timestamps.
   - **Completed Prints**: Displays recently completed prints.

7. **Operator Desk & Automatic Completion Notifications**:
   - Staff can start printing, download STL models directly for slicing, and mark prints as completed with 1 click.
   - When marked as completed, an automated email notification is sent to the student informing them that their part is ready for pickup!

---

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) (v1.3+)
- **Frontend**: React 19, Tailwind CSS v4, Three.js, Lucide Icons
- **Bundler**: Vite 8
- **Backend**: Bun.serve native HTTP server & API
- **Database**: [PocketBase](https://pocketbase.io) (`https://pocketbase.amcloud.dev`)
- **Mailer**: Nodemailer (SMTP with Dev/Console fallback)

---

## Quick Start

### 1. Install Dependencies
```bash
bun install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure your environment variables in `.env`:
```env
# Server
PORT=3001
NODE_ENV=development
DEV_MODE=true

# PocketBase
POCKETBASE_URL=https://pocketbase.amcloud.dev
POCKETBASE_ADMIN_EMAIL=admin@amcloud.dev
POCKETBASE_ADMIN_PASSWORD=your_password

# Email Notifications (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@purdue.edu
SMTP_PASSWORD=your_app_password
SMTP_FROM="PrintHive Purdue <noreply@purdue.edu>"
```

> **Note for Local Testing**: If SMTP credentials are empty or `DEV_MODE=true`, verification codes and completion notices are printed directly to the server terminal and displayed in a handy dev toast on the web page.

### 3. Run in Development Mode
```bash
bun run dev
```
- Web UI: [http://localhost:3000](http://localhost:3000)
- API Server: [http://localhost:3001](http://localhost:3001)

### 4. Build and Run in Production
```bash
bun run build
bun start
```
The unified server will serve both the web application and the API at [http://localhost:3001](http://localhost:3001).

---

## API Reference

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Health check and server status |
| `/api/auth/send-code` | `POST` | Validates Purdue email and dispatches 6-digit code |
| `/api/auth/verify-code` | `POST` | Validates entered 6-digit verification code |
| `/api/jobs` | `GET` | Returns currently printing, next in queue, and completed jobs |
| `/api/jobs` | `POST` | Uploads STL, verifies code, and adds job to queue |
| `/api/jobs/:id/status` | `POST` | Updates job status (`printing`, `completed`, `cancelled`) and triggers completion email |
| `/api/jobs/:id/file` | `GET` | Downloads the uploaded STL file |

---

## License
MIT
