import { AsyncLocalStorage } from "node:async_hooks";

// src/media/admin-preview-context.ts
const preview = new AsyncLocalStorage();
const isAdminSpeechPreview = () => preview.getStore() === true;
const withAdminSpeechPreview = (run) => preview.run(true, run);
const withAdminMediaPreview = withAdminSpeechPreview;

export { isAdminSpeechPreview, withAdminMediaPreview, withAdminSpeechPreview };