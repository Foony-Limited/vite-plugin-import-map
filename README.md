# vite-plugin-import-map

A Vite plugin that generates import maps to prevent cascading hash changes in production builds.

Created by [foony.com](https://foony.com) - Play free online games.

## Problem

When using content-based hashing for production builds, changing a single file can cause many other files to get new hashes, even though their actual content hasn't changed. This happens because files import each other using hashed filenames like `./button-abc12345.js`. When `button.tsx` changes and becomes `button-def45678.js`, all files that import it also change because they contain the old filename string.

This cascading effect causes:
- Unnecessary cache invalidation
- Difficulty tracking what actually changed between builds
- Build failures when hitting file limits (e.g., Cloudflare Pages' 20,000 file limit)

## Solution

This plugin uses [Import Maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to decouple module specifiers from file paths. Instead of importing `"./button-abc123.js"`, files import `"button"`. The browser uses the import map to resolve `"button"` to the actual hashed filename.

This means:
- File content stays identical (always imports `"button"`), so hashes stay the same
- Only the import map and changed files get new hashes
- No cascading hash changes

For a detailed explanation of the problem and solution, see [How I Solved Cascading Hash Changes with Import Maps](https://foony.com/posts/how-i-solved-cascading-hash-changes-with-import-maps).

## Installation

```bash
npm install @foony/vite-plugin-import-map
```

## Usage

```typescript
import { defineConfig } from 'vite';
import importMapPlugin from '@foony/vite-plugin-import-map';

export default defineConfig({
  plugins: [
    importMapPlugin({
      assetsDir: 'assets', // optional, defaults to 'assets'
      useAbsolutePaths: true, // optional, defaults to true
    }),
  ],
});
```

## Configuration

### `assetsDir?: string`

The directory where assets are stored. Defaults to `'assets'`. If not provided, the plugin will read this from Vite's `build.assetsDir` configuration.

### `useAbsolutePaths?: boolean`

Whether to use absolute paths (starting with `/`) or relative paths (starting with `./`) in the import map. 

- `true` (default): Absolute paths like `/assets/index-abc123.js`. Required for SSG where HTML files are served from subdirectories.
- `false`: Relative paths like `./assets/index-abc123.js`. Preferred for HTML5 builds that may not be served from root.

## Browser Support

Import Maps are natively supported in modern browsers. See [caniuse.com for Import Maps support](https://caniuse.com/import-maps).

**Safari < 16.4 Support:**

If you need to support Safari versions before 16.4, you'll need to use [es-module-shims](https://github.com/guybedford/es-module-shims) as a polyfill. Add it to your HTML before the import map:

```html
<script async src="https://ga.jspm.io/npm:es-module-shims@1/dist/es-module-shims.js"></script>
```

The `es-module-shims` polyfill automatically detects and polyfills import maps in browsers that don't have native support.

## How It Works

1. **First pass**: Counts base names to detect conflicts (multiple chunks with the same name)
2. **Second pass**: Builds a mapping from hashed filenames to stable module specifiers
3. **Third pass**: Transforms all import statements in chunk code to use stable specifiers, then recomputes hashes
4. **Fourth pass**: Renames files with new hashes and updates the import map
5. **HTML injection**: Injects the import map as a `<script type="importmap">` tag in the HTML head

The plugin uses AST parsing (via Acorn) to safely transform only actual import statements, avoiding false positives from strings that happen to look like filenames.

## License

MIT

---

Created by [foony.com](https://foony.com) - Play free online games.
