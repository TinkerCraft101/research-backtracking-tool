# Research Backtracking Tool — Project Design v0.0.1

## Overview
A web application that parses research papers, extracts references, downloads available PDFs, and visualizes the citation tree with an embedded PDF viewer.

## Core Features (v0.0.1)
1. **PDF Upload**: Dashed-border circle with `+` icon — drag-and-drop or click-to-browse
2. **Reference Extraction**: Parse PDF text via PyMuPDF, regex-extract citation titles (all references)
3. **Paper Search & Download**: Search via Semantic Scholar API, download open-access PDFs
4. **Tree Visualization**: Root paper → reference child nodes (1 level deep)
5. **PDF Viewer**: Click available node → animates/expands into embedded PDF viewer
6. **Paywall Handling**: Paywalled papers shown as dimmed nodes, hover reveals "View on Web" link

## Architecture

```
┌──────────────────────┐       REST API       ┌──────────────────────┐
│   Frontend (Static)  │ ◄──────────────────► │ Backend (FastAPI)     │
│   HTML/CSS/JS        │                      │ PyMuPDF parsing       │
│   Tree Visualization │                      │ Semantic Scholar API  │
│   pdf.js Viewer      │                      │ PDF Downloads         │
└──────────────────────┘                      └──────────────────────┘
                                                       │
                                                       ▼
                                             ┌──────────────────────┐
                                             │  library/<paper>/    │
                                             │  Downloaded PDFs     │
                                             └──────────────────────┘
```

## Tech Stack
- **Backend**: Python (FastAPI) + uvicorn
- **PDF Parsing**: PyMuPDF (fitz)
- **HTTP Client**: httpx (async)
- **Paper Search**: Semantic Scholar API (free, no key)
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **PDF Viewer**: pdf.js (pdfjs-dist via CDN)

## Design Decisions
- **Python backend** chosen over Node.js to future-proof for AI features (v0.1.0+)
- **Semantic Scholar** over web crawling (reliable, structured, free)
- **All references** extracted per paper (no artificial limit)
- **No database** in v0.0.1 — filesystem-based storage
- **Real-time progress feedback** during reference processing

## Storage
- `library/<sanitized_paper_name>/` — original upload + downloaded reference PDFs

## Future Roadmap
- v0.1.0: AI-powered features (summarization, relevance scoring)
- v0.2.0: Supabase database integration
- v0.3.0: Multi-level citation tree traversal
