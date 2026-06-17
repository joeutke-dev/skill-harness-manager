// Minimal ambient declaration for the slice of Electron's renderer API this
// plugin uses. Electron is provided by the Obsidian desktop runtime and kept
// external by esbuild, so we only need types — not the full `@types/electron`.
declare module "electron" {
  export const shell: {
    /** Opens a file/folder in the OS default app. Resolves to "" on success
     * or an error message string on failure. */
    openPath(path: string): Promise<string>;
  };
}
