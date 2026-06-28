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
UNPAYWALL_EMAIL = "research@example.com"


def _arxiv_query_variants(title: str) -> list[str]:
    """Generate multiple query variants for flexible arXiv searching."""
    variants = [title.strip()]
    t = title.strip()

    # Remove subtitle after colon
    idx = t.find(": ")
    if 20 < idx < len(t) - 10:
        variants.append(t[:idx])

    # First 4-5 significant words
    words = [w for w in t.split() if len(w) > 2]
    if len(words) > 5:
        variants.append(" ".join(words[:5]))
    elif len(words) > 3:
        variants.append(" ".join(words[:4]))

    # Remove parenthesized parts
    cleaned = re.sub(r'\([^)]*\)', '', t).strip()
    if cleaned != t and len(cleaned) > 15:
        variants.append(cleaned)

    # Remove leading numbering/authors
    cleaned = re.sub(r'^\[?\d+\]?[.\s)]*', '', t).strip()
    cleaned = re.sub(r'^[A-Z][a-z]+,\s*[A-Z][a-z]+.*?,\s+', '', cleaned).strip()
    if cleaned != t and len(cleaned) > 10:
        variants.append(cleaned)

    seen = set()
    return [s for s in variants if not (s in seen or seen.add(s))]


def _parse_arxiv_entry(entry) -> dict | None:
    """Parse a single arXiv Atom entry into a paper dict."""
    try:
        title_el = entry.find("atom:title", ARXIV_NS)
        paper_title = title_el.text.strip() if title_el is not None and title_el.text else ""
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

        if not paper_title or not pdf_link:
            return None

        # Extract author names
        authors = []
        for author_el in entry.findall("atom:author", ARXIV_NS):
            name_el = author_el.find("atom:name", ARXIV_NS)
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())

        # Extract year from published date
        pub_el = entry.find("atom:published", ARXIV_NS)
        year = pub_el.text[:4] if pub_el is not None and pub_el.text else None

        return {
            "title": paper_title,
            "authors": authors[:3],
            "year": year,
            "paper_url": paper_url,
            "openAccessPdf": {"url": pdf_link},
        }
    except Exception:
        return None


def _title_similarity(a: str, b: str) -> float:
    """Simple word-overlap similarity between two title strings."""
    a_words = set(a.lower().split())
    b_words = set(b.lower().split())
    if not a_words or not b_words:
        return 0.0
    intersection = a_words & b_words
    return len(intersection) / max(len(a_words), len(b_words))


async def search_arxiv(title: str, client: httpx.AsyncClient) -> dict | None:
    """Search arXiv with multiple flexible query strategies. No key needed."""
    candidates = []
    seen_ids = set()

    for variant in _arxiv_query_variants(title):
        try:
            resp = await client.get(
                "https://export.arxiv.org/api/query",
                params={"search_query": f'all:"{variant[:200]}"', "max_results": 5},
                timeout=15.0,
            )
            if resp.status_code != 200:
                continue

            root = ET.fromstring(resp.text)
            for entry in root.findall("atom:entry", ARXIV_NS):
                id_el = entry.find("atom:id", ARXIV_NS)
                entry_id = id_el.text if id_el is not None else ""
                if entry_id in seen_ids:
                    continue
                seen_ids.add(entry_id)

                paper = _parse_arxiv_entry(entry)
                if paper and paper.get("openAccessPdf"):
                    candidates.append(paper)
        except Exception:
            continue

    if not candidates:
        return None

    # Pick best match by title similarity
    candidates.sort(key=lambda p: _title_similarity(title, p["title"]), reverse=True)
    return candidates[0]


async def search_openalex(title: str, client: httpx.AsyncClient) -> dict | None:
    """Search OpenAlex by title. No key needed, generous rate limits."""
    try:
        resp = await client.get(
            "https://api.openalex.org/works",
            params={
                "search": title[:300],
                "per_page": 5,
                "select": "title,authorships,publication_year,doi,primary_location,best_oa_location,open_access",
            },
            timeout=15.0,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        results = data.get("results", [])
        if not results:
            return None

        # Sort by relevance (OpenAlex returns best first, but double-check with title similarity)
        best = max(results, key=lambda r: _title_similarity(title, r.get("title", "")))

        paper_title = best.get("title", title)
        authors = []
        for a in (best.get("authorships") or [])[:3]:
            if a.get("author", {}).get("display_name"):
                authors.append(a["author"]["display_name"])

        doi = best.get("doi")
        oa_location = best.get("best_oa_location") or {}
        pdf_url = oa_location.get("pdf_url")

        return {
            "title": paper_title,
            "authors": authors,
            "year": best.get("publication_year"),
            "paper_url": doi or "",
            "doi": doi,
            "openAccessPdf": {"url": pdf_url} if pdf_url else None,
        }
    except Exception:
        return None


async def search_unpaywall(doi: str, client: httpx.AsyncClient) -> str | None:
    """Check Unpaywall for an OA copy via DOI. No key needed (just an email param)."""
    try:
        resp = await client.get(
            f"https://api.unpaywall.org/v2/{doi}?email={UNPAYWALL_EMAIL}",
            timeout=15.0,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        best_loc = data.get("best_oa_location") or {}
        pdf_url = best_loc.get("url_for_pdf")
        return pdf_url
    except Exception:
        return None


async def search_paper(title: str, client: httpx.AsyncClient) -> dict:
    """Search across arXiv → OpenAlex → Unpaywall. No API keys needed."""
    # 1. Try arXiv first (flexible, covers most ML/CS papers)
    arxiv_result = await search_arxiv(title, client)
    if arxiv_result and arxiv_result.get("openAccessPdf"):
        return arxiv_result

    # 2. Try OpenAlex (covers ACL, JMLR, NeurIPS, journal venues, etc.)
    oa_result = await search_openalex(title, client)
    if oa_result:
        # OpenAlex found a PDF directly
        if oa_result.get("openAccessPdf"):
            return {
                "title": oa_result["title"],
                "authors": oa_result["authors"],
                "year": oa_result["year"],
                "paper_url": oa_result["paper_url"],
                "openAccessPdf": oa_result["openAccessPdf"],
            }
        # OpenAlex found the paper but no PDF — try Unpaywall via DOI
        if oa_result.get("doi"):
            pdf_url = await search_unpaywall(oa_result["doi"], client)
            if pdf_url:
                return {
                    "title": oa_result["title"],
                    "authors": oa_result["authors"],
                    "year": oa_result["year"],
                    "paper_url": oa_result["paper_url"],
                    "openAccessPdf": {"url": pdf_url},
                }
        # Paper identified but no OA copy available
        return {
            "title": oa_result["title"],
            "authors": oa_result["authors"],
            "year": oa_result["year"],
            "paper_url": oa_result["paper_url"],
            "openAccessPdf": None,
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
                "depth": depth,
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
            "depth": depth,
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

                # Recurse into this paper's references (cap at 4 per node)
                if depth < max_depth:
                    try:
                        text = extract_text_from_pdf(str(save_path))
                        sub_refs = extract_references(text)
                        if sub_refs:
                            sub_refs = sub_refs[:4]
                            job["total"] += len(sub_refs)
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

    for child in children:
        _add_subtree_size(child)
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
        root_node = {
            "title": title,
            "filename": f"{root_name}.pdf",
            "folder": str(root_save_dir.relative_to(LIBRARY_DIR)),
            "children": [],
            "depth": 0,
        }
        _add_subtree_size(root_node)
        job["tree_data"] = {"root": root_node}
        return

    async with httpx.AsyncClient() as client:
        children = await process_node(
            job_id, references, depth=1, max_depth=max_depth,
            root_name=root_name, client=client
        )

    dl_count = sum(1 for c in _count_nodes(children) if c["status"] == "downloaded")
    pw_count = sum(1 for c in _count_nodes(children) if c["status"] == "paywalled")
    nf_count = sum(1 for c in _count_nodes(children) if c["status"] == "not_found")

    root_node = {
        "title": title,
        "filename": f"{root_name}.pdf",
        "folder": str(root_save_dir.relative_to(LIBRARY_DIR)),
        "children": children,
        "depth": 0,
    }
    _add_subtree_size(root_node)
    job["tree_data"] = {
        "root": root_node,
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


def _add_subtree_size(node: dict) -> int:
    """Recursively compute and set subtreeSize on each node (includes self)."""
    size = 1
    for child in node.get("children", []):
        size += _add_subtree_size(child)
    node["subtreeSize"] = size
    return size


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


@app.post("/api/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a running job."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    if job["status"] in ("done", "error", "cancelled"):
        raise HTTPException(status_code=400, detail="Job is already finished or cancelled")
    job["status"] = "cancelled"
    job["message"] = "Cancelled by user"
    return {"status": "cancelled"}


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
    return FileResponse("src/index.html")


app.mount("/public", StaticFiles(directory="src"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", port=8000, reload=True)
