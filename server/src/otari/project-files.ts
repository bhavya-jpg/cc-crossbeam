/**
 * Prepares a project's files for the extractor: downloads them, unpacks the page
 * archive from extract.ts, and turns images into data URLs for vision calls.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_EDGE_PX = 1568;
const MAX_RAW_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ProjectFileRecord {
  filename: string;
  storage_path: string;
  file_type: string;
}

export interface PageImage {
  page: number;
  path: string;
}

export interface PreparedProject {
  pages: PageImage[];
  correctionImages: string[];
  correctionText: string;
  warnings: string[];
  cleanup(): void;
}

const isImage = (name: string) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
const isCorrectionFile = (file: ProjectFileRecord) =>
  file.file_type === 'corrections-letter' || /correction/i.test(file.filename);

async function readCorrectionPdf(pdfPath: string, workDir: string): Promise<{ text: string; images: string[] }> {
  let text = '';
  const images: string[] = [];
  try {
    const { stdout } = await run('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 20 * 1024 * 1024 });
    text = stdout;
  } catch {
    // Scanned letters have no text layer, and pdftotext may not be installed locally.
  }
  try {
    const prefix = path.join(workDir, `letter-${path.basename(pdfPath, '.pdf')}`);
    await run('pdftoppm', ['-png', '-r', '120', pdfPath, prefix]);
    for (const name of fs.readdirSync(workDir).sort()) {
      const full = path.join(workDir, name);
      if (full.startsWith(prefix) && name.endsWith('.png')) images.push(full);
    }
  } catch {
    // Handled by the caller, which reports a letter with neither text nor images.
  }
  return { text, images };
}

export async function prepareProjectFiles(
  files: ProjectFileRecord[],
  download: (storagePath: string) => Promise<Buffer>,
): Promise<PreparedProject> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-otari-'));
  const prepared: PreparedProject = {
    pages: [],
    correctionImages: [],
    correctionText: '',
    warnings: [],
    cleanup: () => fs.rmSync(workDir, { recursive: true, force: true }),
  };

  try {
    let downloaded = 0;
    const pageImagePaths: string[] = [];

    for (const file of files) {
      // Title blocks are only a crop of the pages, so the extractor doesn't use them.
      if (file.filename === 'title-blocks.tar.gz') continue;

      // basename: filenames come from a database row, not from this server.
      const localPath = path.join(workDir, path.basename(file.filename));
      try {
        fs.writeFileSync(localPath, await download(file.storage_path));
        downloaded += 1;
      } catch (error) {
        prepared.warnings.push(`Could not download ${file.filename}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (file.filename.endsWith('.tar.gz')) {
        await run('tar', ['xzf', localPath, '-C', workDir]);
      } else if (isCorrectionFile(file)) {
        if (isImage(file.filename)) {
          prepared.correctionImages.push(localPath);
        } else if (file.filename.toLowerCase().endsWith('.pdf')) {
          const { text, images } = await readCorrectionPdf(localPath, workDir);
          prepared.correctionText += text;
          prepared.correctionImages.push(...images);
          if (!text && images.length === 0) {
            prepared.warnings.push(`Could not read ${file.filename}: poppler-utils is required for PDF corrections letters.`);
          }
        } else {
          prepared.correctionText += fs.readFileSync(localPath, 'utf-8');
        }
      } else if (file.file_type === 'plan-binder' && isImage(file.filename)) {
        pageImagePaths.push(localPath);
      }
    }

    if (downloaded === 0 && files.length > 0) {
      throw new Error('Failed to download any project files');
    }

    const pagesDir = path.join(workDir, 'pages-png');
    if (fs.existsSync(pagesDir)) {
      pageImagePaths.push(...fs.readdirSync(pagesDir).filter(isImage).sort().map((name) => path.join(pagesDir, name)));
    }
    prepared.pages = pageImagePaths.map((filePath, index) => {
      const numbered = path.basename(filePath).match(/(\d+)\.[a-z]+$/i);
      return { page: numbered ? Number(numbered[1]) : index + 1, path: filePath };
    });

    return prepared;
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

async function shrinkImage(imagePath: string): Promise<Buffer | null> {
  const args = [imagePath, '-resize', `${MAX_EDGE_PX}x${MAX_EDGE_PX}>`, '-quality', '85', 'jpeg:-'];
  for (const command of ['magick', 'convert']) {
    try {
      const { stdout } = await run(command, args, { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 });
      return stdout;
    } catch {
      // Try the next ImageMagick command name.
    }
  }
  return null;
}

/** Downscales to keep vision requests small; falls back to the original without ImageMagick. */
export async function imageToDataUrl(imagePath: string): Promise<string> {
  const shrunk = await shrinkImage(imagePath);
  if (shrunk) return `data:image/jpeg;base64,${shrunk.toString('base64')}`;

  const original = fs.readFileSync(imagePath);
  if (original.length > MAX_RAW_IMAGE_BYTES) {
    throw new Error(`${path.basename(imagePath)} is too large to send without ImageMagick`);
  }
  const extension = path.extname(imagePath).slice(1).toLowerCase();
  return `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${original.toString('base64')}`;
}
