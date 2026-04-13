import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { getCTXRoot, getAllowedRootsConfigPath } from '@/lib/config';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Allowed roots — controls which directories the media API can serve from.
//
// CTX_ROOT is always implicitly allowed. Additional directories can be added
// via Settings > Allowed Roots so agents can reference files from project
// trees outside the default runtime directory. The list is stored in
// {CTX_ROOT}/config/allowed-roots.json and read on every request.
// ---------------------------------------------------------------------------

interface AllowedRootsFile {
  additional_roots?: string[];
}

function readAllowedRoots(): string[] {
  const configPath = getAllowedRootsConfigPath();
  if (!fs.existsSync(configPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AllowedRootsFile;
    if (!Array.isArray(parsed.additional_roots)) return [];
    return parsed.additional_roots.filter((r): r is string => typeof r === 'string');
  } catch {
    return [];
  }
}

function isPathUnderAnyRoot(realPath: string, roots: string[]): boolean {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    if (realPath === realRoot) return true;
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realPath.startsWith(rootWithSep)) return true;
  }
  return false;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);
const INLINE_EXTENSIONS = new Set(['.md', '.html', '.htm', '.txt', '.ts', '.tsx', '.js', '.css', '.sh', '.json', '.csv']);

/**
 * GET /api/media/[...filepath]
 * Serve a local file by its path relative to CTX_ROOT (or an absolute path
 * if it falls within an allowed root). Supports ?render=true for markdown
 * files to return rendered HTML instead of raw text.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filepath: string[] }> }
) {
  const { filepath } = await params;
  const ctxRoot = getCTXRoot();

  // Reconstruct the path. Absolute paths (C:/...) stay absolute via path.resolve.
  const relativePath = filepath.join('/');
  const fullPath = path.resolve(ctxRoot, relativePath);

  // Security: resolve symlinks to prevent escape
  let realFullPath: string;
  try {
    realFullPath = fs.realpathSync(fullPath);
  } catch {
    return new Response('Not found', { status: 404 });
  }

  // Check against CTX_ROOT plus any additional allowed roots
  const additionalRoots = readAllowedRoots();
  const validRoots = [ctxRoot, ...additionalRoots];
  if (!isPathUnderAnyRoot(realFullPath, validRoots)) {
    return new Response(
      JSON.stringify({
        error: 'outside_allowed_roots',
        path: realFullPath,
        message: 'This file is outside your configured allowed roots. Add the parent directory in Settings > Allowed Roots, or re-attach as a snapshot via save-output.',
        configured_roots: validRoots,
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (!fs.existsSync(realFullPath)) {
    return new Response('Not found', { status: 404 });
  }

  const ext = path.extname(realFullPath).toLowerCase();
  const renderMd = _request.nextUrl.searchParams.get('render') === 'true';

  // Markdown render mode: convert to HTML fragment for the preview panel
  if (renderMd && ext === '.md') {
    const mdContent = fs.readFileSync(realFullPath, 'utf-8');
    const htmlBody = marked.parse(mdContent) as string;
    return new Response(htmlBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(htmlBody)),
        'Cache-Control': 'private, max-age=60',
      },
    });
  }

  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const fileBuffer = fs.readFileSync(realFullPath);

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Content-Length': String(fileBuffer.length),
    'Cache-Control': 'private, max-age=3600',
  };

  if (IMAGE_EXTENSIONS.has(ext) || INLINE_EXTENSIONS.has(ext)) {
    headers['Content-Disposition'] = `inline; filename="${path.basename(realFullPath)}"`;
  } else {
    headers['Content-Disposition'] = `attachment; filename="${path.basename(realFullPath)}"`;
  }

  return new Response(fileBuffer, { status: 200, headers });
}
