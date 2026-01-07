import {createHash as cryptoCreateHash} from 'crypto';
import MagicString from 'magic-string';
import {ExportAllDeclaration, ExportNamedDeclaration, ImportDeclaration, ImportExpression, Parser} from 'acorn';
import {simple as walk} from 'acorn-walk';
import type {OutputBundle} from 'rollup';
import type {Plugin} from 'vite';

export interface ImportMapPluginOptions {
  assetsDir?: string;
  useAbsolutePaths?: boolean;
}

function computeHash(input: string): string {
  return cryptoCreateHash('sha256')
    .update(input, 'utf8')
    .digest('base64url') // Native in Node 14+
    .slice(0, 8);
}

/**
 * Generates import maps to prevent cascading hash changes.
 * When chunk B changes, chunk A's hash doesn't change because A imports "chunk-b" (stable name)
 * instead of "./chunk-b-HASH.js" (hashed filename).
 */
export default function importMapPlugin(options?: ImportMapPluginOptions): Plugin {
  const assetsDir = options?.assetsDir ?? 'assets';
  const useAbsolutePaths = options?.useAbsolutePaths ?? true; // Default to true for SSG compatibility
  const chunkMapping = new Map<string, string>(); // hashedFilename → moduleSpec
  const baseNameCounts = new Map<string, number>(); // baseName → count (for conflict detection)
  const importMap: {imports: Record<string, string>; scopes?: Record<string, Record<string, string>>} = {
    imports: {},
  };
  
  let resolvedAssetsDir = assetsDir;
  
  return {
    name: 'import-map',
    configResolved(config) {
      // Read assetsDir from Vite config if not explicitly provided
      if (!options?.assetsDir && config.build?.assetsDir) {
        resolvedAssetsDir = config.build.assetsDir;
      }
    },
    generateBundle(_options, bundle: OutputBundle) {
      const start = performance.now();
      console.log('Starting import map generation...');
      // First pass: count base names to detect conflicts
      const bundleEntries = Object.entries(bundle);
      for (const [fileName, chunk] of bundleEntries) {
        if (chunk.type !== 'chunk' || !fileName.endsWith('.js')) {
          continue;
        }
        baseNameCounts.set(chunk.name, (baseNameCounts.get(chunk.name) || 0) + 1);
      }
      
      // Second pass: build mapping and import map, then transform chunk code
      for (const [fileName, chunk] of bundleEntries) {
        if (chunk.type !== 'chunk' || !fileName.endsWith('.js')) {
          continue;
        }
        
        // If there's a conflict (multiple files with same base name), hash the original source path
        const baseName = chunk.name;
        const count = baseNameCounts.get(baseName) || 0;

        // Get original source path from chunk for deterministic hashing
        // Prefer facadeModuleId (entry point) as it's the most stable identifier
        // Fall back to moduleIds[0] (first module) which is more reliable than Object.keys(chunk.modules)[0]
        let sourcePath = '';
        if (chunk.facadeModuleId) {
          sourcePath = chunk.facadeModuleId;
        } else if (chunk.moduleIds && chunk.moduleIds.length > 0) {
          sourcePath = chunk.moduleIds[0];
        } else if (chunk.modules) {
          const moduleKeys = Object.keys(chunk.modules);
          if (moduleKeys.length > 0) {
            sourcePath = moduleKeys[0];
          }
        }
        
        // Use source path + baseName for consistent hashing across builds
        const hashInput = sourcePath ? `${sourcePath}:${baseName}` : baseName;
        const moduleSpec = count > 1 ? `${baseName}-${computeHash(hashInput)}` : baseName;
        
        // Extract filename-only for mapping (chunks import using just filename like "index-CWucgakM.js")
        const filenameOnly = fileName.includes('/') ? fileName.split('/').pop()! : fileName;
        
        // Map full path, filename-only, and baseName for lookup
        chunkMapping.set(fileName, moduleSpec);
        chunkMapping.set(filenameOnly, moduleSpec);
        chunkMapping.set(baseName, moduleSpec);
        
        // Use imports map with paths from document root
        // Map module specifier to path (use filenameOnly, not baseName)
        // Absolute paths are required for SSG where HTML files are served from subdirectories
        // Relative paths are preferred for HTML5 builds that may not be served from root
        const pathPrefix = useAbsolutePaths ? '/' : './';
        importMap.imports[moduleSpec] = `${pathPrefix}${resolvedAssetsDir}/${filenameOnly}`;
      }
      
      // Third pass: transform imports and recompute hashes
      // Transform ALL files in the bundle, using the original filenames from chunkMapping
      const fileRenames = new Map<string, string>(); // oldFileName → newFileName
      
      for (const [fileName, chunk] of bundleEntries) {
        if (chunk.type !== 'chunk' || !chunk.code || !fileName.endsWith('.js')) continue;
        
        let transformed = false;
        const magicString = new MagicString(chunk.code);
        
        // Use Acorn to safely extract import statements
        // Acorn is faster and lighter than Babel, and avoids the native panic issues with es-module-lexer
        try {
          // Parse the code to get an AST
          const ast = Parser.parse(chunk.code, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: true, // Enable location tracking for accurate replacements
          });
          
          // Traverse the AST to find import statements
          const importsToTransform: Array<{start: number; end: number; replacement: string}> = [];
          
          const handleImportSource = (node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration | ImportExpression, importType: string) => {
            const source = (node as ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration).source;
            if (!source) {
              return;
            }
            const specifier = source.value;
            if (!specifier || typeof specifier !== 'string') {
              return;
            }
            
            const isRelative = specifier.startsWith('./');
            const isAbsolute = specifier.startsWith(`/${resolvedAssetsDir}/`);
            const isAbsoluteWithDot = specifier.startsWith(`./${resolvedAssetsDir}/`);
            if (!isRelative && !isAbsolute && !isAbsoluteWithDot) return;
            
            const filename = specifier.split('/').pop()!;
            const moduleSpec = chunkMapping.get(filename);
            if (!moduleSpec) {
              if (filename.includes('-') && filename.endsWith('.js')) {
                console.warn(`[import-map] No module spec found for ${importType} import: ${filename} in ${fileName}`);
              }
              return;
            }
            if (source.start === undefined || source.end === undefined) return;
            
            importsToTransform.push({
              start: source.start + 1,
              end: source.end - 1,
              replacement: moduleSpec,
            });
          };
          
          // Use acorn-walk to traverse the AST
          walk(ast, {
            ImportDeclaration: (node: ImportDeclaration) => handleImportSource(node, 'static'),
            ExportNamedDeclaration: (node: ExportNamedDeclaration) => handleImportSource(node, 'named export'),
            ExportAllDeclaration: (node: ExportAllDeclaration) => handleImportSource(node, 'export all'),
            ImportExpression(node: ImportExpression) {
              if (node.source?.type !== 'Literal') return;
              handleImportSource(node, 'dynamic');
            },
          });
          
          // Apply transformations in reverse order to preserve positions
          importsToTransform.sort((a, b) => b.start - a.start);
          for (const transform of importsToTransform) {
            magicString.overwrite(transform.start, transform.end, transform.replacement);
            transformed = true;
          }
        } catch (error) {
          throw new Error(`Error parsing code: ${error}`);
        }
        
        if (!transformed) continue;
        
        const transformedCode = magicString.toString();
        
        // Strip source map comments for hash calculation (they reference old filenames)
        const codeWithoutSourceMaps = transformedCode.replace(/\/\/# sourceMappingURL=.*$/gm, '');
        
        // Recompute hash from transformed content (excluding source maps)
        const newHash = computeHash(codeWithoutSourceMaps);
        const filenameOnly = fileName.includes('/') ? fileName.split('/').pop()! : fileName;
        const baseName = chunk.name;
        const newFileName = baseName ? `${baseName}-${newHash}.js` : filenameOnly;
        const newFilePath = fileName.includes('/') 
          ? fileName.split('/').slice(0, -1).join('/') + '/' + newFileName
          : newFileName;
        
        // Update source map comment to point to new filename (if present)
        let finalCode = transformedCode;
        if (chunk.map) {
          // Update the comment
          finalCode = transformedCode.replace(
            /(\/\/# sourceMappingURL=)([^\s]+)(\.map)/, 
            `$1${newFileName}.map`
          );
          
          // Generate new map from our transformations
          // MagicString's generateMap already accounts for our transformations
          // We just need to preserve the original source information from the existing map
          try {
            const existingMap = typeof chunk.map === 'string' ? JSON.parse(chunk.map) : chunk.map;
            const newMap = magicString.generateMap({
              source: fileName,
              file: newFileName,
              includeContent: true,
              hires: true,
            });
            
            // Merge: use new map's mappings (which account for our transformations)
            // but preserve existing map's sources and sourcesContent (original source files)
            // This maintains the chain: Original Source -> (existing map) -> Transformed Code
            chunk.map = {
              ...newMap,
              sources: existingMap.sources || newMap.sources,
              sourcesContent: existingMap.sourcesContent || newMap.sourcesContent,
              file: newFileName,
            } as any;
          } catch (e) {
            console.warn(`[import-map] Failed to generate source map for ${fileName}:`, e);
          }
        }

        chunk.code = finalCode;  
        fileRenames.set(fileName, newFilePath);
      }
      
      // Fourth pass: rename files and update import map
      for (const [oldFileName, newFileName] of Array.from(fileRenames.entries())) {
        const chunk = bundle[oldFileName];
        if (chunk?.type !== 'chunk') continue;
        
        // Update the chunk's fileName property so Vite uses the new name
        chunk.fileName = newFileName;
        
        // Move chunk to new filename in bundle
        delete bundle[oldFileName];
        bundle[newFileName] = chunk;
        
        // Update import map with new filename
        const filenameOnly = oldFileName.includes('/') ? oldFileName.split('/').pop()! : oldFileName;
        const moduleSpec = chunkMapping.get(filenameOnly);
        if (!moduleSpec) continue;
        
        const newFilenameOnly = newFileName.includes('/') ? newFileName.split('/').pop()! : newFileName;
        const pathPrefix = useAbsolutePaths ? '/' : './';
        importMap.imports[moduleSpec] = `${pathPrefix}${resolvedAssetsDir}/${newFilenameOnly}`;
        
        // Update mapping to use new filename (keep old filename mapping for reverse lookups)
        chunkMapping.set(newFileName, moduleSpec);
        chunkMapping.set(newFilenameOnly, moduleSpec);
        chunkMapping.set(filenameOnly, moduleSpec); // Keep old filename for reverse lookups
      }
      const end = performance.now();
      console.log(`Import map generation completed in ${end - start} ms`);
    },
    transformIndexHtml() {
      // Sort import map entries for consistency
      if (importMap.imports) {
        const sortedImports: Record<string, string> = {};
        const entries = Object.entries(importMap.imports).sort(([a], [b]) => a.localeCompare(b));
        for (const [key, value] of entries) {
          sortedImports[key] = value;
        }
        importMap.imports = sortedImports;
      }
      
      // Use Vite's tag injection API instead of regex manipulation
      return {
        tags: [
          {
            tag: 'script',
            attrs: {type: 'importmap'},
            children: JSON.stringify(importMap, null, 2),
            injectTo: 'head-prepend', // Inject at the beginning of <head> (before other scripts)
          },
        ],
      } as any;
    },
  };
}
