// Markdown files imported as strings via esbuild's `text` loader (bundled skills).
declare module "*.md" {
  const content: string;
  export default content;
}
