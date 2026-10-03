# responde-core-api

> Unified backend API, Facebook Messenger automation, and public activity scraping pipeline for the **Responde** Incident & Disaster Management System in **Talisay, Batangas**.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)
![Meta Graph API](https://img.shields.io/badge/Meta%20Graph%20API-0467DF?style=for-the-badge&logo=meta&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

---

## Table of Contents

- [Overview](#overview)
- [Development & Security Notice](#development--security-notice)
- [Active Pipeline Modules](#active-pipeline-modules)
- [Scope: Talisay Batangas Barangays](#scope-talisay-batangas-barangays)
- [Architecture Decision: Independent Failure Domains](#architecture-decision-independent-failure-domains)
- [Tech Stack](#tech-stack)
- [Security & Credential Protection](#security--credential-protection)
- [Environment Configuration](#environment-configuration)
- [API Endpoints](#api-endpoints)
- [Installation & Running Locally](#installation--running-locally)
- [License](#license)

---

## Overview

**responde-core-api** is the core backend service powering automated emergency intake and public incident monitoring for **Talisay, Batangas**.

The system operates two primary automated pipeline workflows:
1. **Automated Emergency Messaging (Messenger Bot)**: Ingests incoming Facebook Messenger messages, generates context-aware conversational replies using Google Gemini (backed by a resilient 15-key rotation pool with rate-limit cooldown), deterministically extracts resident contact details and barangays, and enqueues classification jobs into a durable outbox queue.
2. **Public Page Activity Scraping**: Periodically scrapes public Facebook Page posts and comments via Meta Graph API (v25.0), maps emergency keywords against official Talisay barangays, and automatically reconciles deleted or edited comments.

All structured incident and conversation data is persisted into **Supabase (PostgreSQL)** with strict Row Level Security (RLS).

---

> [!NOTE]
> ### Development & Security Notice
> This project was developed using **Google Antigravity IDE**. Portions of the codebase undergo manual inspection and validation prior to deployment. You are welcome to inspect, audit, or review the code for your personal verification or security purposes.

---

## Active Pipeline Modules

### 1. Messenger Bot Module (AI Auto-Reply & Intake)
| Feature | Description |
|---|---|
| **Webhook Ingestion** | Real-time intake of Facebook Page Messenger webhooks with HMAC-SHA256 signature verification |
| **Distributed Message Dedup** | Multi-instance safe deduplication using PostgreSQL unique constraints (`processed_messages`) |
| **Sender Profile Resolution** | Resolves resident names via Meta Graph API with in-memory caching and retroactive backfill |
| **Multi-Key Gemini Pool** | Round-robin rotation across active API keys with automatic 429/503 cooldown and 401 key fencing |
| **Deterministic Extraction** | Regex extraction for Philippine phone numbers, barangays, and resident names |
| **Durable NLP Outbox** | Transactionally records conversations and delegates classification to an asynchronous queue (`nlp_jobs`) |

### 2. Facebook Page Scraper Module (Public Activity Ingestion)
| Feature | Description |
|---|---|
| **Periodic Background Scraping** | Configurable scheduled cron scraping of posts and comments (default: every 350s) |
| **Comment Reconciliation** | Prunes deleted comments from the database by reconciling against active Graph API comment IDs |
| **Keyword Parsing Engine** | Classifies disaster types (floods, fires, volcanic activity, landslides, typhoons) |
| **Strict Barangay Matching** | Filters and normalizes locations against the **21 official barangays of Talisay, Batangas** |
| **Control Endpoints** | Manual scrape execution (`POST /scraper/run`) and operational health check (`GET /scraper/status`) |

---

## Scope: Talisay Batangas Barangays

All parsed locations are matched strictly against the 21 official barangays of Talisay, Batangas (falling back to `'Unknown'` when unmatched):

> Aya, Balas, Banga, Buco, Caloocan, Leynes, Miranda, Poblacion Barangay 1, Poblacion Barangay 2, Poblacion Barangay 3, Poblacion Barangay 4, Poblacion Barangay 5, Poblacion Barangay 6, Poblacion Barangay 7, Poblacion Barangay 8, Quiling, Sampaloc, San Guillermo, Santa Maria, Tranca, Tumaway.

---

## Architecture Decision: Independent Failure Domains

> **Reliability Note for Disaster Response:**
> The system enforces strict separation between deterministic data collection and semantic inference. Critical citizen details (phone numbers, full names, barangays) are captured deterministically by Express upon webhook receipt and saved immediately. Semantic classification (incident type, urgency, intent) is decoupled through a persistent database queue (`nlp_jobs`) and processed asynchronously by the ML subsystem.

### Independent Status Tracking
Every report record in `conversations` tracks two independent status fields:
* **`ml_status`** (`complete` | `failed` | `pending`): Tracks status of the ML subsystem. If the ML worker is offline or cold-starting, `ml_status` remains recoverable and is automatically retried by the background worker.
* **`location_status`** (`found` | `not_found`): Tracks whether Express matched an official Talisay barangay from message text or aliases.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime & Server** | Node.js (v20+), Express.js (v5) |
| **Database & Auth** | Supabase (PostgreSQL with RLS) |
| **AI LLM Engine** | `@google/genai` (Gemini Flash with multi-key pool rotation) |
| **Social API** | Meta Graph API (v25.0) |
| **Security & Utilities** | `helmet`, `express-rate-limit`, `cookie-parser`, `node-cron`, `localtunnel` |

---

## Security & Credential Protection

| Layer | Implementation Details |
|---|---|
| **Environment Variables** | Secrets (`SUPABASE_SERVICE_KEY`, `PAGE_ACCESS_TOKEN`, API Keys) stored in `.env` |
| **Git Exclusion** | `.env` explicitly excluded from version control via `.gitignore` |
| **Internal Endpoint Protection** | Scraper and retry triggers secured by `x-api-key` header verification |
| **Webhook Authenticity** | Validates incoming Meta payloads via `x-hub-signature-256` HMAC |
| **Session Isolation** | Role-based administrative endpoints protected by httpOnly secure session cookies |

---

## Environment Configuration

Create a `.env` file in the root directory (refer to `.env.example`):

```env
# ── Supabase ──────────────────────────────────────────────────────────────────
SUPABASE_URL=https://your-project-id.supabase.co
# ⚠️ service_role key is required to bypass RLS policies for backend worker operations
SUPABASE_SERVICE_KEY=your_supabase_service_role_key

# ── Facebook Messenger + Scraper ──────────────────────────────────────────────
PAGE_ACCESS_TOKEN=your_meta_page_access_token
META_ACCESS_TOKEN=your_meta_access_token
VERIFY_TOKEN=your_webhook_verify_token
APP_SECRET=your_facebook_app_secret
FB_PAGE_ID=your_facebook_page_numeric_id
FB_GRAPH_API_VERSION=v25.0
SCRAPER_INTERVAL_SECONDS=350

# ── AI Configuration (Multi-Key Pool) ─────────────────────────────────────────
# Comma-separated list of Gemini API keys for round-robin rotation
GEMINI_API_KEYS=key1,key2,key3,key4,key5
GEMINI_MODEL=models/gemini-3.6-flash

# ── Bot Prompt ────────────────────────────────────────────────────────────────
BOT_SYSTEM_PROMPT="ikaw ay tagalog AI bot assistant ng MDRRMC Talisay Batangas 4220 Philippines..."

# ── Internal & NLP Configuration ──────────────────────────────────────────────
INTERNAL_API_KEY=your_internal_api_key
NLP_SERVICE_URL=http://localhost:7860
NLP_TIMEOUT_MS=5000
NLP_BACKFILL_INTERVAL_MS=900000

PORT=3000
```

---

## API Endpoints

### Public & Webhook Endpoints
| Method | Endpoint | Headers / Auth | Description |
|---|---|---|---|
| `GET` | `/` | None | Basic service health check returning status and current timestamp |
| `GET` | `/webhook` | URL Queries | Facebook Webhook Verification Challenge (`hub.challenge`) |
| `POST` | `/webhook` | `x-hub-signature-256` | Ingests incoming Messenger events with signature check and deduplication |

### Pipeline Scraper & Outbox Management
| Method | Endpoint | Headers / Auth | Description |
|---|---|---|---|
| `POST` | `/scraper/run` | `x-api-key: <INTERNAL_API_KEY>` | Manually triggers the Facebook Page scraper and comment reconciliation |
| `GET` | `/scraper/status` | None | Returns scraper operational status, last execution time, and counts |
| `POST` | `/api/nlp/retry` | `x-api-key: <INTERNAL_API_KEY>` | Re-enqueues failed ML classification records into the `nlp_jobs` queue |

### Inspection & Administration (Session-Protected)
| Method | Endpoint | Headers / Auth | Description |
|---|---|---|---|
| `GET` | `/api/debug/conversations` | Session Cookie (`admin`, `super_admin`) | Retrieves recent conversations, scraped posts, and comments |
| `GET` | `/api/user-history/:senderPSID` | Session Cookie (`admin`, `super_admin`) | Retrieves full conversation history formatted for model context |
| `POST` | `/api/reset-database` | Session Cookie (`super_admin`) | Clears all conversation records from the database |

> *Note: User management, invitation links, and RBAC authentication endpoints reside under `/api/auth`.*

---

## Installation & Running Locally

1. **Clone the repository & install dependencies:**
   ```bash
   git clone https://github.com/samsonjeff/responde-core-api.git
   cd responde-core-api
   npm install
   ```

2. **Configure environment:**
   Create a `.env` file based on `.env.example` with valid Supabase, Meta, and Gemini credentials.

3. **Verify API keys and connections:**
   ```bash
   npm run diagnose
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **(Optional) Start localtunnel for Meta webhook testing:**
   ```bash
   npm run tunnel
   ```

---

## License

This project is licensed under the [MIT License](LICENSE).