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
- [x] start building depths - figuring out on how to add more research papers
- [x] add detailed and compact views - map viewer example
- [ ] add underlining, highlight, etc edits inside pdf viewer (it's persistent)
- [ ] add bookmark option
- [ ] add the library to supabase
- [ ] move the stroage to supabase
- [ ] add authentication system, for user's having their own supabase storage
- [ ] add stop button for the whole process
- [ ] add zoom in changes in pdf 10 -> 20 -> 30 -> 40 -> 50 -> 60 -> .... -> 100 -> 125 -> 150 -> 175 -> 200
- [ ] add zoom in/out using mousepad, direct input
- [ ] build a working page and publish the app [v0.1.0]
- [ ] build parsing frame - decide how much papers to trace and display, add modes (quick, full sweep)

## Bugs
- [x] no limiter for parsing - root -> 40 brach -> 200 leaves
- [ ] fix UI styling
- [ ] fix the parser
- [ ] fix the pdf veiwer size %, 50% should be the 100% and 100% to be 200%
- [ ] build the animation, for displaying the reference papers
- [ ] keep it compact, currently the size of the nodes doesn't resize. fix it
- [ ] when adding more dpeth it shows 1/1 -> 20/1 -> 200/1..... fix it

