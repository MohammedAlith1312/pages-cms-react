# GitHub Pages Editor (React + Express)

A lightweight GitHub content editor built with **React** and **Express** that allows users to browse repositories, create files, upload files, edit Markdown using the Pages CMS editor, and save changes directly to GitHub.

> **Goal**
>
> Build a standalone React application that provides the Pages CMS editing experience without using Next.js.

---

# Architecture

```text
                     React UI
                         │
 ┌───────────────────────┼────────────────────────┐
 │                       │                        │
 ▼                       ▼                        ▼
Authentication      Repository Browser      File Explorer
                                                 │
                     ┌───────────────────────────┴─────────────────────────┐
                     │                                                     │
                     ▼                                                     ▼
              Create File                                            Upload File
                     │                                                     │
                     └───────────────────────┬─────────────────────────────┘
                                             │
                                             ▼
                                   Load Markdown File
                                             │
                                             ▼
                                  Pages CMS Editor
                                             │
                                             ▼
                                   Save / Commit Changes
                                             │
                                             ▼
                                      Express Backend
                                             │
                                             ▼
                                      GitHub REST API
```

---

# Technology Stack

## Frontend

- React
- React Router
- Tailwind CSS
- Axios
- Pages CMS Editor Components
- React Query (Optional)

## Backend

- Node.js
- Express
- Octokit
- GitHub OAuth / PAT
- dotenv

---

# Project Structure

```text
github-pages-editor/

api/
│
├── src/
│   ├── controllers/
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   ├── config/
│   ├── app.ts
│   └── server.ts
│
├── package.json
└── tsconfig.json

ui/
│
├── src/
│
├── components/
│   ├── Login
│   ├── RepositoryList
│   ├── FileTree
│   ├── Header
│   ├── Toolbar
│   ├── PagesEditor
│   ├── UploadDialog
│   ├── CreateFileDialog
│   └── Preview
│
├── pages/
│   ├── Login.tsx
│   └── Dashboard.tsx
│
├── services/
│
├── hooks/
│
├── context/
│
└── App.tsx
```

---

# Application Flow

```text
Login

↓

Select Repository

↓

Load Repository Tree

↓

Select File

↓

Download Markdown

↓

Open Pages CMS Editor

↓

User Edits

↓

Save

↓

Commit to GitHub
```

---

# Features

## Authentication

Support

- GitHub OAuth
- GitHub Personal Access Token

After authentication

Store

```
Access Token
```

inside

```
localStorage
```

or

```
sessionStorage
```

---

# Repository Browser

Load all repositories

```
GET /user/repos
```

Display

```
Repository A

Repository B

Repository C
```

---

# Branch Selection

Allow user to select

```
main

develop

feature/*
```

---

# File Explorer

Load

```
GET /repos/{owner}/{repo}/contents
```

Display

```text
docs
    intro.md

    api.md

README.md

package.json
```

Filter supported files

```
.md

.mdx

.json

.yml

.yaml
```

---

# Create File

User clicks

```
New File
```

Popup

```
docs/new-page.md
```

Editor opens with empty content

```
# New Page
```

On save

```
PUT /contents
```

without SHA

GitHub creates file.

---

# Upload File

User selects

```
about.md
```

or

```
config.json
```

Upload

```
GitHub

↓

Refresh Repository Tree
```

---

# Open Existing File

Click

```
README.md
```

Backend

```
GET contents
```

Receive

```
Base64

SHA
```

Decode

```
Markdown
```

Open inside

```
Pages CMS Editor
```

---

# Pages CMS Editor

Editor receives

```
Markdown String
```

Example

```md
# Welcome

This is documentation.

## Installation

npm install

- Item One
- Item Two
```

Editor displays

```
Heading

Paragraph

Lists

Images

Tables

Links

Code Blocks
```

After editing

Returns

```
Markdown String
```

---

# Save Changes

Editor

↓

Markdown

↓

Base64 Encode

↓

PUT

```
/repos/{owner}/{repo}/contents/{path}
```

Request

```json
{
    "message":"Update page",
    "content":"BASE64",
    "sha":"CURRENT_FILE_SHA"
}
```

GitHub creates commit.

---

# Delete File

User

```
Delete
```

Backend

```
DELETE contents
```

GitHub removes file.

---

# Rename File

GitHub has no rename endpoint.

Rename process

```
Read old file

↓

Create new file

↓

Delete old file
```

---

# Backend APIs

## Authentication

```
POST /auth/login
```

---

## Repository

```
GET /repos

GET /branches

GET /tree
```

---

## File

```
GET /file

POST /file

PUT /file

DELETE /file

POST /upload

POST /rename
```

---

# React Components

## Login

Responsible for

- OAuth
- PAT Login

---

## Repository List

Responsible for

- List repositories
- Search repositories

---

## File Tree

Responsible for

- Expand folders
- Collapse folders
- Refresh tree

---

## Pages Editor

Responsible for

- Markdown editing
- Rich formatting
- Returning Markdown

---

## Toolbar

Contains

```
Save

Undo

Redo

Preview

Upload

Create File

Delete

Rename

Download
```

---

# Backend Services

GitHub Service

Responsible for

- Authenticate
- Repository List
- Read File
- Save File
- Create File
- Upload File
- Delete File
- Rename File

---

# GitHub REST APIs

## List Repositories

```
GET /user/repos
```

---

## Repository Tree

```
GET /repos/{owner}/{repo}/contents/{path}
```

---

## Read File

```
GET /repos/{owner}/{repo}/contents/{path}
```

---

## Create File

```
PUT /repos/{owner}/{repo}/contents/{path}
```

without

```
sha
```

---

## Update File

```
PUT /repos/{owner}/{repo}/contents/{path}
```

with

```
sha
```

---

## Delete File

```
DELETE /repos/{owner}/{repo}/contents/{path}
```

---

# Complete Workflow

```text
Login
    │
    ▼
Authenticate GitHub
    │
    ▼
Load Repositories
    │
    ▼
Choose Repository
    │
    ▼
Load Repository Tree
    │
    ▼
Choose Markdown File
    │
    ▼
Download File
    │
    ▼
Decode Base64
    │
    ▼
Pages CMS Editor
    │
    ▼
User Edit
    │
    ▼
Convert Markdown
    │
    ▼
Base64 Encode
    │
    ▼
GitHub Commit
    │
    ▼
Repository Updated
```

---

# Future Enhancements

- Search files
- Markdown Preview
- Drag & Drop Upload
- Image Upload
- Folder Creation
- Multiple File Tabs
- Auto Save
- Commit History
- Branch Switching
- Dark / Light Theme
- Keyboard Shortcuts
- Unsaved Changes Warning
- Diff Viewer
- Pull Request Creation

---

# Final Result

The application provides:

- GitHub OAuth / PAT authentication
- Repository browser
- Folder explorer
- Create new files
- Upload existing files
- Open Markdown and JSON files
- Edit Markdown using the Pages CMS editor
- Save changes directly to GitHub
- Delete files
- Rename files
- Commit all changes through the GitHub REST API

This architecture is completely independent of Next.js and can be implemented using React for the frontend and Express for the backend.