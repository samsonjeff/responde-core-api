---
name: meta-platform-compliance
description: >-
  Use this skill before implementing any feature that interacts with Meta's
  Graph API, Messenger Platform, or Facebook Page APIs. Covers rate limits,
  prohibited patterns, data handling rules, and approved approaches for
  polling, webhooks, and data reconciliation.
---

# Meta Platform Compliance Guide

This skill serves as a guardrail before writing or modifying code that touches
Meta's APIs. **Read this before implementing any feature involving the Graph API,
Messenger webhooks, or Facebook Page data.**

---

## 1. Allowed API Access Patterns

### ✅ Polling via Graph API (READ)
- Standard `GET` requests to documented endpoints are allowed at any time
- Examples: `GET /{page-id}/posts`, `GET /{post-id}/comments`, `GET /me/conversations`
- Must use a valid `PAGE_ACCESS_TOKEN` or `META_ACCESS_TOKEN`
- Must stay within rate limits (see Section 3)

### ✅ Webhooks (PUSH from Meta)
- Subscribe to webhook fields via `POST /me/subscribed_apps`
- Currently subscribed: `messages`
- Available fields that can be added: `message_edits`, `message_reactions`, `feed`
- Webhooks are the preferred way to receive real-time updates

### ✅ Data Reconciliation (compare API vs DB)
- Fetch live data from the API, compare against stored records, prune orphans
- This is the approved pattern for detecting deleted comments and unsent messages
- Used in: `routes/scraper.js` (comment reconciliation), `jobs/messengerSync.js` (message sync)

---

## 2. Prohibited Patterns

### ❌ DO NOT scrape Facebook pages via HTML
- Never use Puppeteer, Cheerio, or any HTML scraper against facebook.com
- Always use the official Graph API

### ❌ DO NOT store data after user revokes access
- If a user deauthorizes the app, their data must be deletable upon request
- Meta sends a deauthorization callback when this happens

### ❌ DO NOT use data for surveillance or profiling
- Data collected from Messenger or comments must only be used for the stated purpose
  (disaster response coordination for MDRRMC Talisay Batangas)

### ❌ DO NOT share raw Messenger data with third parties
- Conversation data stays in your own database
- Aggregated/anonymized analytics are fine

### ❌ DO NOT send promotional or advertising messages via Messenger
- The bot must only respond to user-initiated messages
- Outbound messages must be responses within the 24-hour messaging window

---

## 3. Rate Limits

Meta enforces call-level rate limits on the Graph API:

| Metric | Limit |
|---|---|
| App-level | ~200 calls × number of users per hour |
| Minimum floor | ~4,800 calls/hour for any app |
| Per-user | 200 calls/user/hour |

### Calculating your budget
- **FB Scraper** (every 5 min): 1 call for posts + 1 call per post for comments ≈ 26 calls/tick → ~312/hour
- **Messenger Sync** (every 5 min): 2 calls per active sender (find thread + fetch MIDs)
- **Total estimate**: `312 + (active_senders × 2 × 12)` calls/hour

### Rate limit safety rules
1. Always implement cooldown/backoff when receiving HTTP 429 responses
2. Use caching where possible (e.g., `profileCache` in `utils/meta.js`)
3. Limit sync scope to recent activity (e.g., last 24 hours) to bound API calls
4. Add guard flags (`isScraping`, `isSyncing`) to prevent overlapping requests
5. Set minimum intervals: scraper ≥ 10s, messenger sync ≥ 30s

---

## 4. Webhook Limitations (Known Platform Blind Spots)

These are things Meta's webhook system does NOT notify you about:

| Event | Webhook available? | Workaround |
|---|---|---|
| New message received | ✅ Yes (`messages` field) | — |
| Message edited | ⚠️ Optional (`message_edits`) | Subscribe to it if needed |
| Message deleted/unsent | ❌ No | Poll `GET /{thread}/messages` and reconcile |
| Comment created | ⚠️ Via `feed` webhook | Or poll `GET /{post}/comments` |
| Comment edited | ❌ No | Upsert on scrape catches the new text |
| Comment deleted | ❌ No | Reconcile API response vs DB, prune orphans |

---

## 5. Required Permissions

The app needs these Facebook permissions to function:

| Permission | Used for |
|---|---|
| `pages_messaging` | Receiving/sending Messenger messages |
| `pages_read_engagement` | Reading page posts and comments |
| `pages_manage_metadata` | Subscribing to webhooks |
| `pages_read_user_content` | Reading user comments on page posts |

---

## 6. Data Handling Checklist

Before implementing any new feature that stores user data:

- [ ] Is the data necessary for the app's stated purpose (disaster response)?
- [ ] Is there a mechanism to delete it if the user requests removal?
- [ ] Is the data stored only in your own Supabase database (not shared externally)?
- [ ] Are you using the minimum data fields needed?
- [ ] Is personal data (names, PSIDs) handled with appropriate access controls?

---

## 7. Architecture Reference

```
Incoming data flow:
  Facebook → Webhook POST /webhook → index.js → Conversation.upsert() → Supabase
  Facebook → Graph API GET (polling) → scraper.js → FbPost/FbComment.upsert() → Supabase

Deletion detection:
  Graph API GET /{post}/comments → compare vs DB → FbComment.deleteByIds() (scraper.js)
  Graph API GET /{thread}/messages → compare vs DB → delete orphan rows (messengerSync.js)
```
