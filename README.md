# RevIQ Command

> A Telegram bot with AI brain and a web dashboard for a 5-person startup launch team.

**Stack:** Node.js · grammy · Claude (Anthropic) · Supabase · Next.js · Railway · Vercel

---

## What It Does

- 🤖 **Telegram bot** sits in your group, stores every message, responds to commands and @mentions
- 🧠 **Claude AI** answers questions, extracts tasks from conversation, generates recaps
- ⚡ **Autonomous mode** — the bot speaks up when it spots something the team missed
- 📋 **Web dashboard** — tasks, decisions, and activity stats with live Supabase Realtime

---

## Setup (12 Steps)

### 1. Clone the repo

```bash
git clone https://github.com/aleink/RevIQ-War-Room.git
cd RevIQ-War-Room
npm run install:all
```

---

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project
2. Copy from **Project Settings → API**:
   - `Project URL` → this is your `SUPABASE_URL`
   - `service_role` key → this is your `SUPABASE_SERVICE_KEY`
   - `anon` / `public` key → this is your `SUPABASE_ANON_KEY`

---

### 3. Run the database migration

1. In your Supabase project, open the **SQL Editor**
2. Paste the contents of `supabase/migration.sql` and run it
3. All 5 tables will be created with indexes, realtime enabled, and 5 placeholder team members seeded

---

### 4. Edit team members

In the Supabase Table Editor, open the `team_members` table and replace the 5 placeholder rows with your real team:

| Column | Description |
|---|---|
| `name` | Display name used throughout the bot |
| `telegram_username` | Without the @ symbol |
| `telegram_id` | Their Telegram numeric user ID (see below) |
| `role` | e.g. "CEO", "CTO", "Head of Growth" |

**How to get a Telegram ID:** Ask the person to message [@userinfobot](https://t.me/userinfobot). It replies with their numeric ID.

---

### 5. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** → this is your `TELEGRAM_BOT_TOKEN`

---

### 6. Get your Telegram group chat ID

1. Add [@userinfobot](https://t.me/userinfobot) to your group temporarily
2. It will print the group's chat ID (a negative number like `-1001234567890`)
3. This is your `TEAM_CHAT_ID`
4. Remove @userinfobot from the group

---

### 7. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. This is your `ANTHROPIC_API_KEY`

---

### 8. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in all values:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TEAM_CHAT_ID=-1001234567890
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...
DASHBOARD_TOKEN=$(openssl rand -hex 32)
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

Generate a `DASHBOARD_TOKEN` using:
```bash
openssl rand -hex 32
```

---

### 9. Deploy the bot to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select this repo
3. Set the root directory to `/` (uses the Dockerfile)
4. Add all environment variables from your `.env` file in Railway's Variables tab
5. Add one extra variable: `RAILWAY_STATIC_URL` = your Railway public URL (e.g. `https://reviq-command.up.railway.app`)
6. Deploy

Railway will build from the Dockerfile and run `node bot/index.js`.

---

### 10. Deploy the web dashboard to Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select this repo
3. Vercel will auto-detect Next.js via `vercel.json`
4. Add these environment variables in Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `DASHBOARD_TOKEN`
   - `SUPABASE_SERVICE_KEY` (for server-side data fetching)
5. Deploy

---

### 11. Share the dashboard link

Post the dashboard URL in your Telegram group once:

```
https://your-vercel-url.vercel.app/dashboard?token=YOUR_DASHBOARD_TOKEN
```

Anyone with the link can access the dashboard. Keep the token private.

---

### 12. Verify the bot is alive

Send `/help` in your Telegram group. The bot should respond with the command list.

---

## Commands Reference

| Command | What it does |
|---|---|
| `/ask [question]` | Ask the AI anything — uses recent context |
| `/find [query]` | Search message history |
| `/todos` | Extract all action items from the last 24h |
| `/todo [task] @[person]` | Create a task and assign it |
| `/mytasks` | See your open tasks |
| `/done [task # or text]` | Mark a task complete |
| `/opentasks` | All open tasks grouped by person |
| `/decide [decision]` | Log a decision and pin it |
| `/recap` | Summary of last 24h |
| `/weeklyrecap` | 7-day structured recap |
| `/tag` | Reply to a message to auto-categorize it |
| `/listen` | Turn on autonomous mode |
| `/silent` | Turn off autonomous mode |
| `/dailyon` | Enable morning nudge |
| `/dailyoff` | Disable morning nudge |
| `/help` | List all commands |

---

## Autonomous Mode

The bot evaluates recent conversation every **10 messages** or **30 minutes** (whichever comes first) and speaks up if it detects:

- A contradiction with a logged decision
- A forgotten open task being re-discussed
- A conversation going in circles
- A missed blocker
- Scope creep
- An easy quick win nobody claimed
- An important question that got buried

Autonomous messages are prefixed with ⚡ and capped at **3 per day**.

**Starts OFF by default.** Activate with `/listen`.

---

## Local Development

```bash
# Start the bot (long polling mode, no webhook needed)
npm run dev:bot

# Start the web dashboard
npm run dev:web
# → http://localhost:3000?token=YOUR_DASHBOARD_TOKEN
```

Make sure `.env` is filled in before running.

---

## Troubleshooting

**Bot isn't responding**
- Make sure it's an admin in the group (needed for pinning messages)
- Check Railway logs for startup errors
- Verify `TEAM_CHAT_ID` matches the group (must be the negative number)

**Webhook not working**
- Confirm `RAILWAY_STATIC_URL` is set and publicly reachable
- Telegram requires HTTPS for webhooks — Railway provides this automatically

**Dashboard shows 403**
- The `?token=` in the URL must exactly match `DASHBOARD_TOKEN` in Vercel env vars

**Tasks not appearing in real time**
- Confirm Supabase Realtime is enabled for the `tasks` and `decisions` tables (the migration SQL handles this, but verify in Supabase → Database → Replication)

---

## Project Structure

```
reviq-command/
├── bot/
│   ├── index.js              Entry point — webhook or long polling
│   ├── handlers/
│   │   ├── commands.js        All /command handlers
│   │   ├── mentions.js        @bot tags and direct replies
│   │   └── autonomous.js      Autonomous evaluation loop
│   ├── ai.js                  Claude API wrapper
│   ├── db.js                  All Supabase queries
│   └── utils.js               Formatting and helper functions
├── web/
│   ├── app/
│   │   ├── layout.tsx         Root layout
│   │   ├── page.tsx           Dashboard page
│   │   └── globals.css        Design system
│   ├── components/
│   │   ├── QuickAdd.tsx
│   │   ├── TaskList.tsx
│   │   ├── CompletedTasks.tsx
│   │   ├── DecisionLog.tsx
│   │   └── ActivityPulse.tsx
│   └── lib/
│       └── supabase.ts        Supabase client + Realtime
├── supabase/
│   └── migration.sql          Full schema + seed data
├── .env.example
├── package.json
├── vercel.json
├── Dockerfile
└── README.md
```
