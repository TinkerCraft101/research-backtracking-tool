# Research Tree

This is a research backtracking tool, it takes your uploaded paper (root) -> parses reference section -> displays all reference papers (branchs) and each of their reference papers (leafs). 

Discalimer 

This repository is still in it's building phase and its prue to errors. do use this with causion. 
The README is incomplete as the repository is still in building phase.

## Features 
 - pdf viewer
 - custom depth
 - bgm
 - library
 - summarizer
 - knowledge base per shelf
 - chat history/persistent
 

## How it works

1. Parses user uploaded research paper to collect all the reference papers.
2. searches semantic scholar using the DOI and downloads the pdf. 
3. displays the connectiong between papers as tree structure
4. clicking on the paper allows for viewing them 


## TODO
- [x] tool to parse the paper and collect research papers
- [x] display them in tree structure
- [x] add clickable pdf viewer
- [ ] move the stroage to supabase
- [ ] build a working page and publish the app [v0.1.0]
- [ ] add stop button
- [ ] build parsing frame - decide how much papers to trace and display, add modes (quick, full sweep)


## Bugs
- [ ] no limiter for parsing - root -> 40 brach -> 200 leaves
- [ ] fix UI styling
