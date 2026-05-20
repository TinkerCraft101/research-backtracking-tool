"""
Research Backtracking Tool - FastAPI Backend
Parses research papers, extracts references, searches Semantic Scholar,
downloads open-access PDFs, and serves tree data to the frontend.
"""

import os
import re
import json
import asyncio
import hashlib
import unicodedata
from pathlib import Path
from datetime import datetime

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Research Backtracking Tool")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

LIBRARY_DIR = Path("library")
LIBRARY_DIR.mkdir(exist_ok=True)

# In-memory job storage
jobs = {}


# ─── Utility Functions ───────────────────────────────────────────────

def sanitize_filename(name: str) -> str:
    """Sanitize a string to be used as a folder/file name."""
    name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    name = re.sub(r'[^\w\s-]', '_', name)
    name = re.sub(r'\s+', '_', name)
    name = name.strip('_')[:100]
    return name or "untitled"


def extract_text_from_pdf(pdf_path: str) -> str:
    """Extract text from PDF using PyMuPDF."""
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text


def extract_paper_title(text: str) -> str:
    """Extract the title from the first page text (heuristic)."""
    lines = text.split('\n')
    title_lines = []
    for line in lines[:20]:
        line = line.strip()
        if len(line) > 10 and not line.lower().startswith(
            ('abstract', 'introduction', 'keywords', 'doi', 'http', 'arxiv')
        ):
            title_lines.append(line)
        if len(title_lines) >= 2:
            break
    return ' '.join(title_lines) if title_lines else "Untitled Paper"


# ─── Reference Extraction ────────────────────────────────────────────

def extract_references(text: str) -> list[str]:
    """Extract reference titles from the paper text. Max 20."""
    # Find the References/Bibliography section
    ref_match = re.search(
        r'(?:^|\n)\s*(?:References|Bibliography|REFERENCES|BIBLIOGRAPHY)\s*\n',
        text
    )
    if not ref_match:
        return []

    ref_text = text[ref_match.end():]

    # Strategy 1: Numbered [1], [2], ...
    refs = re.split(r'\n\s*\[\d+\]\s*', ref_text)
    refs = [r.strip() for r in refs if len(r.strip()) > 20]

    # Strategy 2: Numbered 1. 2. ...
    if not refs:
        refs = re.split(r'\n\s*\d+\.\s+', ref_text)
        refs = [r.strip() for r in refs if len(r.strip()) > 20]

    # Strategy 3: Paragraph-based
    if not refs:
        refs = re.split(r'\n\s*\n', ref_text)
        refs = [r.strip() for r in refs if len(r.strip()) > 20]

    # Extract titles from each reference string
    titles = []
    for ref in refs[:20]:
        title = _extract_title_from_ref(ref)
        if title and len(title) > 5:
            titles.append(title)

    return titles[:20]


def _extract_title_from_ref(ref: str) -> str:
    """Extract the title from a single reference string."""
    ref = ref.replace('\n', ' ').strip()

    # Try quoted title: "Title" or \u201cTitle\u201d
    quoted = re.search(r'["\u201c](.+?)["\u201d]', ref)
    if quoted and len(quoted.group(1)) > 10:
        return quoted.group(1).strip()

    # Try APA style: (Year). Title.
    apa = re.search(r'\(\d{4}\)\.\s*(.+?)\.', ref)
    if apa and len(apa.group(1)) > 10:
        return apa.group(1).strip()

    # Try after year: 2020. Title ... or 2020, Title ...
    year_match = re.search(r'(?:19|20)\d{2}[a-z]?\b[.,)]*\s*(.+?)(?:\.|$)', ref)
    if year_match and len(year_match.group(1)) > 10:
        candidate = re.sub(r'^[.,;:\s]+', '', year_match.group(1))
        if len(candidate) > 10:
            return candidate

    # Fallback: first 100 chars as search query
    return ref[:100].strip()


# ─── Semantic Scholar Integration ─────────────────────────────────────

async def search_semantic_scholar(title: str, client: httpx.AsyncClient) -> dict | None:
    """Search Semantic Scholar for a paper by title."""
    try:
        resp = await client.get(
            "https://api.semanticscholar.org/graph/v1/paper/search",
            params={
                "query": title[:200],
                "fields": "title,authors,year,openAccessPdf,url,externalIds",
                "limit": 1,
            },
            timeout=15.0,
        )
        if resp.status_code == 429:
            return {"rate_limited": True}
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("data") and len(data["data"]) > 0:
            return data["data"][0]
        return None
    except Exception:
        return None


async def download_pdf(url: str, save_path: str, client: httpx.AsyncClient) -> bool:
    """Download a PDF from a URL."""
    try:
        resp = await client.get(url, follow_redirects=True, timeout=30.0)
        if resp.status_code == 200 and len(resp.content) > 1000:
            with open(save_path, 'wb') as f:
                f.write(resp.content)
            return True
        return False
    except Exception:
        return False


# ─── Background Processing ────────────────────────────────────────────

async def process_references(job_id: str):
    """Background task: search and download each reference."""
    job = jobs[job_id]
    folder_path = LIBRARY_DIR / job["folder_name"]

    async with httpx.AsyncClient() as client:
        for i, ref_title in enumerate(job["references_raw"]):
            job["current"] = i + 1
            job["message"] = f"Searching reference {i+1}/{job['total']}: {ref_title[:50]}..."

            result = await search_semantic_scholar(ref_title, client)

            # Handle rate limiting with retry
            if result and result.get("rate_limited"):
                job["message"] = f"Rate limited — waiting 5s before retrying ({i+1}/{job['total']})..."
                await asyncio.sleep(5)
                result = await search_semantic_scholar(ref_title, client)

            if result and not result.get("rate_limited"):
                paper = {
                    "title": result.get("title", ref_title),
                    "authors": [a.get("name", "") for a in (result.get("authors") or [])[:3]],
                    "year": result.get("year"),
                    "downloaded": False,
                    "filename": None,
                    "paper_url": result.get("url", ""),
                    "status": "found",
                }

                # Try to download open-access PDF
                oa = result.get("openAccessPdf")
                if oa and oa.get("url"):
                    pdf_name = sanitize_filename(result.get("title", f"ref_{i+1}")) + ".pdf"
                    save_path = folder_path / pdf_name
                    job["message"] = f"Downloading {i+1}/{job['total']}: {result.get('title','')[:50]}..."

                    if await download_pdf(oa["url"], str(save_path), client):
                        paper["downloaded"] = True
                        paper["filename"] = pdf_name
                        paper["status"] = "downloaded"
                    else:
                        paper["status"] = "download_failed"
                else:
                    paper["status"] = "paywalled"

                job["references_processed"].append(paper)
            else:
                job["references_processed"].append({
                    "title": ref_title,
                    "authors": [],
                    "year": None,
                    "downloaded": False,
                    "filename": None,
                    "paper_url": None,
                    "status": "not_found",
                })

            # Respect rate limits
            await asyncio.sleep(1)

    # Build final tree data
    dl = sum(1 for r in job["references_processed"] if r["downloaded"])
    pw = sum(1 for r in job["references_processed"] if r["status"] in (
        "paywalled", "not_found", "rate_limited", "download_failed"
    ))

    job["tree_data"] = {
        "root": {
            "title": job["paper_title"],
            "filename": job["original_filename"],
            "folder": job["folder_name"],
            "is_root": True,
        },
        "children": job["references_processed"],
        "stats": {"total": job["total"], "downloaded": dl, "paywalled": pw},
    }
    job["status"] = "done"
    job["message"] = f"Done! Downloaded {dl}/{job['total']} PDFs ({pw} unavailable)"


# ─── API Endpoints ────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_paper(file: UploadFile = File(...)):
    """Upload a PDF and start reference processing."""
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    content = await file.read()

    # Save temp file
    temp_path = f"temp_{hashlib.md5(content).hexdigest()}.pdf"
    with open(temp_path, 'wb') as f:
        f.write(content)

    try:
        text = extract_text_from_pdf(temp_path)
        title = extract_paper_title(text)
        references = extract_references(text)
    except Exception as e:
        os.remove(temp_path)
        raise HTTPException(status_code=500, detail=f"Failed to parse PDF: {str(e)}")

    # Create library folder
    folder_name = sanitize_filename(title)
    folder_path = LIBRARY_DIR / folder_name
    folder_path.mkdir(exist_ok=True)

    # Move uploaded file to library
    original_fn = sanitize_filename(file.filename.rsplit('.', 1)[0]) + '.pdf'
    os.replace(temp_path, str(folder_path / original_fn))

    # Create job
    job_id = hashlib.md5(f"{title}{datetime.now().isoformat()}".encode()).hexdigest()[:12]
    jobs[job_id] = {
        "status": "processing",
        "folder_name": folder_name,
        "paper_title": title,
        "original_filename": original_fn,
        "references_raw": references,
        "references_processed": [],
        "current": 0,
        "total": len(references),
        "message": "Starting reference search...",
        "tree_data": None,
    }

    asyncio.create_task(process_references(job_id))

    return {
        "job_id": job_id,
        "folder_name": folder_name,
        "paper_title": title,
        "total_references": len(references),
    }


@app.get("/api/progress/{job_id}")
async def get_progress(job_id: str):
    """SSE endpoint streaming progress updates."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_stream():
        while True:
            job = jobs.get(job_id)
            if not job:
                break

            payload = {
                "status": job["status"],
                "message": job["message"],
                "current": job["current"],
                "total": job["total"],
            }
            if job["status"] == "done":
                payload["tree_data"] = job["tree_data"]

            yield f"data: {json.dumps(payload)}\n\n"

            if job["status"] == "done":
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/pdf/{folder}/{filename}")
async def serve_pdf(folder: str, filename: str):
    """Serve a PDF from the library."""
    pdf_path = LIBRARY_DIR / folder / filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="PDF not found")
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename={filename}"},
    )


# ─── Static Files & Entry Point ──────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse("public/index.html")


app.mount("/public", StaticFiles(directory="public"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
