// Ambient module declarations for dependencies without shipped type definitions.
// Used only by the typecheck config; bun's runtime resolution handles these fine.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export { getDocument } from 'pdfjs-dist';
}
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
declare module 'bash-parser';
