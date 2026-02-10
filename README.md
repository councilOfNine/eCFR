# eCFR Regulation Analyzer

A full-stack application for analyzing the electronic Code of Federal Regulations (eCFR). Browse agencies, view word counts, read regulation text, and track revision history with inline diffs.

## Prerequisites

- **Node.js** >= 18
- **npm** or **pnpm**

## Project Structure

```
├── client/          # React frontend (Vite + TailwindCSS)
│   └── src/
│       ├── pages/   # Dashboard, AgencyDetail, RegulationView
│       ├── lib/     # API client, utilities
│       └── store/   # Zustand state
├── server/          # Express backend
│   └── src/
│       ├── routes/  # API route handlers
│       ├── services/# eCFR client, ingestion logic
│       ├── db.js    # SQLite setup
│       └── swagger.js # OpenAPI documentation
└── README.md
```

## Installation

```bash
# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install
```

## Running

Start both the backend and frontend in separate terminals:

```bash
# Terminal 1 — Start the API server (port 3001)
cd server
npm run dev

# Terminal 2 — Start the frontend dev server (port 5173)
cd client
npm run dev
```

Then open **http://localhost:5173** in your browser.

## First-Time Setup

1. Open the dashboard at http://localhost:5173
2. Click **Quick Ingest** to fetch agencies and titles from eCFR (~10 seconds)
3. Click **Full Ingest** to download all CFR content and compute word counts (~5-15 minutes)

## API Documentation

Interactive Swagger docs are available at:

**http://localhost:3001/api/docs**

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/stats` | Overall statistics and ingest status |
| `GET` | `/api/agencies` | List all agencies |
| `GET` | `/api/agencies/:slug` | Agency detail with CFR content and history |
| `GET` | `/api/wordcounts` | Precomputed word counts per agency |
| `POST` | `/api/wordcounts/compute` | Recompute word counts |
| `GET` | `/api/regulation/:title/structure` | Table of contents for a CFR title |
| `GET` | `/api/regulation/:title/content` | Regulation text for a specific part |
| `GET` | `/api/regulation/:title/versions` | Revision history grouped by date |
| `GET` | `/api/regulation/:title/diff` | Line-level text diff between revisions |
| `POST` | `/api/ingest/quick` | Fetch agencies and titles |
| `POST` | `/api/ingest/full` | Full content ingest with word counts |
| `GET` | `/api/ingest/status` | Current ingest status |

## Tech Stack

**Frontend:** React 19, Vite, TailwindCSS, TanStack Query, Zustand, React Router, Lucide Icons

**Backend:** Express, better-sqlite3, Swagger UI

**Data Source:** [eCFR API](https://www.ecfr.gov/developer/documentation/api/v1)
