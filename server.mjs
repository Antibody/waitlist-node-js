// server.mjs
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import pg from 'pg';
const { Pool } = pg;

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const sessionSecret = process.env.CRON_AUTH_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const resendSenderEmail = process.env.RESEND_SENDER_EMAIL;
const allowedAdminEmail = process.env.ADMIN_ALLOWED_EMAIL;
const databaseUrl = process.env.DATABASE_URL;

if (!supabaseUrl || !supabaseKey || !sessionSecret || !databaseUrl) {
  console.error('🔴 Error: SUPABASE_URL, SUPABASE_ANON_KEY, CRON_AUTH_TOKEN, and DATABASE_URL must be set in the .env file');
  process.exit(1);
}

if (!resendApiKey || !resendSenderEmail) {
  console.warn('⚠️ Warning: RESEND_API_KEY or RESEND_SENDER_EMAIL not set. Email reminders will fail.');
}

const supabase = createClient(supabaseUrl, supabaseKey);
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const pool = new Pool({ connectionString: databaseUrl });

/* TELEMETRY CONFIGURATION AND HELPER FUNCTION */

const TELEMETRY_SERVER_URL = process.env.TELEMETRY_SERVER_URL;
if (!TELEMETRY_SERVER_URL) {
  console.warn("⚠️ TELEMETRY_SERVER_URL not set. Telemetry logs will not be sent.");
}

/**
 * Sends a telemetry event to an external telemetry server.
 * The event will not be sent if:
 *  - ALLOW_TELEMETRY is set to "FALSE" (case-insensitive),
 *  - RESEND_SENDER_EMAIL ends with "@resend.dev", or
 *  - The domain (provided in payload.domain) starts with "localhost" or "127.0.0.1".
 *
 * @param {string} eventType - The type of telemetry event (e.g., "userSignup", "error").
 * @param {object} payload - Additional event data. Must include a `domain` property where appropriate.
 */
 async function sendTelemetryEvent(eventType, payload) {
   // Apply disabling rules before sending
  if (process.env.ALLOW_TELEMETRY && process.env.ALLOW_TELEMETRY.toUpperCase() === "FALSE") {
     console.log("Telemetry disabled: ALLOW_TELEMETRY is set to FALSE");
     return;
   }
 
   // Disable telemetry if RESEND_SENDER_EMAIL ends with "@resend.dev".
   if (resendSenderEmail && resendSenderEmail.endsWith('@resend.dev')) {
     console.log("Telemetry disabled: RESEND_SENDER_EMAIL ends with @resend.dev");
     return;
   }
 
   // Disable telemetry if the domain is localhost or 127.0.0.1.
   // Ensure payload.domain exists before checking its value
   if (payload && payload.domain && (payload.domain.startsWith("localhost") || payload.domain.startsWith("127.0.0.1"))) {
     console.log(`Telemetry disabled: domain is ${payload.domain}`);
     return;
   } 
 
   // Construct the telemetry payload.
   const telemetryData = {
     eventType,
     timestamp: new Date().toISOString(),
     ...payload,
   };
  console.log("Telemetry event:", telemetryData);
  
  if (TELEMETRY_SERVER_URL) {
    try {
      // Asynchronously send telemetry data to the external telemetry server.
      await fetch(TELEMETRY_SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetryData),
      });
    } catch (err) {
      console.error("Error sending telemetry event:", err);
    }
  }
}



const app = express();
app.set('trust proxy', 1);

// Force HTTPS in production so that secure cookies can be set/used
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.protocol !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Basic helmet setup
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
    },
  })
);


/* const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
})); */

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Configure your session
app.use(
  session({
    name: 'waitlist-session',
    secret: process.env.CRON_AUTH_TOKEN || 'some-secret',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      // For Cloud Run with HTTPS, use secure: true
      secure: process.env.NODE_ENV === 'production',
      // Set to 'none' so cross-site requests can include the cookie
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      httpOnly: true, // Usually better to keep this true
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// Serve static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


let isWaitlistTableChecked = false;
let waitlistTableExists = false;

async function checkWaitlistTableExists() {
  if (isWaitlistTableChecked) {
    return waitlistTableExists;
  }
  try {
    const result = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'waitlist');"
    );
    waitlistTableExists = result.rows[0].exists;
    isWaitlistTableChecked = true;
    console.log(`Waitlist table exists check: ${waitlistTableExists}`);
     return waitlistTableExists;
   } catch (error) {
     console.error('🔴 Error checking if waitlist table exists:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: 'server-internal', // Or derive domain if possible/relevant
       message: "Error checking if waitlist table exists",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
     });
     waitlistTableExists = false;
     isWaitlistTableChecked = true;
     return false;
  }
}

app.use((req, res, next) => {
  isWaitlistTableChecked = false;
  next();
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────── Authentication Middleware ───────────
const requireAuth = async (req, res, next) => {
  console.log(`Auth check for: ${req.method} ${req.originalUrl}`);
  console.log('Cookies:', req.cookies);
  console.log('Session ID from cookie (waitlist-session):', req.cookies['waitlist-session']);
  console.log('Session object:', req.session);

  // If session or user is missing, fail
  if (!req.session || !req.session.user || req.session.user.email !== process.env.ADMIN_ALLOWED_EMAIL) {
    console.log('Auth check FAILED:', req.session?.user || 'No user in session');
    if (req.accepts('html')) {
      console.log('Redirecting to /login.html due to auth failure.');
      return res.redirect('/login.html');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const tableExists = await checkWaitlistTableExists();

    const isSetupRoute =
      req.originalUrl === '/date-time-setter.html' ||
      req.originalUrl.startsWith('/api/admin/check-setup-status') ||
      req.originalUrl.startsWith('/api/admin/validate');

  if (!tableExists && !isSetupRoute) {
      console.log(`Auth check: Table 'waitlist' does not exist. Redirecting to setup.`);
      if (req.accepts('html')) {
        // Currently: do a redirect => res.redirect(...)
        // Instead, return JSON
        return res.status(409).json({ setupRequired: true });
      } else {
        // For JSON request
        return res.status(409).json({ error: 'Setup required. Waitlist table not found.' });
      }
}


    console.log(`Auth check PASSED for session: ${req.sessionID}, User: ${req.session.user.email}. Table exists: ${tableExists}, Is setup route: ${isSetupRoute}`);
     return next();
   } catch (error) {
     console.error('🔴 Error during table existence check in requireAuth:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Error during table existence check in requireAuth",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
     });
     return res.status(500).json({ error: 'Internal server error during authentication check.' });
  }
};

// Explicitly handle /admin route with auth and redirect
app.get('/admin', requireAuth, (req, res) => {
  // If requireAuth passes, redirect to the actual HTML file
  res.redirect('/admin.html');
});

app.get('/admin.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/date-time-setter.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'date-time-setter.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  extensions: ['html']
  // Removed setHeaders for debugging
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});


//############# API endpoints ####################

// Create "waitlist" table if it does not exist and add users to it
app.post('/api/waitlist', async (req, res) => {
  const domain = req.headers.host || 'unknown'; // <-- capture the domain for telemetry
  const signupStartTime = Date.now();

   const tableExists = await checkWaitlistTableExists();
   if (!tableExists) {
     console.warn("Public signup attempt failed: Waitlist table does not exist yet.");
     // Send telemetry for this specific failure condition
     sendTelemetryEvent("error", {
       domain,
       message: "Public signup attempt failed: Waitlist table does not exist",
       errorName: "SetupIncompleteError", // Custom error name
       errorMessage: "Waitlist table does not exist yet.",
       route: req.originalUrl,
       method: req.method,
     });
     return res.status(503).json({ error: "Waitlist signups are not available yet. Please check back later." });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  try {
    // Retrieve the admin row (first row) to copy its launch_date
    const { data: firstRow, error: firstRowError } = await supabase
      .from("waitlist")
      .select("launch_date")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (firstRowError) {
      console.error("Error fetching the first waitlist row:", firstRowError);
      return res.status(500).json({ error: "Failed to fetch launch_date" });
    }

    if (!firstRow || !firstRow.launch_date) {
      console.error("No launch_date found. Ensure the admin row has a valid launch_date.");
      return res.status(500).json({
        error: "No launch_date found. Please ensure the table's first row has a valid launch_date."
      });
    }
    const launchDate = firstRow.launch_date;

    // Insert new user into the waitlist, copying the launch_date from admin
    const { error } = await supabase
      .from("waitlist")
      .insert([{ email, launch_date: launchDate }]);
    if (error) {
      console.error("Supabase insert error:", error);
      if (error.code === "23505") {
        // Duplicate email detected.
        // Query the waitlist to get the current signup rank for this email.
        const duplicateRankResult = await pool.query(
          `SELECT rank
           FROM (
             SELECT email, created_at,
                    RANK() OVER (ORDER BY created_at ASC) AS rank
             FROM public.waitlist
           ) tmp
           WHERE tmp.email = $1;`,
          [email]
        );
        if (duplicateRankResult.rowCount === 0) {
          return res.status(409).json({ error: "Email already exists", duplicate: true });
        }
        const { rank } = duplicateRankResult.rows[0];
        return res.status(409).json({ error: "Email already exists", duplicate: true, rank });
      }
      return res.status(500).json({ error: "Failed to add email to waitlist" });
    }

    // Now compute the signup rank using a window function.
    // The earliest created_at gets rank 1, the next rank 2, etc.
    const result = await pool.query(
      `SELECT rank
       FROM (
         SELECT email, created_at,
                RANK() OVER (ORDER BY created_at ASC) AS rank
         FROM public.waitlist
       ) tmp
       WHERE tmp.email = $1;`,
      [email]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Email not found in waitlist" });
    }

    const { rank } = result.rows[0];

    // /* TELEMETRY: Calculate signup latency and use the rank (user count from waitlist) as signupCount */
    const signupLatency = Date.now() - signupStartTime;
    sendTelemetryEvent("userSignup", { domain, signupCount: rank, signupLatency });

     return res.status(200).json({ message: "Email added to waitlist!", rank });
   } catch (error) {
     console.error("Server error in /api/waitlist:", error);
     // Ensure consistent telemetry payload
     sendTelemetryEvent("error", {
       domain,
       message: "Internal server error in /api/waitlist",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
     });
     return res.status(500).json({ error: "Internal server error" });
  }
});




//Admins Login endpoint
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  // Check that the email matches your allowed admin email
  if (allowedAdminEmail && email !== allowedAdminEmail) {
    return res.status(401).json({ error: 'Invalid login credentials.' });
  }

  // Use Supabase authentication to check credentials
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
 
   if (error || !data.user) {
     console.error('Supabase login error:', error);
     // Send telemetry for login error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Supabase login error",
       errorName: error?.name || 'LoginError',
       errorMessage: error?.message || 'Invalid login credentials.',
       // Supabase auth errors might not have a standard stack, include code/status if available
       supabaseErrorCode: error?.code,
       supabaseErrorStatus: error?.status,
       route: req.originalUrl,
       method: req.method,
       attemptedEmail: email, // Include relevant context
     });
     return res.status(401).json({ error: error?.message || 'Invalid login credentials.' });
  }

  // If successful, store the user in session
  req.session.user = { id: data.user.id, email: data.user.email };
   req.session.save((err) => {
     if (err) {
       console.error('Session save error after login:', err);
       // Send telemetry for session save error
       sendTelemetryEvent("error", {
         domain: req.headers.host || 'unknown',
         message: "Session save error after login",
         errorName: err.name,
         errorMessage: err.message,
         stackTrace: err.stack,
         route: req.originalUrl,
         method: req.method,
         userEmail: data.user.email, // Include relevant context
       });
       return res.status(500).json({ error: 'Session save failed after login.' });
     }
     console.log(`Admin user logged in and session saved: ${data.user.email}, Session ID: ${req.sessionID}`);
    return res.status(200).json({ success: true });
  });
});


app.post('/api/logout', (req, res) => {
  const userEmail = req.session?.user?.email;
   req.session.destroy((err) => {
     if (err) {
       console.error('Session destruction error:', err);
       // Send telemetry for session destroy error
       sendTelemetryEvent("error", {
         domain: req.headers.host || 'unknown',
         message: "Session destruction error during logout",
         errorName: err.name,
         errorMessage: err.message,
         stackTrace: err.stack,
         route: req.originalUrl,
         method: req.method,
         userEmail: userEmail || 'Unknown user', // Include relevant context
       });
       return res.status(500).json({ error: 'Could not log out, please try again' });
     }
     res.clearCookie('waitlist-session');
    console.log(`User logged out: ${userEmail || 'Unknown user'}`);
    res.status(200).json({ message: 'Logout successful' });
  });
});

const adminApiRouter = express.Router();

adminApiRouter.get('/check-setup-status', requireAuth, async (req, res) => {
  try {
    const exists = await checkWaitlistTableExists();
     res.status(200).json({ setupComplete: exists });
   } catch (error) {
     console.error('🔴 Error in /check-setup-status:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Error in /check-setup-status",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
     });
     res.status(500).json({ error: 'Failed to check setup status' });
  }
});

// POST /api/validate - Initialize waitlist table, admin record, RLS policies (including anon INSERT), and cron jobs
adminApiRouter.post('/validate', requireAuth, async (req, res) => {
  // Optionally accept a launchDate from the request body.
  const { launchDate } = req.body;
  let launchDateISO = null;
  if (launchDate) {
    if (isNaN(new Date(launchDate).getTime())) {
      return res.status(400).json({ error: 'Invalid launch date format provided.' });
    }
    launchDateISO = new Date(launchDate).toISOString();
  }

  // Read admin email for RLS policies
  const allowedAdminEmail = process.env.ADMIN_ALLOWED_EMAIL;
  if (!allowedAdminEmail) {
    console.warn('ADMIN_ALLOWED_EMAIL not set. Waitlist RLS policies will not be created.');
  }

  // Connect to Postgres using the connection pool
  const client = await pool.connect();
  console.log("Starting waitlist initialization process...");

  try {
    await client.query('BEGIN');
    console.log("Transaction started.");

    // Create the waitlist table if it does not exist.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.waitlist (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        email text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
        launch_date timestamptz,
        reminder_sent boolean DEFAULT FALSE,
        CONSTRAINT waitlist_pkey PRIMARY KEY (id),
        CONSTRAINT waitlist_email_key UNIQUE (email)
      );
    `);
    console.log("Waitlist table ensured.");

    // Check if the admin record already exists.
    const result = await client.query(
      `SELECT id FROM public.waitlist 
       WHERE email = $1 
       ORDER BY created_at ASC 
       LIMIT 1;`,
      [allowedAdminEmail]
    );

    if (!result.rows.length) {
      // If no admin record exists, insert one.
      if (launchDateISO) {
        await client.query(
          'INSERT INTO public.waitlist (email, launch_date) VALUES ($1, $2);',
          [allowedAdminEmail, launchDateISO]
        );
      } else {
        await client.query(
          'INSERT INTO public.waitlist (email) VALUES ($1);',
          [allowedAdminEmail]
        );
      }
      console.log("Admin record inserted.");
    } else {
      console.log("Admin record already exists.");
    }

    await client.query('COMMIT');
    console.log("Transaction committed (table ensured and admin record processed).");

    // --- Enable RLS on waitlist table and create policies ---
    if (allowedAdminEmail) {
      await client.query('ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;'); // enable RLS
      console.log("RLS enabled for waitlist table.");
      await client.query('ALTER TABLE public.waitlist FORCE ROW LEVEL SECURITY;'); // force RLS
      console.log("RLS forced for waitlist table.");

      // Public read policy
      await client.query('DROP POLICY IF EXISTS "Allow public read access" ON public.waitlist;');
      await client.query(`
        CREATE POLICY "Allow public read access"
        ON public.waitlist
        FOR SELECT
        USING (true);
      `);
      console.log("Public read policy ensured for waitlist table.");

      // ## Admin full access policy
      await client.query('DROP POLICY IF EXISTS "Allow admin full access" ON public.waitlist;');
      await client.query(`
        CREATE POLICY "Allow admin full access"
        ON public.waitlist
        FOR ALL
        USING (auth.email() = '${allowedAdminEmail}')
        WITH CHECK (auth.email() = '${allowedAdminEmail}');
      `);
      console.log("Admin full access policy ensured for waitlist table.");

      // ## Public "INSERT" policy for anon role ##
      await client.query('DROP POLICY IF EXISTS "Allow public insert" ON public.waitlist;');
      await client.query(`
        CREATE POLICY "Allow public insert"
        ON public.waitlist
        FOR INSERT
        WITH CHECK (true);
      `);
      console.log("Public insert policy ensured for waitlist table.");
    }

    // ## Cron and extensions setup 
    console.log("Dropping pg_cron extension (if exists) with CASCADE...");
    await client.query('DROP EXTENSION IF EXISTS pg_cron CASCADE;');
    console.log("Recreating pg_cron extension in schema extensions...");
    await client.query('CREATE SCHEMA IF NOT EXISTS extensions;');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;');
    console.log("pg_cron extension ensured.");
    await delay(1000);

    console.log("Granting privileges on schema cron...");
    await client.query('GRANT USAGE ON SCHEMA cron TO postgres;');
    await client.query('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;');
    console.log("Privileges granted on schema cron.");
    await delay(500);

    console.log("Ensuring pg_net extension exists...");
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_net;');
    console.log("pg_net extension ensured.");
    await delay(500);

    // Schedule cron job with dynamic callback URL and auth token
    const reminderCallbackUrl = process.env.REMINDER_CALLBACK_URL
      || `https://${process.env.HOSTNAME || 'your-domain.com'}/api/admin/waitlist-reminders`;
    const fixedCronAuthToken = process.env.CRON_AUTH_TOKEN;

    if (!fixedCronAuthToken) {
      console.warn("⚠️ CRON_AUTH_TOKEN is not set. Cannot schedule reminder job securely.");
    }

    console.log(`Scheduling cron job to call ${reminderCallbackUrl}...`);
    const scheduleQuery = `
      SELECT cron.schedule(
        'waitlist-reminders',
        '*/15 * * * *',
        $$
          SELECT net.http_get(
            url := '${reminderCallbackUrl.replace(/'/g, "''")}',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ${fixedCronAuthToken?.replace(/'/g, "''")}'
            )
          ) AS request_id;
        $$
      );
    `;
    await client.query(scheduleQuery);
    console.log("Cron job 'waitlist-reminders' scheduled.");

    res.status(200).json({ message: 'Waitlist initialized successfully!' });
  } catch (sqlError) {
    console.error("🔴 Error during waitlist initialization:", sqlError);
    try {
      console.log("Attempting to rollback transaction...");
      await client.query('ROLLBACK');
      console.log("Transaction rolled back.");
    } catch (rollbackErr) {
      console.error("🔴 Failed to rollback transaction:", rollbackErr);
      sendTelemetryEvent("error", {
        domain: req.headers.host || 'unknown',
        message: "Failed to rollback transaction during waitlist initialization",
        errorName: rollbackErr.name,
        errorMessage: rollbackErr.message,
        stackTrace: rollbackErr.stack,
        route: req.originalUrl,
        method: req.method,
        originalError: sqlError.message,
      });
    }
    sendTelemetryEvent("error", {
      domain: req.headers.host || 'unknown',
      message: "Error during waitlist initialization",
      errorName: sqlError.name,
      errorMessage: sqlError.message,
      stackTrace: sqlError.stack,
      route: req.originalUrl,
      method: req.method,
    });
    res.status(500).json({ error: `Failed to initialize waitlist: ${sqlError.message}` });
  } finally {
    client.release();
    console.log("Database client released.");
  }
});




adminApiRouter.get('/get-launch-date', async (req, res) => {
  const tableExists = await checkWaitlistTableExists();
  if (!tableExists) {
      console.warn("/get-launch-date called but table doesn't exist (should have been caught by requireAuth).");
      return res.status(200).json({ launchDate: null });
  }
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .select('launch_date')
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('Supabase error fetching launch date:', error);
      throw new Error('Failed to fetch launch date from database');
    }
     res.status(200).json({ launchDate: data?.launch_date || null });
   } catch (error) {
     console.error('Error in /get-launch-date:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Error in /get-launch-date",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
     });
     res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

adminApiRouter.post('/set-launch-date', async (req, res) => {
  const { launchDate } = req.body;
  if (!launchDate) {
    return res.status(400).json({ error: 'Launch date is required' });
  }
  try {
    const isoLaunchDate = new Date(launchDate).toISOString();
    const { error } = await supabase
      .from('waitlist')
      .update({ launch_date: isoLaunchDate })
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      console.error("Supabase error updating launch date:", error);
      if (error.message.includes('permission denied')) {
         return res.status(403).json({ error: 'Permission denied. Server might need elevated privileges (Service Role Key) to update all rows.' });
      }
      return res.status(500).json({ error: 'Failed to update launch date in database' });
    }
    console.log(`Launch date successfully updated to: ${isoLaunchDate}`);
    res.status(200).json({ message: 'Launch date updated successfully' });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid Date')) {
        return res.status(400).json({ error: 'Invalid date format provided' });
     }
     console.error('Server error setting launch date:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Server error setting launch date",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
       providedLaunchDate: launchDate, // Include relevant context
     });
     res.status(500).json({ error: 'Failed to update launch date due to server error' });
  }
});

adminApiRouter.get('/get-all-waitlist', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('Supabase error fetching all waitlist entries:', error);
      throw new Error('Failed to fetch waitlist data');
    }
     res.status(200).json(data || []);
   } catch (error) {
     console.error('Error in /get-all-waitlist:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Error in /get-all-waitlist",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
     });
     res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// /toggle-reminders endpoint using express-session–based auth
adminApiRouter.post('/toggle-reminders', requireAuth, async (req, res) => {
  // At this point, requireAuth has ensured req.session.user.email === allowedAdminEmail

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch current reminder_sent flag for the admin record
    const { rows } = await client.query(
      `SELECT reminder_sent
         FROM public.waitlist
        WHERE email = $1
     ORDER BY created_at ASC
        LIMIT 1;`,
      [allowedAdminEmail]  // use the env var defined at top of server.mjs
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Admin record not found' });
    }

    const currentFlag = rows[0].reminder_sent;
    const newFlag = !currentFlag;  // toggle the flag

    // Apply the new flag to all waitlist records except the “zero” UUID
    await client.query(
      `UPDATE public.waitlist
          SET reminder_sent = $1
        WHERE id <> '00000000-0000-0000-0000-000000000000';`,
      [newFlag]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      message: `Reminder flags toggled successfully. New value: ${newFlag}`
    });
  } catch (sqlError) {
    console.error('Error toggling reminders:', sqlError);
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('Failed to ROLLBACK transaction after toggle error:', rbErr);
    }
    return res.status(500).json({
      error: `Failed to toggle reminder flags: ${sqlError instanceof Error ? sqlError.message : 'Unknown error'}`
    });
  } finally {
    client.release();
  }
});


// ── clear-waitlist endpoint ──
// Clears all records except the admin record (the first record with ADMIN_ALLOWED_EMAIL)
adminApiRouter.post('/clear-waitlist', async (req, res) => {
  try {
    // First, fetch the admin record (the first row with allowedAdminEmail)
    const { data: adminRecord, error: adminError } = await supabase
      .from('waitlist')
      .select('id')
      .eq('email', allowedAdminEmail)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
      
    if (adminError || !adminRecord) {
      console.error('Error fetching admin record:', adminError || 'Admin record not found');
      return res.status(500).json({ error: 'Failed to fetch admin record for clearing waitlist' });
    }
    
    // Delete all records except the admin record
    const { error } = await supabase
      .from('waitlist')
      .delete()
      .neq('id', adminRecord.id);
      
    if (error) {
      console.error('Supabase error clearing waitlist:', error);
      if (error.message.includes('permission denied')) {
         return res.status(403).json({ error: 'Permission denied. Server might need elevated privileges (Service Role Key) to clear the waitlist.' });
      }
      throw new Error('Failed to clear waitlist data');
    }
    
    console.log('Waitlist cleared successfully by admin:', req.session.user.email);
    res.status(200).json({ message: 'Waitlist cleared successfully, admin record preserved' });
     
   } catch (error) {
     console.error('Error in /clear-waitlist:', error);
     // Send telemetry for this specific error
     sendTelemetryEvent("error", {
       domain: req.headers.host || 'unknown',
       message: "Error in /clear-waitlist",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
       route: req.originalUrl,
       method: req.method,
       adminEmail: req.session.user.email, // Include relevant context
     });
     res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Reminders endpoints

// GET: For cron job – only send reminders if now >= launch_date, and update the flag.
// ... (previous middleware, session configuration, etc.)

// Define GET /waitlist-reminders for cron job BEFORE applying requireAuth to subsequent routes.
adminApiRouter.get('/waitlist-reminders', async (req, res) => {
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.CRON_AUTH_TOKEN}`;
  if (!process.env.CRON_AUTH_TOKEN) {
    console.warn("CRON_AUTH_TOKEN not set. GET /waitlist-reminders endpoint is disabled.");
    return res.status(403).json({ error: "Cron job authentication not configured." });
  }
  if (authHeader !== expectedToken) {
    console.warn(`Unauthorized GET attempt to /waitlist-reminders. Provided token: ${authHeader}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  console.log("Authorized GET request received for /api/admin/waitlist-reminders (Cron Job).");
  // For GET (cron) calls, forceSend is false (so it will obey launch_date) and updateReminderSent is true.
  const result = await sendWaitlistReminders({
    forceSend: false,
    updateReminderSent: true,
    // Domain for cron job - could be fixed or derived if needed
    domain: 'cron-job'
  });
  // Return the detailed result object
  return res.status(result.status).json(result);
});

// Now apply requireAuth middleware for all remaining admin routes.
adminApiRouter.use(requireAuth);

// (Other admin routes that require session-based auth, like POST /waitlist-reminders, /validate, etc.)

// --- Reminders Endpoints ---
// POST: For web interface – always send reminders regardless of launch_date,
// and do not update the reminder_sent flag.
adminApiRouter.post('/waitlist-reminders', async (req, res) => {
  const { from, subject, text } = req.body; // 'from' is the display name
  if (!from || !subject || !text) {
    return res.status(400).json({ error: 'Sender name, subject, and message text are required.' });
  }
  // For POST, force sending and do not update reminder_sent.
  const domain = req.headers.host || 'unknown'; // Get domain from request
  const result = await sendWaitlistReminders({
    from,
    subject,
    text,
    forceSend: true,
    updateReminderSent: false,
    domain // Pass domain
  });
  // Return the detailed result object, status is always 200 if function completes
  // The 'hadErrors' field indicates partial failure.
  res.status(result.status).json(result);
});


// Helper function to format date for display
function formatLaunchDateForDisplay(isoString) {
  if (!isoString) return "N/A";
  try {
    const dateObj = new Date(isoString);
    const formattedDate = dateObj.toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: 'UTC'
    });
    const formattedTime = dateObj.toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: 'UTC'
    });
     return `${formattedDate} at ${formattedTime} UTC`;
   } catch (e) {
     console.error("Error formatting date:", e);
     // Send telemetry for date formatting error
     sendTelemetryEvent("error", {
       domain: 'server-internal-date-format', // Specific domain for this utility
       message: "Error formatting date for display",
       errorName: e.name,
       errorMessage: e.message,
       stackTrace: e.stack,
       originalDateString: isoString, // Include relevant context
     });
     return "Invalid Date";
  }
}


/**
 * Sends reminder emails to the waitlist, tracking individual failures.
 * @param {object} [customOptions={}] - Options to customize sending behavior.
 * @param {string} [customOptions.from] - Display name for the sender.
 * @param {string} [customOptions.subject] - Email subject.
 * @param {string} [customOptions.text] - Email body text.
 * @param {boolean} [customOptions.forceSend=false] - Ignore launch date and reminder_sent flag if true.
 * @param {boolean} [customOptions.updateReminderSent=false] - Update reminder_sent flag if true.
 * @param {string} [customOptions.domain='unknown'] - Domain for telemetry.
 * @returns {Promise<{ message?: string; error?: string; status: number; hadErrors?: boolean; successCount?: number; errorCount?: number; failedEmails?: {email: string, error: any}[] }>}
 */
async function sendWaitlistReminders(customOptions = {}) {
  const options = {
    forceSend: false,
    updateReminderSent: false,
    domain: 'unknown', // Default domain if not provided
    ...customOptions
  };
  const domain = options.domain; // Use the domain from options for telemetry

  if (!resend) {
    console.error("Resend is not configured. RESEND_API_KEY must be set.");
    // Send telemetry for configuration error
    sendTelemetryEvent("error", {
      domain,
      message: "Resend configuration error in sendWaitlistReminders",
      errorName: "ConfigurationError",
      errorMessage: "Resend API Key (RESEND_API_KEY) is not configured.",
      severity: 'critical'
    });
    // Ensure return type matches Promise signature
    return { error: 'Email service (Resend API Key) is not configured on the server.', status: 501, hadErrors: true, failedEmails: [] };
  }
  if (!resendSenderEmail) {
    console.error("Resend sender email (RESEND_SENDER_EMAIL) is not configured or is empty in .env file.");
    // Send telemetry for configuration error
    sendTelemetryEvent("error", {
      domain,
      message: "Resend configuration error in sendWaitlistReminders",
      errorName: "ConfigurationError",
      errorMessage: "Resend Sender Email (RESEND_SENDER_EMAIL) is not configured.",
      severity: 'critical'
    });
     // Ensure return type matches Promise signature
    return { error: 'Resend sender email address is not configured or is empty on the server.', status: 501, hadErrors: true, failedEmails: [] };
  }


  let launchDateISO;
  let reminderSent = false;

  try {
    // const domain = 'server-internal-reminders'; // Domain is now passed in options
 
     const { data: settingsData, error: settingsError } = await supabase
      .from('waitlist')
      .select('launch_date, reminder_sent')
      .limit(1)
      .maybeSingle();
 
     if (settingsError) {
       console.error('Supabase error fetching settings (launch_date, reminder_sent):', settingsError);
       // Send telemetry for this specific error
       sendTelemetryEvent("error", {
         domain,
         message: "Supabase error fetching settings in sendWaitlistReminders",
         errorName: settingsError.name,
         errorMessage: settingsError.message,
         stackTrace: settingsError.stack, // Supabase errors might have stack
       });
       // Return structure includes error details
       return { error: 'Failed to fetch waitlist settings from database', status: 500, hadErrors: true, failedEmails: [] };
    }

    if (!settingsData || !settingsData.launch_date) {
      console.log('No launch_date found in the waitlist table.');
      // Send telemetry for missing launch date
      sendTelemetryEvent("error", {
        domain,
        message: "Missing launch date in sendWaitlistReminders",
        errorName: "ConfigurationError",
        errorMessage: "Launch date is not set in the database.",
      });
      return { error: 'Launch date is not set. Cannot send reminders.', status: 400, hadErrors: true, failedEmails: [] };
    }

    launchDateISO = settingsData.launch_date;
    reminderSent = !!settingsData.reminder_sent;

    const launchDate = new Date(launchDateISO);
    const now = new Date();

    console.log("Launch Date from DB:", launchDate.toISOString());
    console.log("Reminder Sent Flag from DB:", reminderSent);
    console.log("Now:", now.toISOString());
    console.log("Options:", options);

    // For GET (cron) calls: if not forcing send, then enforce that now >= launch_date
    if (!options.forceSend) {
      if (now.getTime() < launchDate.getTime()) {
        console.log("Current time is before launch date. Skipping reminders.");
        return {
          message: `Reminders not sent yet (launch date is in the future: ${formatLaunchDateForDisplay(launchDateISO)})`,
          status: 200,
          hadErrors: false, successCount: 0, errorCount: 0, failedEmails: [] // Add missing fields
        };
      }
      if (reminderSent) {
        console.log("Reminder emails already marked as sent previously. Skipping.");
        return { message: "Reminder emails already marked as sent.", status: 200, hadErrors: false, successCount: 0, errorCount: 0, failedEmails: [] }; // Add missing fields
      }
    }

    console.log("Proceeding to send reminder emails...");

    const { data: waitlistEntries, error: fetchError } = await supabase
      .from('waitlist')
      .select('email')
      .neq('email', ''); // Select non-empty emails
 
     if (fetchError) {
       console.error('Supabase error fetching waitlist emails:', fetchError);
       // Send telemetry for this specific error
       sendTelemetryEvent("error", {
         domain,
         message: "Supabase error fetching waitlist emails in sendWaitlistReminders",
         errorName: fetchError.name,
         errorMessage: fetchError.message,
         stackTrace: fetchError.stack,
       });
       return { error: 'Failed to fetch waitlist emails from database', status: 500, hadErrors: true, failedEmails: [] };
    }

    const totalEmailsToAttempt = waitlistEntries?.length || 0;
    if (totalEmailsToAttempt === 0) {
      console.log('Waitlist is empty. No reminders to send.');
      return { message: 'Waitlist is empty. No reminders sent.', status: 200, hadErrors: false, successCount: 0, errorCount: 0, failedEmails: [] };
    }

    // Construct 'From' address using display name and sender email
    const defaultDisplayName = "Waitlist App";
    const displayName = options.from ? String(options.from).trim() : defaultDisplayName;
    const finalFrom = `"${displayName}" <${resendSenderEmail}>`; // Use environment variable for sender email

    const defaultSubject = "Reminder: Our Launch is Approaching!";
    const finalSubject = options.subject || defaultSubject;

// --- Refactored sendWaitlistReminders logic ---
    // NOTE: formatLaunchDateForDisplay is defined *before* this function
    const formattedLaunchDate = formatLaunchDateForDisplay(launchDateISO);
    const defaultText = `Hi there,\n\nJust a friendly reminder that our launch date is approaching!\n\nLaunch Date: ${formattedLaunchDate}\n\nGet ready for our launch!`;
    let finalText = options.text || defaultText;
    // Ensure launch date is included if custom text is provided but doesn't contain it
    if (options.text && !finalText.includes(formattedLaunchDate)) {
      finalText += `\n\nLaunch Date: ${formattedLaunchDate}`;
    }
    const htmlContent = `<p>${finalText.replace(/\n/g, "<br>")}</p>`;

    console.log(`Attempting to send ${totalEmailsToAttempt} emails via Resend...`);

    let successCount = 0;
    const emailErrors = []; // Store failed emails and errors { email: string, error: any }

    for (const entry of waitlistEntries) {
      const toEmail = entry?.email;
      if (!toEmail) continue; // Skip if email is missing

      const emailPayload = {
        from: finalFrom,
        to: toEmail,
        subject: finalSubject,
        text: finalText,
        html: htmlContent,
      };

      try {
        // Use await with resend.emails.send
        const { data: sendData, error: sendError } = await resend.emails.send(emailPayload);

        if (sendError) {
          console.error(`❌ Resend error for email to ${toEmail}:`, sendError);
          // Store structured error, check for statusCode property
          const errorDetails = { name: sendError.name, message: sendError.message };
          if ('statusCode' in sendError) {
             errorDetails.statusCode = sendError.statusCode;
          }
          emailErrors.push({ email: toEmail, error: errorDetails });
          // Send telemetry for Resend error
          sendTelemetryEvent("error", {
            domain,
            message: "Resend API error during email sending",
            errorName: sendError.name,
            errorMessage: sendError.message,
            resendStatusCode: errorDetails.statusCode, // Include status code if available
            recipientEmail: toEmail,
            severity: 'warning'
          });
        } else {
          console.log(`✅ Email accepted by Resend for ${toEmail}:`, sendData?.id);
          successCount++;
        }
      } catch (networkError) {
        // Catch network/SDK errors during the fetch call within resend.emails.send
        console.error(`❌ Network/SDK Error sending email to ${toEmail}:`, networkError);
        emailErrors.push({ email: toEmail, error: { name: networkError.name, message: networkError.message } });
        sendTelemetryEvent("error", {
          domain,
          message: "Network/SDK error during email sending",
          errorName: networkError.name,
          errorMessage: networkError.message,
          stackTrace: networkError.stack,
          recipientEmail: toEmail,
          severity: 'warning'
        });
      }
    } // End of email sending loop

    const errorCount = emailErrors.length;
    const hadErrors = errorCount > 0;
    console.log(`Resend submission completed. Success: ${successCount}, Errors: ${errorCount}`);

    // Only update reminder_sent flag if this is a GET (cron) call AND there were successful sends.
    if (options.updateReminderSent && successCount > 0) {
      console.log("Updating reminder_sent flag in database...");
      const { error: updateError } = await supabase
        .from('waitlist')
        .update({ reminder_sent: true })
        // Ensure we only update rows matching the specific launch date we processed
        .eq('launch_date', launchDateISO); // Use the fetched launchDateISO

      if (updateError) {
         console.error("Supabase error updating reminder_sent flag:", updateError);
         // Send telemetry for this specific error
         sendTelemetryEvent("error", {
           domain,
           message: "Supabase error updating reminder_sent flag",
           errorName: updateError.name,
           errorMessage: updateError.message,
           stackTrace: updateError.stack,
         });
         console.warn("Warning: Failed to update reminder_sent flag after sending emails.");
         // Note: We don't return an error here, just log/telemetry it, as emails might have been sent.
      } else {
        console.log("Successfully updated reminder_sent flag.");
      }
    }

    // Construct final message
    let finalMessage = `Attempted to send ${totalEmailsToAttempt} emails. Successfully sent ${successCount} reminder emails.`;
    if (hadErrors) {
      finalMessage += ` ${errorCount} error(s) occurred.`;
      // Optionally list failed emails in the message if needed, though returning them in the object is better for programmatic use.
      // finalMessage += ` Failed emails: ${emailErrors.map(e => e.email).join(', ')}`;
    }

    return {
      message: finalMessage,
      status: 200, // Return 200 even if some emails failed, as the operation itself completed
      hadErrors: hadErrors,
      successCount: successCount,
      errorCount: errorCount,
      failedEmails: emailErrors // Return the list of failed emails and their errors
    };

   } catch (error) { // Catch unexpected errors in the main try block
     console.error("Unexpected error in sendWaitlistReminders:", error);
     // Send telemetry for unexpected errors in this function
     sendTelemetryEvent("error", {
       domain, // Use the domain from options
       message: "Unexpected error in sendWaitlistReminders",
       errorName: error.name,
       errorMessage: error.message,
       stackTrace: error.stack,
     });
     // Ensure the return structure matches the expected Promise type
     return {
       error: error.message || 'Internal server error while processing reminders.',
       status: 500,
       hadErrors: true, // Assume errors if we reach here
       successCount: 0,
       errorCount: 0, // Unknown specific errors, but indicate failure
       failedEmails: []
      };
  }
}
// --- End of Refactored sendWaitlistReminders ---


app.use('/api/admin', adminApiRouter);

// Global error handling middleware
app.use((err, req, res, next) => { // Removed TS types
  const domain = req.headers.host || 'unknown';
  console.error("Global error handler caught an error:", err);
  sendTelemetryEvent("error", {
    domain,
    message: "Unhandled exception",
    errorName: err.name,
    errorMessage: err.message,
    stackTrace: err.stack,
    route: req.originalUrl,
    method: req.method,
  });

  // Respond to the client appropriately - do not send stack trace in production
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: 'Internal server error', details: err.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
