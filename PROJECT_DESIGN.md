# Research Backtracking Tool — Project Design v0.0.1

## Overview
A web application that parses research papers, extracts references, downloads available PDFs, and visualizes the citation tree with an embedded PDF viewer.

## Core Features (v0.0.1)
1. **PDF Upload**: Drag-and-drop or click-to-upload research papers
2. **Reference Extraction**: Parse PDF text and extract citation titles
3. **Paper Search & Download**: Search references via Semantic Scholar API, download open-access PDFs
4. **Tree Visualization**: Root paper → reference child nodes (1 level deep, max 20 references)
5. **PDF Viewer**: Click a node → it animates/expands into a PDF viewer

## Architecture

```
┌─────────────────────┐       REST API        ┌──────────────────────┐
│   Frontend (Static) │ ◄──────────────────► │   Backend (Server)    │
│   HTML/CSS/JS       │                       │   PDF Parsing         │
│   Tree Viz          │                       │   Semantic Scholar    │
│   pdf.js Viewer     │                       │   PDF Downloads       │
└─────────────────────┘                       └──────────────────────┘
                                                        │
                                                        ▼
                                              ┌──────────────────────┐
                                              │  library/<paper>/    │
                                              │  Downloaded PDFs     │
                                              └──────────────────────┘
```

## Storage
- `library/<sanitized_paper_name>/` — downloaded reference PDFs + original upload
- No database in v0.0.1 (filesystem-based)

## Future Plans
- v0.1.0: AI-powered features (summarization, relevance scoring, etc.)
- v0.2.0: Supabase database integration
- Deeper citation tree traversal (multi-level)

## Tech Stack
- **Frontend**: Vanilla HTML, CSS, JavaScript
- **PDF Viewer**: pdf.js (pdfjs-dist)
- **Paper Search**: Semantic Scholar API (free, no key)
- **Backend**: TBD (see design iteration notes)

## Design Constraints
- Max 20 references processed per paper
- Rate-limited API calls (1 req/sec to Semantic Scholar)
- Only open-access PDFs can be downloaded; paywalled papers show dimmed with link-out
