# workdog-archive API Contract v1 (R0 Baseline)

Base URL: `http://168.107.14.124:3030`
Content-Type: `application/json` (except multipart upload)

## Folders

### GET /api/folders
- 200: `Folder[]`

### GET /api/folders/:id
- 200: `Folder`
- 404: `{ "error": "folder not found" }`

### POST /api/folders
Request:
```json
{ "name": "필수", "description": "선택", "color": "선택(#hex)" }
```
- 201: `Folder`
- 400: `{ "error": "name is required" }`

### PUT /api/folders/:id
Request (partial update):
```json
{ "name": "선택", "description": "선택", "color": "선택" }
```
- 200: updated `Folder`
- 404: `{ "error": "folder not found" }`

### DELETE /api/folders/:id
- 200: `{ "deletedId": "..." }`
- 404: `{ "error": "folder not found" }`
- Note: 해당 폴더의 문서 메타/파일도 함께 삭제

---

## Documents

### GET /api/folders/:id/documents
- 200: `Document[]` (업로드일 내림차순)
- 404: `{ "error": "folder not found" }`

### GET /api/documents/:docId
- 200: `Document`
- 404: `{ "error": "document not found" }`

### PATCH /api/documents/:docId
Request (partial):
```json
{ "memo": "선택", "isImportant": true }
```
- 200: updated `Document`
- 404: `{ "error": "document not found" }`

### DELETE /api/folders/:folderId/documents/:docId
- 200: `{ "deletedId": "..." }`
- 404: `{ "error": "folder not found" | "document not found" }`

### POST /api/folders/:folderId/documents/bulk-delete
Request:
```json
{ "ids": ["doc-id-1", "doc-id-2"] }
```
- 200:
```json
{ "deletedIds": [], "requestedCount": 0, "deletedCount": 0 }
```
- 400: `{ "error": "ids is required" }`
- 404: `{ "error": "folder not found" }`

### POST /api/folders/:id/documents
- multipart/form-data
  - `file` (required)
  - `title` (optional)
- 허용 확장자: `hwp, pdf, xlsx, xls, txt`
- 파일 제한: 30MB
- 201: 최종 `Document` (추출+요약 처리 반영)
- 400: `{ "error": "upload failed" | "unsupported file type" | "file is required" }`
- 404: `{ "error": "folder not found" }`

---

## Static
- `GET /uploads/:storedName` : 업로드 파일 접근
- `GET *` : SPA index.html 반환

---

## Object Shapes

### Folder
```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "color": "#hex",
  "createdAt": "ISO datetime"
}
```

### Document
```json
{
  "id": "uuid",
  "folderId": "uuid",
  "title": "string",
  "fileName": "string",
  "storedName": "string",
  "fileType": "hwp|pdf|xlsx|xls|txt",
  "size": 0,
  "uploadedAt": "ISO datetime",
  "status": "UPLOADED|EXTRACTED|EXTRACT_FAILED",
  "extractedText": "string",
  "extractStatus": "success|failed",
  "extractError": "string",
  "extractMethod": "hwp5txt|hwp.js|strings-fallback|txt-utf8|pdf-parse|xlsx",
  "summaryOneLine": "string",
  "keyPoints": ["string"],
  "category": "string",
  "tags": ["string"],
  "aiStatus": "pending|success|failed",
  "aiError": "string",
  "memo": "string",
  "isImportant": false
}
```
