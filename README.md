# Supabase Waitlist & Newsletter System

## TL;DR

This is a Node.js/Express waitlist/newsletter app that uses Supabase (DB) and Resend (Email). Users sign up, admins manage the list, set a launch date, and send email reminders (manually or via cron). **Important:** cron job invocation will send text encoded in the **defaultText** value when your app is deployed.  **CRITICAL:** You MUST create a `.env` file with Supabase/Resend API keys, DB URL, verified sender email (for production), admin email, and a cron token. See "⚠️ CRITICAL SETUP INSTRUCTIONS ⚠️" below for details.

---

## How It Works (App Mechanics)

This application provides a simple waitlist/newsletter signup and email reminder system. The stack is vanilla JS and node.js. Here's a breakdown of the core mechanics:

1.  **User Signup (`/` and `/api/waitlist`):**
    *   Users visit the main page (`index.html`).
    *   They enter their email address into the form.
    *   The frontend (`script.js`) sends a POST request to `/api/waitlist` with the email.
    *   The backend (`server.mjs`) validates the email format.
    *   It retrieves the `launch_date` from the first record in the `waitlist` table (which should be the admin's record, set during initial setup).
    *   It attempts to insert the new email along with the retrieved `launch_date` into the `waitlist` table in Supabase.
    *   If the email already exists (violating the unique constraint), it returns a 409 Conflict error and rank number of already signed up email.
    *   If successful, it calculates the user's rank based on their signup time (`created_at`) and returns a success message with the rank.

2.  **Admin Login (`/login.html` and `/api/login`):**
    *   Admins navigate to `/login.html`.
    *   They enter their admin email (must match `ADMIN_ALLOWED_EMAIL` in `.env`) and the password they set up in Supabase Auth.
    *   The frontend (`login.js`) sends a POST request to `/api/login`.
    *   The backend (`server.mjs`) first checks if the provided email matches `ADMIN_ALLOWED_EMAIL`.
    *   If the email matches, it then uses `supabase.auth.signInWithPassword` to verify the email and password against the Supabase Authentication user database.
    *   If Supabase authentication is successful, the backend creates a server-side session (using `express-session`) storing the user's ID and email. This session is linked to a cookie sent back to the admin's browser.
    *   Subsequent requests from the admin browser to protected admin routes will include this session cookie.

3.  **Admin Dashboard Access (`/admin.html`, `/date-time-setter.html`, `/api/admin/*`):**
    *   Access to admin pages and API endpoints is protected by the `requireAuth` middleware in `server.mjs`.
    *   This middleware checks for a valid server-side session and verifies that the email stored in the session matches the `ADMIN_ALLOWED_EMAIL`.
    *   If the session is valid and the email matches, the request proceeds. Otherwise, the user is redirected to `/login.html` (for HTML requests) or receives a 401 Unauthorized error (for API requests).
    *   The middleware also checks if the `waitlist` table exists (setup complete). If not, and the user tries to access a page other than the setup page (`/date-time-setter.html`), it returns a 409 Conflict status, prompting the frontend (`admin.js` or `date-time-setter.js`) to redirect to the setup page.

4.  **Initial Setup (`/date-time-setter.html` and `/api/admin/validate`):**
    *   After the first successful admin login, if the `waitlist` table doesn't exist, the user is directed to `/date-time-setter.html`.
    *   The admin selects a launch date and time.
    *   Submitting the form sends a POST request to `/api/admin/validate`.
    *   The backend:
        *   Creates the `waitlist` table if it doesn't exist.
        *   Inserts the admin's email (`ADMIN_ALLOWED_EMAIL`) as the first record, setting the chosen `launch_date`.
        *   Attempts to enable `pg_cron` and `pg_net` extensions in the Supabase database.
        *   Schedules a `pg_cron` job to run every minute. This job makes an authenticated GET request (using the `CRON_AUTH_TOKEN`) to the application's `/api/admin/waitlist-reminders` endpoint.

5.  **Email Reminders (`/api/admin/waitlist-reminders` - GET and POST):**
    *   **Automated (GET request via Cron):**
        *   The `pg_cron` job calls `GET /api/admin/waitlist-reminders` every 15 minutes, including the `CRON_AUTH_TOKEN` for authentication.
        *   Cron job invocation will send text encoded in the **defaultText** value, **NOT** the one you see in the admin dashboard.
        *   The backend handler (`sendWaitlistReminders` function with `forceSend: false`, `updateReminderSent: true`):
            *   Checks if the current time is *after* the `launch_date` stored in the database.
            *   Checks if the `reminder_sent` flag in the database is `false`.
            *   **If both conditions are met (launch time passed AND reminders not yet sent):** It fetches all emails from the `waitlist` table and sends them a reminder email via Resend using the default subject/text (or potentially customized ones if the function were extended). After successfully queuing the emails, it updates the `reminder_sent` flag in the database to `true` for the corresponding `launch_date`.
            *   **If the launch date hasn't passed OR if `reminder_sent` is already `true`, no emails are sent by the cron job.**
    *   **Manual (POST request via Admin UI):**
        *   The admin can manually trigger reminders from the `/admin.html` dashboard.
        *   This sends a POST request to `/api/admin/waitlist-reminders` with custom sender name, subject, and text.
        *   The backend handler (`sendWaitlistReminders` function with `forceSend: true`, `updateReminderSent: false`):
            *   **Ignores** the `launch_date` check.
            *   **Ignores** the `reminder_sent` flag check.
            *   Fetches all emails from the `waitlist` table and sends them an email via Resend using the admin-provided subject/text.
            *   **Does NOT** update the `reminder_sent` flag in the database. This allows admins to send multiple manual reminders if needed, without affecting the one-time automated reminder sent by the cron job.

  ----

## ⚠️ CRITICAL SETUP INSTRUCTIONS ⚠️

**This application WILL NOT WORK without proper configuration of external services and environment variables. Follow these steps carefully:**

**1. Create a `.env` File:**
   *   In the root directory of this project create a file named `.env`.
   *   This file will hold all the necessary credentials. **DO NOT commit this file to PUBLIC version control. OK to release it to PRIVATE repo but, if you can, it is better to configure these variables in you web hosting platform **

**2. Configure Supabase:**
   *   **Sign up/Log in:** You need a Supabase account and project ([supabase.com](https://supabase.com/)).
   *   **Make sure you **DO NOT** already have a table named `waitlist`
   *   **Get API Credentials:**
        *   Go to your Supabase Project Settings -> API.
        *   Find `Project URL` and copy it. Add it to your `.env` file as `SUPABASE_URL=YOUR_PROJECT_URL`.
        *   Find `Project API keys` -> `anon` `public`. Copy this key. Add it to your `.env` file as `SUPABASE_ANON_KEY=YOUR_ANON_KEY`.
   *   **Get Database Connection String:**
        *   Go to your Supabase Project Settings -> Database -> Connection string -> URI.
       *   **For Local Development or for the Persistent Servers:** You can use the "Direct connection" URI string (which connects directly to the database, typically on port `5432`). This is suitable for local testing and running the initial setup script (`/api/admin/validate`).
       *   **For Serverless Deployments (Vercel, Netlify, Cloud Run, AWS Lambda, etc.):** It is **highly recommended** to use the **Transaction** mode connection string which uses the Supabase connection pooler (PgBouncer, typically on port `6543`). This prevents exhausting database connections in serverless environments where each function invocation might try to open a new connection. Copy the "URI" string listed under **Transaction** mode. It will look something like: `postgresql://postgres.[project_ref]:[YOUR-PASSWORD]@[cloud]-[region].pooler.supabase.com:6543/postgres`.
       *   **Set `DATABASE_URL` in `.env`:** Paste the chosen connection string into your `.env` file as the value for `DATABASE_URL`. 
   *   **Enable Extensions:**
        *   The initial setup process (triggered via the `/api/admin/validate` endpoint when you first log in as admin) **attempts** to automatically enable the required `pg_cron` and `pg_net` extensions using `CREATE EXTENSION IF NOT EXISTS`.
        *   **Verification Recommended:** It's still good practice to manually check in your Supabase Project Dashboard (Database -> Extensions) to confirm that both `pg_cron` and `pg_net` are successfully enabled after running the initial setup.

**3. Configure Resend:**
   *   **Sign up/Log in:** You need a Resend account ([resend.com](https://resend.com/)).
   *    *   **Recommendation for Dev:** Consider registering for Resend with the same email you set as `ADMIN_ALLOWED_EMAIL`. Then, set `RESEND_SENDER_EMAIL` to this email in your `.env`. This allows testing the reminder flow (admin sends to self) without immediate domain verification. **Domain verification is still mandatory before sending to real users.**
   
   *   **Generate API Key:**
        *   Go to the API Keys section in Resend and create a new API key with `Sending access` permission.
        *   Copy the generated key **immediately** (it won't be shown again). Add it to your `.env` file as `RESEND_API_KEY=YOUR_RESEND_API_KEY`.
   *   **Set Sender Email (`RESEND_SENDER_EMAIL`):**
        *   **For Production:** Use an email address from your verified domain (e.g., `noreply@yourverifieddomain.com`).
     
       

**4. Configure Admin Access to the App (Using Supabase Auth):**
*   **Create Admin User in Supabase:** Since the `/api/login` endpoint uses `supabase.auth.signInWithPassword`, you **must** create a corresponding user within your Supabase project's authentication system:
        1.  Go to your Supabase Project Dashboard -> Authentication -> Users.
        2.  Click "+ New User".
        3.  Enter the **exact same email address** you set for `ADMIN_ALLOWED_EMAIL`.
        4.  Set a **strong, unique password** for this admin user.
        5.  Click "Create User".
   *   ** Admin Email:** The email and a password must be the same as the ones you set in your supabase account.
   *   **Set Admin Email in `.env`:** Add this email to your `.env` file as `ADMIN_ALLOWED_EMAIL=your-chosen-admin@example.com`.
    *   **Login Process:** When logging in via `/login.html`, you will now need to enter the correct admin email (matching `ADMIN_ALLOWED_EMAIL`) **and** the correct password you set in Supabase Auth.

**5. Configure Cron Job:**
   *   **Generate Secret Token:** Create a strong, random secret string (you can use a password generator to do just that). This token secures the endpoint called by the scheduled database job.
   *   **Set Token in `.env`:** Add this token to your `.env` file as `CRON_AUTH_TOKEN=YOUR_GENERATED_SECRET_TOKEN`.
   *   After deploying your app set `REMINDER_CALLBACK_URL=https://your-deployed-app-address.com/api/waitlist-reminders` in your .env
 

**Summary of `.env` Variables You MUST Provide:**

```dotenv
# --- Supabase ---
SUPABASE_URL=YOUR_SUPABASE_PROJECT_URL
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
DATABASE_URL=postgres://postgres:[YOUR-PASSWORD]@[YOUR-DB-HOST]:5432/postgres

# --- Resend ---
RESEND_API_KEY=YOUR_RESEND_API_KEY
RESEND_SENDER_EMAIL=onboarding@resend.dev #after domain verification at resend.com you can replace that one


# --- Admin & Cron ---
ADMIN_ALLOWED_EMAIL=your-chosen-admin@example.com # MUST be the same as your supabase email with a corresponding password
CRON_AUTH_TOKEN=YOUR_GENERATED_SECRET_TOKEN #any reasonable complex string
REMINDER_CALLBACK_URL=https:/your-deployed-app.com/api/admin/waitlist-reminders # This address would receive cron calls from supabase but would only sent out emails/reminders once after the set date

# --- Server and telemetry  ---
# PORT=3000 
NODE_ENV=production #set for `development`when developing on a local machine
TELEMETRY_SERVER_URL=https://telemetry-vercel.vercel.app/api/telemetry
ALLOW_TELEMETRY=TRUE # set to FALSE if you want to opt out from sending me error reports, number of users, etc (see more details at the end of README)
```

**After completing ALL these steps and saving your `.env` file, you can proceed with installing dependencies and running the application.**

---

## Overview

This project implements a comprehensive waitlist and email reminder system using Node.js, Express, Supabase, and Resend. It allows users to sign up for a waitlist for an upcoming launch and provides an administrative interface to manage the waitlist, set the launch date, and send out reminder emails.

The system features:
*   A public-facing signup page.
*   An admin dashboard for managing the waitlist and sending communications.
*   Automated email reminders triggered by a scheduled cron job based on the launch date.
*   Integration with Supabase for database storage and Resend for email delivery.

## Features

### User Features

*   **Waitlist Signup:** Users can submit their email address via a simple form to join the waitlist.
*   **Duplicate Email Handling:** Prevents users from signing up with the same email multiple times.
*   **Theme Switching:** Light/Dark mode toggle available on the signup page.

### Admin Features

*   **Secure Login:** Admin access is protected by a session-based login (requires a specific admin email configured in environment variables).
*   **Initial Setup:** A dedicated page (`/date-time-setter.html`) guides the admin through the initial database table creation and cron job setup if the system hasn't been initialized.
*   **Launch Date Management:** Admins can view and set the official launch date and time using an intuitive date/time picker interface.
*   **Waitlist Management:**
    *   **View Waitlist:** Admins can download the entire waitlist as a CSV file.
    *   **Clear Waitlist:** Admins can clear all entries from the waitlist (preserving the admin's own record).
*   **Email Reminders:**
    *   **Manual Sending:** Admins can manually compose and send reminder emails to everyone on the waitlist at any time.
    *   **Automated Sending:** A cron job automatically sends reminders once the current date/time reaches the configured launch date (if not already sent).
*   **Theme Switching:** Light/Dark mode toggle available on the admin pages.
*   **Logout:** Securely logs the admin out.

## Tech Stack

*   **Backend:**
    *   Node.js
    *   Express.js (Web Framework)
    *   `@supabase/supabase-js` (Supabase Client Library)
    *   `pg` (Node.js PostgreSQL Client - for direct DB operations like cron setup)
    *   `resend` (Resend API Client for Emails)
    *   `dotenv` (Environment Variable Management)
    *   `express-session` & `cookie-parser` (Session Management)
    *   `helmet` (Security Headers)
    *   `morgan` (HTTP Request Logger)
    *   `cors` (Cross-Origin Resource Sharing - currently commented out)
*   **Frontend:**
    *   HTML5
    *   CSS3 (including basic dark mode)
    *   Vanilla JavaScript (DOM manipulation, API calls)
    *   Flatpickr (Date/Time Picker Library)
*   **Database:**
    *   Supabase (PostgreSQL)
*   **Email Service:**
    *   Resend
*   **Scheduling:**
    *   `pg_cron` (PostgreSQL extension for scheduling jobs)

## Prerequisites

*   Node.js (v18 or later recommended)
*   npm (usually comes with Node.js)
*   A Supabase account and project.
*   A Resend account and API key.
*   Access to your Supabase PostgreSQL database connection string.

## Setup and Installation

1.  **Clone the repository (or download the files):**
    ```bash
    # If using Git
    git clone https://github.com/Antibody/waitlist-node-js.git 
    cd waitlist-node-js   
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    *   Modify a `.env` file in the root directory.
    *   If `.env` is not in the repo add the required variables manually (see [Environment Variables](#environment-variables) section below).
    *   Fill in your specific Supabase, Resend, and database credentials.

4.  **Ensure Database Extensions:**
    *   Log in to your Supabase project dashboard.
    *   Navigate to `Database` -> `Extensions`.
    *   Make sure the `pg_cron` and `pg_net` extensions are enabled. If not, enable them.

## Environment Variables

Create a `.env` file in the project root as discussued above


**Important Security Notes:**
*   Keep your `.env` file secure and **do not** commit it to PUBLIC repos in version control.
*   Use strong, unique values for `CRON_AUTH_TOKEN`.
*   Ensure the `ADMIN_ALLOWED_EMAIL` in `.env` matches the email of the user created in Supabase Auth. You must also know the password for that user.

## Running the Application

1.  **Start the server:**
    ```bash
    npm start
    # Or for development with nodemon (if installed: npm install -g nodemon)
    # nodemon server.mjs
    ```
2.  **Access the application:**
    *   **Signup Page:** Open your browser to `http://localhost:3000` (or the port you configured).
    *   **Admin Login:** Navigate to `http://localhost:3000/login.html`.
3.  **Initial Admin Setup:**
    *   Log in using the email specified in `ADMIN_ALLOWED_EMAIL` (any password will work currently).
    *   You should be redirected to `/date-time-setter.html`.
    *   Select a launch date and time.
    *   Click "Set Launch Date & Time". This will:
        *   Create the `waitlist` table in your Supabase database if it doesn't exist.
        *   Insert the admin email record with the chosen launch date.
        *   Ensure `pg_cron` and `pg_net` extensions are enabled and configured.
        *   Schedule the cron job to check for reminders every minute.
    *   You will then be redirected to the main admin dashboard (`/admin.html`).

## Project Structure

```
root/
├── public/                  # Frontend static files
│   ├── admin.html           # Admin dashboard page
│   ├── admin.js             # JS for admin dashboard
│   ├── date-time-setter.html# Initial setup page
│   ├── date-time-setter.js  # JS for setup page
│   ├── index.html           # Public waitlist signup page
│   ├── login.html           # Admin login page
│   ├── login.js             # JS for login page
│   ├── script.js            # JS for public signup page
│   └── style.css            # Shared CSS styles
├── .env                     # Environment variables (create this file)
├── package.json             # Project metadata and dependencies
├── package-lock.json        # Exact dependency versions
├── server.mjs               # Main Express.js backend server file
└── README.md                # This documentation file
```

## API Endpoints

All admin endpoints (`/api/admin/*`) require the user to be logged in via the session cookie.


*   `POST /api/waitlist`: Adds an email to the waitlist (public).
*   `POST /api/login`: Authenticates the admin user and creates a session.
*   `POST /api/logout`: Destroys the admin session and logs the user out.
*   `GET /api/admin/check-setup-status`: Checks if the `waitlist` table exists.
*   `POST /api/admin/validate`: Initializes the database table, admin record, and cron job. Expects `{ launchDate: 'ISO_DATE_STRING' }` in the body.
*   `GET /api/admin/get-launch-date`: Retrieves the currently set launch date.
*   `POST /api/admin/set-launch-date`: Updates the launch date for all waitlist entries. Expects `{ launchDate: 'ISO_DATE_STRING' }` in the body.
*   `GET /api/admin/get-all-waitlist`: Retrieves all waitlist entries.
*   `POST /api/admin/clear-waitlist`: Deletes all waitlist entries except the admin's record.
*   `POST /api/admin/waitlist-reminders`: Manually triggers sending reminder emails. Expects `{ from: 'Sender Name', subject: 'Subject Line', text: 'Email Body' }` in the body. Sends regardless of launch date.
*   `GET /api/admin/waitlist-reminders`: Endpoint called by the cron job. Sends reminders only if the launch date has passed and reminders haven't been sent yet. Requires `Authorization: Bearer YOUR_CRON_AUTH_TOKEN` header.
*    `POST /toggle-reminders`: Manually toggle `reminder_sent` flag in the `waitlist` table (switches between TRUE and FALSE). With `reminder_sent` set to TRUE the `GET /api/admin/waitlist-reminders` will not be able to send the emails. However, though the web interface (`POST /api/admin/waitlist-reminders`:) the emails will be sent regardless

## Database Schema

The application uses one table: `waitlist`.

```sql
CREATE TABLE IF NOT EXISTS public.waitlist (
  id uuid NOT NULL DEFAULT gen_random_uuid(), -- Primary Key
  email text NOT NULL,                         -- User's email address
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()), -- Signup timestamp
  launch_date timestamptz,                     -- The configured launch date (same for all users)
  reminder_sent boolean DEFAULT FALSE,         -- Flag indicating if the reminder email was sent
  CONSTRAINT waitlist_pkey PRIMARY KEY (id),
  CONSTRAINT waitlist_email_key UNIQUE (email) -- Ensure email uniqueness
);

-- The first record inserted (during validation) should be the admin's email.
-- The launch_date from this first record is often used as the canonical launch date.
```

## Cron Job Setup

The `/api/admin/validate` endpoint attempts to set up a `pg_cron` job within your Supabase database. This job runs every 15 minutes (`*/15 * * * *`) and makes a `GET` request to the `/api/admin/waitlist-reminders` endpoint on the deployed server (URL is currently hardcoded in `server.mjs`).

**Important:**
*   The callback URL (`REMINDER_CALLBACK_URL=https://your-deployed-app-address.com/api/waitlist-reminders`) would depend on your app's deployment address but the endpoint `/api/waitlist-reminders` will remain unchanged.
*   The cron job authorization token `CRON_AUTH_TOKEN` could be any reasonably complex string (e.g. `a2c2n3g4-l7f9-0182-2481-vshpea4291820`). 



## Deployment & Environment Variables in Production

The `.env` file is intended **only for local development**. 
When deploying this application to a hosting platform (like Vercel, Netlify, Heroku, AWS, Google Cloud, etc.), you should configure the environment variables directly within that platform's settings:

1.  **Find the Environment Variable Settings:** Log into your hosting provider's dashboard and locate the settings for your deployed application. There will be a section specifically for managing environment variables (sometimes called "Configuration Variables", "Secrets", or similar).
2.  **Define Variables on the Platform:** Manually add each required environment variable (listed in the `.env` summary above: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_SENDER_EMAIL`, `ADMIN_ALLOWED_EMAIL`, `CRON_AUTH_TOKEN`) and their corresponding **production values** into the platform's interface.
3.  **Set `NODE_ENV`:** Ensure you also set the `NODE_ENV` variable to `production` in the hosting platform's environment settings.
4.  **Deploy/Redeploy:** After setting the variables, deploy or redeploy your application. The hosting platform will securely inject these variables into the application's runtime environment. The Node.js code (`process.env.VARIABLE_NAME`) will then pick up these values from the server environment, not from a file.



---

### Telemetry Overview

Our application implements lightweight telemetry to monitor key events and errors from the main site. This data helps me greatly in several ways:

- **Improved Stability and Error Reporting:**  
  Telemetry logs unexpected errors and exceptions. Receiving real-time notifications about these issues allows me to identify, debug, and resolve them quickly, improving overall application stability and user experience.

- **Monitoring User Engagement:**  
  Knowing how many users actively sign up to use the app and seeing trends in user growth motivates me to continue development. It also helps prioritize features and improvements based on actual usage.

- **Performance Optimization:**  
  By monitoring signup latency, I gain insight into the performance of critical workflows. This helps me pinpoint bottlenecks and optimize the application's performance to ensure a fast, responsive user experience.

#### What Telemetry Sends:

- **User Signup Events:** When a user signs up, the telemetry captures:
  - `eventType`: The type of event (e.g., "userSignup").
  - `timestamp`: When the event was generated on the main site.
  - `domain`: The domain from which the signup occurred.
  - `signupCount`: The current signup rank (determined by the waitlist order).
  - `signupLatency`: Latency measured from signup initiation to completion.
  - `receivedAt`: When the telemetry server received the event.

- **Error Events:** In the event of errors (like internal server errors during signup), telemetry records:
  - `eventType`: Typically "error".
  - `message`: Description of the error.
  - `details`: Specific technical details of the error.
  - Additional context such as the domain.

#### How Telemetry Sends Data:

Upon receiving a telemetry event:

- It is logged and stored temporarily in-memory on a secure telemetry server.
- An immediate email notification containing the event details is sent to me, allowing quick response to issues or trends.

#### Disabling Telemetry:

You can easily disable telemetry if desired by adjusting the following environment variables:

- **ALLOW_TELEMETRY:**  
  - Set to `FALSE` (case-insensitive) to completely disable telemetry events.
- **RESEND_SENDER_EMAIL:**  
  - Telemetry events are not sent if this email ends with `@resend.dev`.
- **Local Development Protection:**  
  - Events originating from domains like `localhost` or `127.0.0.1` are automatically blocked from telemetry.

These options allow you full control over your privacy and ensure telemetry data isn't unintentionally sent in development or testing environments.

---








