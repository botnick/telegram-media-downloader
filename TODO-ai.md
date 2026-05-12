# AI Improvements — TODO

## High priority (low effort, high value)

- [ ] **Image-to-image "Find similar"** — Click a button on a photo in the viewer
      to show visually similar photos via CLIP vector cosine similarity.
      *(Implemented: `/api/ai/similar/:downloadId`, "Find similar" button in
      photo modal, results rendered in the existing search results grid.)*

- [ ] **Tag → search** — Click a tag in the cloud on the AI maintenance page
      and immediately show all photos with that tag via a direct tag lookup.
      *(Implemented: tag chips now trigger `runSearch()` immediately, backend
      `_tagSearch()` routes exact matches to the tag index before CLIP.)*

- [ ] **Batch actions on search results** — Add checkboxes to search/CLI
      results for batch delete, batch download, or batch re-tag.
      *(Implemented: Frontend UI for batch selection and action buttons in ai-search.js and index.html.)*

- [ ] **Face gallery → person photos** — Click a person tile in the AI page
      to see every full photo that person appears in, with a Back button.
      *(Implemented: person tiles now open an inline photo grid fetched from
      `/api/ai/people/:id/photos`, with face count per photo.)*

- [ ] **Search by file metadata** — Combine CLIP text search with filters:
      `group:"X POSES"`, `date:>2025-01-01`, `type:video`.
      *(Implemented: Backend API in src/web/routes/ai.js, src/core/ai/manager.js, src/core/ai/vector-store.js, and src/core/db.js updated to accept and process metadata filters; Frontend UI elements and integration in src/web/public/index.html and src/web/public/js/ai-search.js completed.)*

## Medium effort (new models)

- [ ] **OCR for screenshots/memes** — `Xenova/trocr-small-printed` (~60 MB)
      extracts on-screen text from images → searchable. Store in `image_ocr`.
      *(Implemented: OCR capability added to AI pipeline, including database schema for image_ocr, OCR model integration, and search integration.)*

- [ ] **Video keyframe indexing** — Extract frames with ffmpeg (already a dep)
      at N-second intervals, run existing embedding/face/tag pipeline on them.
      *(Implemented: Added new DB tables for video keyframes and their AI data. Implemented core logic in `src/core/video-indexer.js` to extract frames using FFmpeg and process them with AI capabilities. Created a CLI script `scripts/video-ai-indexer.js` to trigger the process.)*

## Polish

- [ ] **Dedup merge workflow** — "Keep best, delete rest" one-click action
      for near-duplicate groups found by pHash.
      *(Implemented: Frontend UI in `src/web/public/js/maintenance-ai.js` to select a photo to keep and trigger merge. Backend API `DELETE /api/ai/perceptual-dedup/merge` in `src/web/routes/ai.js` with logic in `src/core/ai/manager.js` to delete files from disk and records from DB.)*

- [ ] **Batch rename/merge people** — Select multiple people clusters and
      merge or rename them together.
      *(Implemented: Frontend UI in `src/web/public/js/maintenance-ai.js` for multi-selection of people tiles with checkboxes, and "Merge Selected" and "Rename Selected" buttons. Backend API `PUT /api/ai/people/merge` and `PUT /api/ai/people/batch-rename` in `src/web/routes/ai.js` with corresponding logic in `src/core/ai/manager.js` to handle reassigning faces and updating names.)*
