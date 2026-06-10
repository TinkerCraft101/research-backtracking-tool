"""
Research Backtracking Tool - FastAPI Backend
Parses research papers, extracts references, searches multiple sources,
downloads open-access PDFs, recursively builds citation tree.
"""

import os
import re
import json
import asyncio
import hashlib
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime

import fitz
import httpx
from fastapi import FastAPI, UploadFile, File, HTTPException, Query
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
ROOT_DIR = LIBRARY_DIR / "root"
BRANCH_DIR = LIBRARY_DIR / "branch"
ROOT_DIR.mkdir(parents=True, exist_ok=True)
BRANCH_DIR.mkdir(parents=True, exist_ok=True)

jobs = {}


# ─── Utility Functions ───────────────────────────────────────────────

def sanitize_filename(name: str) -> str:
    name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    name = re.sub(r'[^\w\s-]', '_', name)
    name = re.sub(r'\s+', '_', name)
    name = name.strip('_')[:100]
    return name or "untitled"


def extract_text_from_pdf(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text


def extract_paper_title(text: str) -> str:
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
    ref_match = re.search(
        r'(?:^|\n)\s*(?:References|Bibliography|REFERENCES|BIBLIOGRAPHY)\s*\n',
        text
    )
    if not ref_match:
        return []

    ref_text = text[ref_match.end():]

    refs = re.split(r'\n\s*\[\d+\]\s*', ref_text)
    refs = [r.strip() for r in refs if len(r.strip()) > 20]

    if not refs:
        refs = re.split(r'\n\s*\d+\.\s+', ref_text)
        refs = [r.strip() for r in refs if len(r.strip()) > 20]

    if not refs:
        refs = re.split(r'\n\s*\n', ref_text)
        refs = [r.strip() for r in refs if len(r.strip()) > 20]

    titles = []
    for ref in refs:
        title = _extract_title_from_ref(ref)
        if title and len(title) > 5:
            titles.append(title)

    return titles


def _extract_title_from_ref(ref: str) -> str:
    ref = ref.replace('\n', ' ').strip()

    # Quoted title: "Title" or \u201cTitle\u201d
    quoted = re.search(r'["\u201c](.+?)["\u201d]', ref)
    if quoted and len(quoted.group(1)) > 10:
        return quoted.group(1).strip()

    # Remove leading numbering like [1], 1., (1)
    ref = re.sub(r'^\[?\d+\]?[.\s)]*', '', ref).strip()

    # APA: (Year). Title.
    m = re.search(r'\((\d{4})[a-z]?\)[.\s]+(.+?)(?:\.\s|$)', ref)
    if m and len(m.group(2)) > 10:
        t = re.sub(r'^["\u201c]|["\u201d]+$', '', m.group(2)).strip()
        return t

    # IEEE: author, "Title", in Proc/Journal, vol, year.
    m = re.search(r'["\u201c](.+?)["\u201d]', ref)
    if m and len(m.group(1)) > 10:
        return m.group(1).strip()

    # Year-based: Title (Year) or Title. Year
    m = re.search(r'([A-Z][A-Za-z0-9\s:;,.!?]{15,120})\.?\s*\(?(?:19|20)\d{2}\)?', ref)
    if m and len(m.group(1)) > 10:
        return m.group(1).strip()

    # After year: (2020). Title. or (2020, Title)
    m = re.search(r'(?:19|20)\d{2}[a-z]?\b[.,)]*\s+(.+?)(?:\.\s[A-Z]|$)', ref)
    if m and len(m.group(1)) > 10:
        return re.sub(r'^[.,;:\s]+', '', m.group(1)).strip()

    # Sentence starting after author names: "... Author. Title."
    m = re.search(r'\.\s+([A-Z][A-Za-z0-9\s:;,]{15,120})', ref)
    if m and len(m.group(1)) > 10:
        return m.group(1).strip()

    # Fallback: remove leading author list (up to last comma before a phrase starting with uppercase)
    # Try to split on " and " then take last part, or after last period
    parts = re.split(r'\.\s+', ref)
    if len(parts) >= 2:
        best = max(parts, key=len).strip()
        if len(best) > 15:
            return best[:200].strip()

    return ref[:200].strip()


# ─── Multi-Source Search ─────────────────────────────────────────────

ARXIV_NS = {"atom": "http://www.w3.org/2005/Atom"}


async def search_semantic_scholar(title: str, client: httpx.AsyncClient) -> dict | None:
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


async def search_arxiv(title: str, client: httpx.AsyncClient) -> dict | None:
    try:
        resp = await client.get(
            "https://export.arxiv.org/api/query",
            params={"search_query": f'all:"{title[:200]}"', "max_results": 1},
            timeout=15.0,
        )
        if resp.status_code != 200:
            return None

        root = ET.fromstring(resp.text)
        entry = root.find("atom:entry", ARXIV_NS)
        if entry is None:
            return None

        title_el = entry.find("atom:title", ARXIV_NS)
        paper_title = title_el.text.strip() if title_el is not None and title_el.text else title
        # arXiv titles often have newlines
        paper_title = re.sub(r'\s+', ' ', paper_title)

        id_el = entry.find("atom:id", ARXIV_NS)
        paper_url = id_el.text.strip() if id_el is not None and id_el.text else None

        pdf_link = None
        for link in entry.findall("atom:link", ARXIV_NS):
            if link.get("title") == "pdf":
                pdf_link = link.get("href")
                break
        if not pdf_link:
            for link in entry.findall("atom:link", ARXIV_NS):
                if link.get("type") == "application/pdf":
                    pdf_link = link.get("href")
                    break

        return {
            "title": paper_title,
            "openAccessPdf": {"url": pdf_link} if pdf_link else None,
            "url": paper_url,
        }
    except Exception:
        return None


def _generate_queries(title: str) -> list[str]:
    """Generate multiple search queries from a raw title string, best first."""
    queries = [title.strip()]
    t = title.strip()

    # Remove leading numbering/authors
    cleaned = re.sub(r'^\[?\d+\]?[.\s)]*', '', t).strip()
    cleaned = re.sub(r'^[A-Z][a-z]+,\s*[A-Z][a-z]+.*?,\s+', '', cleaned).strip()
    if cleaned != t and len(cleaned) > 10:
        queries.append(cleaned)

    # Try quoted substring
    m = re.search(r'["\u201c](.{15,})["\u201d]', t)
    if m:
        queries.append(m.group(1).strip())

    # Try after year
    m = re.search(r'(?:19|20)\d{2}[.,\s]+(.{15,})', t)
    if m:
        queries.append(m.group(1).strip())

    # First sentence after a period
    m = re.search(r'\.\s+([A-Z][^.]{15,})', t)
    if m:
        queries.append(m.group(1).strip())

    # Shorten long queries: first 80 chars
    if len(t) > 80:
        queries.append(t[:80].strip())

    # Title-case part
    m = re.search(r'([A-Z][A-Za-z0-9\s:;,]{20,60})', t)
    if m and len(m.group(1)) > 15:
        queries.append(m.group(1).strip())

    return list(dict.fromkeys(q for q in queries if len(q) > 15))


async def search_paper(title: str, client: httpx.AsyncClient) -> dict:
    """Search across multiple sources with query retry."""
    queries = _generate_queries(title)

    for q in queries:
        # Try Semantic Scholar
        result = await search_semantic_scholar(q, client)
        if result and not result.get("rate_limited"):
            return {
                "title": result.get("title", title),
                "authors": [a.get("name", "") for a in (result.get("authors") or [])[:3]],
                "year": result.get("year"),
                "paper_url": result.get("url", ""),
                "openAccessPdf": result.get("openAccessPdf"),
            }
        if result and result.get("rate_limited"):
            continue  # try next query

    # Try arXiv with best query
    best_q = next((q for q in queries if len(q) < 200), title[:200])
    result = await search_arxiv(best_q, client)
    if result and result.get("openAccessPdf"):
        return {
            "title": result.get("title", title),
            "authors": [],
            "year": None,
            "paper_url": result.get("url", ""),
            "openAccessPdf": result.get("openAccessPdf"),
        }

    return {"title": title, "not_found": True}


# ─── PDF Download ─────────────────────────────────────────────────────

async def download_pdf(url: str, save_path: str, client: httpx.AsyncClient) -> bool:
    try:
        resp = await client.get(url, follow_redirects=True, timeout=30.0)
        if resp.status_code == 200 and len(resp.content) > 1000:
            with open(save_path, 'wb') as f:
                f.write(resp.content)
            return True
        return False
    except Exception:
        return False


# ─── Recursive Processing ─────────────────────────────────────────────

async def process_node(
    job_id: str,
    ref_titles: list[str],
    depth: int,
    max_depth: int,
    root_name: str,
    client: httpx.AsyncClient,
) -> list[dict]:
    """Recursively process references at a given depth level."""
    job = jobs[job_id]
    children = []

    for i, ref_title in enumerate(ref_titles):
        if job["status"] == "cancelled":
            return children

        job["current"] += 1
        job["message"] = f"Searching (depth {depth}): {ref_title[:60]}..."

        # Search across multiple sources
        paper = await search_paper(ref_title, client)

        if paper.get("not_found"):
            children.append({
                "title": ref_title,
                "authors": [],
                "year": None,
                "filename": None,
                "folder": None,
                "paper_url": None,
                "status": "not_found",
                "children": [],
            })
            await asyncio.sleep(0.5)
            continue

        child = {
            "title": paper["title"],
            "authors": paper.get("authors", []),
            "year": paper.get("year"),
            "filename": None,
            "folder": None,
            "paper_url": paper.get("paper_url", ""),
            "status": "found",
            "children": [],
        }

        # Try to download PDF
        oa = paper.get("openAccessPdf")
        if oa and oa.get("url"):
            pdf_name = sanitize_filename(paper.get("title", f"ref_{i+1}")) + ".pdf"

            # Depth 1 = branch level, stored in branch/{root_name}/
            # Depth >= 2 = leaf level, stored in branch/{root_name}/{parent}/
            save_dir = BRANCH_DIR / root_name
            if depth >= 2:
                parent_name = sanitize_filename(paper.get("title", "unknown"))
                save_dir = save_dir / parent_name
            save_dir.mkdir(parents=True, exist_ok=True)
            save_path = save_dir / pdf_name

            job["message"] = f"Downloading (depth {depth}): {paper['title'][:60]}..."
            if await download_pdf(oa["url"], str(save_path), client):
                child["filename"] = pdf_name
                child["folder"] = str(save_dir.relative_to(LIBRARY_DIR))
                child["status"] = "downloaded"

                # Recurse into this paper's references
                if depth < max_depth:
                    try:
                        text = extract_text_from_pdf(str(save_path))
                        sub_refs = extract_references(text)
                        if sub_refs:
                            sub_children = await process_node(
                                job_id, sub_refs, depth + 1, max_depth,
                                root_name, client
                            )
                            child["children"] = sub_children
                    except Exception as e:
                        pass
        else:
            child["status"] = "paywalled" if paper.get("paper_url") else "not_found"

        children.append(child)
        await asyncio.sleep(0.8)

    return children


# ─── Background Job ───────────────────────────────────────────────────

async def run_job(job_id: str, pdf_path: str, max_depth: int):
    """Background task: build the full citation tree."""
    job = jobs[job_id]

    try:
        text = extract_text_from_pdf(pdf_path)
        title = extract_paper_title(text)
        references = extract_references(text)
    except Exception as e:
        job["status"] = "error"
        job["message"] = f"Failed to parse PDF: {str(e)}"
        return

    job["paper_title"] = title
    job["references_raw"] = references
    job["current"] = 0
    job["total"] = len(references)
    job["message"] = f"Found {len(references)} references, starting search..."

    root_name = sanitize_filename(title)

    # Move uploaded file to library/root/{root_name}/
    root_save_dir = ROOT_DIR / root_name
    root_save_dir.mkdir(parents=True, exist_ok=True)
    root_pdf_path = root_save_dir / f"{root_name}.pdf"
    os.replace(pdf_path, str(root_pdf_path))

    if not references:
        job["status"] = "done"
        job["message"] = "No references found in this paper."
        job["tree_data"] = {
            "root": {
                "title": title,
                "filename": f"{root_name}.pdf",
                "folder": str(root_save_dir.relative_to(LIBRARY_DIR)),
                "children": [],
            }
        }
        return

    async with httpx.AsyncClient() as client:
        children = await process_node(
            job_id, references, depth=1, max_depth=max_depth,
            root_name=root_name, client=client
        )

    dl_count = sum(1 for c in _count_nodes(children) if c["status"] == "downloaded")
    pw_count = sum(1 for c in _count_nodes(children) if c["status"] == "paywalled")
    nf_count = sum(1 for c in _count_nodes(children) if c["status"] == "not_found")

    job["tree_data"] = {
        "root": {
            "title": title,
            "filename": f"{root_name}.pdf",
            "folder": str(root_save_dir.relative_to(LIBRARY_DIR)),
            "children": children,
        },
        "stats": {
            "total": job["total"],
            "downloaded": dl_count,
            "paywalled": pw_count,
            "not_found": nf_count,
        },
    }
    job["status"] = "done"
    job["message"] = f"Done! {dl_count} downloaded, {pw_count} paywalled, {nf_count} not found"


def _count_nodes(nodes: list[dict]) -> list[dict]:
    """Flatten all nodes in a tree for counting."""
    result = []
    for n in nodes:
        result.append(n)
        if n.get("children"):
            result.extend(_count_nodes(n["children"]))
    return result


# ─── API Endpoints ────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_paper(
    file: UploadFile = File(...),
    depth: int = Query(2, ge=1, le=5, description="Tree depth (1=root→refs, 2=root→refs→subrefs, ...)"),
):
    """Upload a PDF and recursively build a citation tree."""
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    content = await file.read()

    temp_path = f"temp_{hashlib.md5(content).hexdigest()}.pdf"
    with open(temp_path, 'wb') as f:
        f.write(content)

    # Quick parse to get title and references for the response
    try:
        text = extract_text_from_pdf(temp_path)
        title = extract_paper_title(text)
        references = extract_references(text)
    except Exception as e:
        os.remove(temp_path)
        raise HTTPException(status_code=500, detail=f"Failed to parse PDF: {str(e)}")

    job_id = hashlib.md5(f"{title}{datetime.now().isoformat()}".encode()).hexdigest()[:12]
    jobs[job_id] = {
        "status": "processing",
        "paper_title": title,
        "references_raw": references,
        "current": 0,
        "total": len(references),
        "message": "Queued...",
        "tree_data": None,
    }

    # Launch background job with depth parameter
    asyncio.create_task(run_job(job_id, temp_path, max_depth=depth))

    return {
        "job_id": job_id,
        "paper_title": title,
        "total_references": len(references),
        "depth": depth,
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
            elif job["status"] == "error":
                payload["message"] = job["message"]

            yield f"data: {json.dumps(payload)}\n\n"

            if job["status"] in ("done", "error"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/pdf/{folder:path}/{filename}")
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


@app.get("/api/tree/{job_id}")
async def get_tree(job_id: str):
    """Get the final tree data for a completed job."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="Job still processing")
    return job["tree_data"]


# ─── Static Files & Entry Point ──────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse("public/index.html")


app.mount("/public", StaticFiles(directory="src"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", port=8000, reload=True)
